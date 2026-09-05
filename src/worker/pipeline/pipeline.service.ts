import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';
import { type Db, withTenant } from '@/shared/db/client';
import { DB } from '@/shared/db/db.module';
import { DocumentChunksRepository } from '@/shared/db/repositories/document-chunks.repository';
import { DocumentsRepository } from '@/shared/db/repositories/documents.repository';
import { JobsRepository } from '@/shared/db/repositories/jobs.repository';
import type { DocumentRow, JobRow } from '@/shared/db/rows';
import { ErrorCode } from '@/shared/errors/codes';
import { WorkerError } from '@/shared/errors/worker-error';
import { newId } from '@/shared/ids';
import { CHUNKER, type ChunkerPort } from '@/shared/ports/chunker.port';
import { EMBEDDING, type EmbeddingPort } from '@/shared/ports/embedding.port';
import { PARSER, type ParserPort } from '@/shared/ports/parser.port';
import { STORAGE, type StoragePort } from '@/shared/ports/storage.port';
import { JobEventsService } from '@/worker/job-events.service';
import { hasMarker, MARKERS, SLOW_STAGE_DELAY_MS } from '@/worker/pipeline/failure-injection';

// §9.3 的進度區間
const PROGRESS = {
  extracting: 10,
  extracted: 40,
  embedding: 40,
  embedded: 90,
  ready: 100,
} as const;
const EMBED_BATCH = 16;

export interface JobContext {
  job: JobRow;
  document: DocumentRow;
  attempt: number;
}

// docs/DESIGN.md §9.3 三個階段，每個都冪等：extracting 靠 documents.extracted_text 的 checkpoint，
// embedding 靠 (document_id, chunk_index) 唯一鍵 upsert 並從已存在的 chunk 之後接續。
// 長工作（讀檔、解析、算向量）都在交易外；每次狀態變更是一個短交易（UPDATE jobs + job_events + NOTIFY）。
@Injectable()
export class PipelineService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(PARSER) private readonly parser: ParserPort,
    @Inject(EMBEDDING) private readonly embedding: EmbeddingPort,
    @Inject(CHUNKER) private readonly chunker: ChunkerPort,
    private readonly documents: DocumentsRepository,
    private readonly jobs: JobsRepository,
    private readonly chunks: DocumentChunksRepository,
    private readonly events: JobEventsService,
    private readonly log: PinoLogger,
  ) {
    // 用 setContext 而不是 @InjectPinoLogger：後者的 token 靠 LoggerModule 建立時的掃描順序決定，太脆弱
    this.log.setContext(PipelineService.name);
  }

  // 回傳抽取後的文字給 embedding 階段用
  async extract(ctx: JobContext): Promise<string> {
    const { job, document: doc, attempt } = ctx;
    const wsId = job.workspace_id;

    if (doc.extracted_text !== null) {
      // checkpoint：上一次 attempt 已抽取完成，不再讀檔、不再呼叫 parser（不可逆副作用不重複）
      this.log.info({ job_id: job.id, document_id: doc.id }, 'extraction checkpoint reused');
      await this.stage(
        wsId,
        job,
        attempt,
        'extracting',
        PROGRESS.extracted,
        'progress',
        'extraction checkpoint reused',
      );
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

    await withTenant(this.db, wsId, async (tx) => {
      await this.documents.setExtracted(wsId, tx, doc.id, parsed.text, parsed.pageCount);
      await this.jobs.setStage(wsId, tx, job.id, 'extracting', PROGRESS.extracted);
      await this.events.emit(wsId, tx, {
        job_id: job.id,
        type: 'progress',
        stage: 'extracting',
        progress: PROGRESS.extracted,
        attempt,
        message: 'text extracted',
        payload: { page_count: parsed.pageCount, content_length: parsed.text.length },
      });
    });
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
    const wsId = job.workspace_id;

    await this.stage(wsId, job, attempt, 'embedding', PROGRESS.embedding, 'stage_changed', null);

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
    const doneUpTo = await withTenant(this.db, wsId, (tx) =>
      this.chunks.maxIndex(wsId, tx, doc.id),
    );
    const pending = doneUpTo === null ? all : all.filter((c) => c.index > doneUpTo);

    for (let i = 0; i < pending.length; i += EMBED_BATCH) {
      const batch = pending.slice(i, i + EMBED_BATCH);
      const vectors = await this.embedding.embed(batch.map((c) => c.content));
      const done = all.length - pending.length + i + batch.length;
      const progress =
        PROGRESS.embedding +
        Math.floor(((PROGRESS.embedded - PROGRESS.embedding) * done) / all.length);

      await withTenant(this.db, wsId, async (tx) => {
        for (const [k, chunk] of batch.entries()) {
          await this.chunks.upsert(wsId, tx, {
            id: newId('chk'),
            document_id: doc.id,
            chunk_index: chunk.index,
            content: chunk.content,
            token_count: chunk.tokenCount,
            embedding: vectors[k] ?? [],
          });
        }
        await this.jobs.setStage(wsId, tx, job.id, 'embedding', progress);
        await this.events.emit(wsId, tx, {
          job_id: job.id,
          type: 'progress',
          stage: 'embedding',
          progress,
          attempt,
          message: `embedded ${done}/${all.length} chunks`,
          payload: { chunks_done: done, chunks_total: all.length },
        });
      });
    }
    return all.length;
  }

  private async stage(
    wsId: string,
    job: JobRow,
    attempt: number,
    stage: 'extracting' | 'embedding',
    progress: number,
    type: 'stage_changed' | 'progress',
    message: string | null,
  ): Promise<void> {
    await withTenant(this.db, wsId, async (tx) => {
      await this.jobs.setStage(wsId, tx, job.id, stage, progress);
      await this.events.emit(wsId, tx, {
        job_id: job.id,
        type,
        stage,
        progress,
        attempt,
        message,
        payload: null,
      });
    });
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
