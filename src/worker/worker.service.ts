import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';
import { type Db, withTenant } from '@/shared/db/client';
import { DB } from '@/shared/db/db.module';
import { DocumentsRepository } from '@/shared/db/repositories/documents.repository';
import { JobsRepository } from '@/shared/db/repositories/jobs.repository';
import { ErrorCode } from '@/shared/errors/codes';
import { sanitizeError } from '@/shared/errors/sanitize';
import { WorkerError, type WorkerErrorCode } from '@/shared/errors/worker-error';
import { QUEUE, type QueueMessage, type QueuePort } from '@/shared/ports/queue.port';
import { JobEventsService } from '@/worker/job-events.service';
import { type JobContext, PipelineService } from '@/worker/pipeline/pipeline.service';

const SHUTDOWN_GRACE_MS = 30_000;
// §9.4：第 1 次失敗 2 秒後重試，第 2 次 5 秒
const BACKOFF_SEC: Record<number, number> = { 1: 2, 2: 5 };
const TERMINAL = new Set(['ready', 'failed']);

// docs/DESIGN.md §9.1 主迴圈、§9.2 handle、§9.4 失敗與重試。
// worker_user 有 BYPASSRLS 才能跨租戶領佇列，但每件工作仍用訊息裡的 workspace_id 包 withTenant（§7.3）。
@Injectable()
export class WorkerService implements OnApplicationShutdown {
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DB) private readonly db: Db,
    @Inject(QUEUE) private readonly queue: QueuePort,
    private readonly jobs: JobsRepository,
    private readonly documents: DocumentsRepository,
    private readonly events: JobEventsService,
    private readonly pipeline: PipelineService,
    private readonly log: PinoLogger,
  ) {
    // 用 setContext 而不是 @InjectPinoLogger：後者的 token 靠 LoggerModule 建立時的掃描順序決定，太脆弱
    this.log.setContext(WorkerService.name);
  }

  // 由 main.ts 呼叫；收到 SIGTERM 後停止領新訊息，等進行中的完成再返回。
  async run(): Promise<void> {
    this.log.info(
      {
        concurrency: this.env.WORKER_CONCURRENCY,
        poll_interval_ms: this.env.WORKER_POLL_INTERVAL_MS,
      },
      'worker started',
    );
    while (!this.stopping) {
      let handled = 0;
      try {
        handled = await this.pollOnce();
      } catch (err) {
        this.log.error({ err }, 'poll failed');
      }
      await this.heartbeat();
      if (handled === 0) await Bun.sleep(this.env.WORKER_POLL_INTERVAL_MS);
    }
    await Promise.allSettled(this.inFlight);
    this.log.info('worker stopped');
  }

  // 領一批並處理完；回傳處理的訊息數。測試直接呼叫這個，不跑 run()。
  async pollOnce(): Promise<number> {
    const msgs = await this.queue.read(
      this.db,
      this.env.WORKER_CONCURRENCY,
      this.env.WORKER_VISIBILITY_TIMEOUT_SEC,
    );
    if (msgs.length === 0) return 0;
    const tasks = msgs.map((m) => this.track(this.handle(m)));
    await Promise.all(tasks);
    return msgs.length;
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.log.info({ signal }, 'worker draining');
    this.stopping = true;
    await Promise.race([Promise.allSettled(this.inFlight), Bun.sleep(SHUTDOWN_GRACE_MS)]);
  }

  // §9.2
  async handle(msg: QueueMessage): Promise<void> {
    const { job_id: jobId, workspace_id: wsId } = msg.message;
    const attempt = msg.readCt;

    const job = await withTenant(this.db, wsId, (tx) => this.jobs.findById(wsId, tx, jobId));
    if (job === null) {
      this.log.warn(
        { job_id: jobId, msg_id: msg.msgId },
        'message refers to unknown job; archiving',
      );
      await this.queue.archive(this.db, msg.msgId);
      return;
    }
    if (TERMINAL.has(job.status)) {
      // 重複投遞保護
      await this.queue.archive(this.db, msg.msgId);
      return;
    }

    const document = await withTenant(this.db, wsId, async (tx) => {
      await this.jobs.start(wsId, tx, jobId, attempt);
      await this.documents.setStatus(wsId, tx, job.document_id, 'processing');
      await this.events.emit(wsId, tx, {
        job_id: jobId,
        type: 'stage_changed',
        stage: 'extracting',
        progress: 10,
        attempt,
        message: null,
        payload: null,
      });
      return this.documents.findById(wsId, tx, job.document_id);
    });
    if (document === null) {
      await this.fail(msg, job, attempt, ErrorCode.STORAGE_READ_FAILED, 'Document row is missing.');
      return;
    }

    const ctx: JobContext = { job, document, attempt };
    try {
      const text = await this.pipeline.extract(ctx);
      const chunkCount = await this.pipeline.embed(ctx, text);
      await this.finalize(msg, ctx, chunkCount);
    } catch (err) {
      const { code, message } = classify(err);
      this.log.warn({ job_id: jobId, attempt, code, err }, 'job attempt failed');
      await this.fail(msg, job, attempt, code, message);
    }
  }

  // §9.3 ready：只寫狀態；訊息歸檔與 completed 事件同一交易
  private async finalize(msg: QueueMessage, ctx: JobContext, chunkCount: number): Promise<void> {
    const { job, document, attempt } = ctx;
    const wsId = job.workspace_id;
    await withTenant(this.db, wsId, async (tx) => {
      await this.documents.markReady(wsId, tx, document.id, chunkCount);
      await this.jobs.markReady(wsId, tx, job.id);
      await this.events.emit(wsId, tx, {
        job_id: job.id,
        type: 'completed',
        stage: null,
        progress: 100,
        attempt,
        message: null,
        payload: { chunk_count: chunkCount },
      });
      await this.queue.archive(tx, msg.msgId);
    });
    this.log.info(
      { job_id: job.id, document_id: document.id, chunk_count: chunkCount },
      'job ready',
    );
  }

  // §9.4
  private async fail(
    msg: QueueMessage,
    job: { id: string; workspace_id: string; document_id: string; max_attempts: number },
    attempt: number,
    code: WorkerErrorCode,
    message: string,
  ): Promise<void> {
    const wsId = job.workspace_id;
    if (attempt < job.max_attempts) {
      const backoff = BACKOFF_SEC[attempt] ?? 5;
      await withTenant(this.db, wsId, async (tx) => {
        await this.jobs.markRetry(wsId, tx, job.id, code, message);
        await this.events.emit(wsId, tx, {
          job_id: job.id,
          type: 'retry_scheduled',
          stage: null,
          progress: 0,
          attempt,
          message,
          payload: { code, next_in_sec: backoff },
        });
        await this.queue.setVt(tx, msg.msgId, backoff);
      });
      return;
    }
    await withTenant(this.db, wsId, async (tx) => {
      await this.jobs.markFailed(wsId, tx, job.id, code, message);
      await this.documents.setStatus(wsId, tx, job.document_id, 'failed');
      await this.events.emit(wsId, tx, {
        job_id: job.id,
        type: 'failed',
        stage: null,
        progress: 0,
        attempt,
        message,
        payload: { code, reason: ErrorCode.MAX_ATTEMPTS_EXCEEDED },
      });
      await this.queue.archive(tx, msg.msgId);
    });
  }

  private track(p: Promise<void>): Promise<void> {
    const tracked = p.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
    return tracked;
  }

  private async heartbeat(): Promise<void> {
    try {
      await Bun.write(this.env.WORKER_HEARTBEAT_FILE, String(Date.now()));
    } catch (err) {
      this.log.warn({ err }, 'heartbeat write failed');
    }
  }
}

// 對應 §6.3 的 worker 錯誤碼；訊息經 sanitizeError 才進資料庫
function classify(err: unknown): { code: WorkerErrorCode; message: string } {
  const code = err instanceof WorkerError ? err.code : ErrorCode.EXTRACTION_FAILED;
  return { code, message: sanitizeError(err) };
}
