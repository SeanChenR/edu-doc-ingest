import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';
import type { DocumentRow, JobRow } from '@/shared/db/rows';
import { ErrorCode } from '@/shared/errors/codes';
import { WorkerError } from '@/shared/errors/worker-error';
import { newId } from '@/shared/ids';
import { CHUNKER, type ChunkerPort } from '@/shared/ports/chunker.port';
import { EMBEDDING, type EmbeddingPort } from '@/shared/ports/embedding.port';
import { PARSER, type ParserPort } from '@/shared/ports/parser.port';
import { STORAGE, type StoragePort } from '@/shared/ports/storage.port';
import { JobTransitions, PROGRESS } from '@/worker/job-transitions';
import { hasMarker, MARKERS, SLOW_STAGE_DELAY_MS } from '@/worker/pipeline/failure-injection';

const EMBED_BATCH = 16;

export interface JobContext {
  job: JobRow;
  document: DocumentRow;
  attempt: number;
  // JOB_TIMEOUT_MS 到了會 abort；pipeline 在每個狀態變更前檢查，逾時的 attempt 不再寫任何東西
  signal: AbortSignal;
}

// docs/DESIGN.md §9.3 三個階段的「做什麼」：讀檔、解析、切 chunk、算向量。
// 每個階段都冪等：extracting 靠 documents.extracted_text 的 checkpoint，embedding 從已存在的 chunk 之後接續。
// 長工作在交易外；所有狀態變更交給 JobTransitions（它負責同交易的 jobs / job_events / NOTIFY）。
@Injectable()
export class PipelineService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(PARSER) private readonly parser: ParserPort,
    @Inject(EMBEDDING) private readonly embedding: EmbeddingPort,
    @Inject(CHUNKER) private readonly chunker: ChunkerPort,
    private readonly transitions: JobTransitions,
    private readonly log: PinoLogger,
  ) {
    this.log.setContext(PipelineService.name);
  }

  // 回傳抽取後的文字給 embedding 階段用
  async extract(ctx: JobContext): Promise<string> {
    const { job, document: doc, attempt } = ctx;

    if (doc.extracted_text !== null) {
      // checkpoint：上一次 attempt 已抽取完成，不再讀檔、不再呼叫 parser（不可逆副作用不重複）
      this.log.info({ job_id: job.id, document_id: doc.id }, 'extraction checkpoint reused');
      ctx.signal.throwIfAborted();
      await this.transitions.progress(job, attempt, {
        type: 'progress',
        stage: 'extracting',
        progress: PROGRESS.extracted,
        message: 'extraction checkpoint reused',
      });
      return doc.extracted_text;
    }

    if (this.injecting() && hasMarker(MARKERS.failExtract, doc.name)) {
      throw new WorkerError(
        ErrorCode.EXTRACTION_FAILED,
        'Injected failure: [[FAIL_EXTRACT]] in name.',
      );
    }
    await this.delay(doc);

    let bytes: Uint8Array;
    try {
      bytes = await this.storage.get(doc.storage_key);
    } catch (err) {
      throw new WorkerError(
        ErrorCode.STORAGE_READ_FAILED,
        'Could not read document from storage.',
        {
          cause: err,
        },
      );
    }

    const parsed = await this.parser.parse(bytes, doc.mime_type);
    if (this.injecting() && hasMarker(MARKERS.failExtract, parsed.text)) {
      throw new WorkerError(
        ErrorCode.EXTRACTION_FAILED,
        'Injected failure: [[FAIL_EXTRACT]] in content.',
      );
    }

    ctx.signal.throwIfAborted();
    await this.transitions.extracted(job, attempt, parsed.text, parsed.pageCount);
    this.log.info(
      {
        job_id: job.id,
        document_id: doc.id,
        mime_type: doc.mime_type,
        content_length: parsed.text.length,
      },
      'extracted',
    );
    return parsed.text;
  }

  // 回傳 chunk 總數
  async embed(ctx: JobContext, text: string): Promise<number> {
    const { job, document: doc, attempt } = ctx;

    ctx.signal.throwIfAborted();
    await this.transitions.progress(job, attempt, {
      type: 'stage_changed',
      stage: 'embedding',
      progress: PROGRESS.embedding,
    });

    // D-14：注入判斷在 pipeline 層、呼叫 EmbeddingPort 之前
    if (this.injecting()) {
      const marked = (m: string): boolean => hasMarker(m, doc.name, text);
      if (marked(MARKERS.failEmbed)) {
        throw new WorkerError(
          ErrorCode.EMBEDDING_PROVIDER_ERROR,
          'Injected failure: [[FAIL_EMBED]].',
        );
      }
      if (marked(MARKERS.failEmbedOnce) && attempt === 1) {
        throw new WorkerError(
          ErrorCode.EMBEDDING_PROVIDER_ERROR,
          `Injected failure: [[FAIL_EMBED_ONCE]] on attempt ${attempt}.`,
        );
      }
    }
    await this.delay(doc);

    const all = this.chunker.chunk(text);
    // 重試從已存在的 chunk 之後接續，不重算已付費的向量（D-13）
    const doneUpTo = await this.transitions.resumePoint(job);
    const pending = doneUpTo === null ? all : all.filter((c) => c.index > doneUpTo);

    for (let i = 0; i < pending.length; i += EMBED_BATCH) {
      const batch = pending.slice(i, i + EMBED_BATCH);
      ctx.signal.throwIfAborted();
      const vectors = await this.embedding.embed(batch.map((c) => c.content));
      ctx.signal.throwIfAborted();
      const done = all.length - pending.length + i + batch.length;
      const progress =
        PROGRESS.embedding +
        Math.floor(((PROGRESS.embedded - PROGRESS.embedding) * done) / all.length);
      await this.transitions.chunksStored(
        job,
        attempt,
        batch.map((chunk, k) => ({
          id: newId('chk'),
          document_id: doc.id,
          chunk_index: chunk.index,
          content: chunk.content,
          token_count: chunk.tokenCount,
          embedding: vectors[k] ?? [],
        })),
        done,
        all.length,
        progress,
      );
    }
    return all.length;
  }

  private injecting(): boolean {
    return this.env.FAILURE_INJECTION;
  }

  // §9.3 每階段的人為延遲讓 SSE 看得到進度；[[SLOW]] 拉長到 3 秒
  private async delay(doc: DocumentRow): Promise<void> {
    const ms =
      this.injecting() && hasMarker(MARKERS.slow, doc.name)
        ? SLOW_STAGE_DELAY_MS
        : this.env.STAGE_DELAY_MS;
    if (ms > 0) await Bun.sleep(ms);
  }
}
