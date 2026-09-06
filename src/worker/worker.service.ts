import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';
import type { Db } from '@/shared/db/client';
import { DB } from '@/shared/db/db.module';
import type { JobRow } from '@/shared/db/rows';
import { ErrorCode } from '@/shared/errors/codes';
import { sanitizeError } from '@/shared/errors/sanitize';
import { WorkerError, type WorkerErrorCode } from '@/shared/errors/worker-error';
import { QUEUE, type QueueMessage, type QueuePort } from '@/shared/ports/queue.port';
import { JobTransitions } from '@/worker/job-transitions';
import { type JobContext, PipelineService } from '@/worker/pipeline/pipeline.service';

const SHUTDOWN_GRACE_MS = 30_000;
// §9.4：第 1 次失敗 2 秒後重試，第 2 次 5 秒
const BACKOFF_SEC: Record<number, number> = { 1: 2, 2: 5 };
const TERMINAL = new Set(['ready', 'failed']);

// docs/DESIGN.md §9.1 主迴圈、§9.2 handle、§9.4 失敗與重試的「決策」；狀態變更本身交給 JobTransitions。
// worker_user 有 BYPASSRLS 才能跨租戶領佇列，但每件工作仍用訊息裡的 workspace_id 包 withTenant（§7.3）。
@Injectable()
export class WorkerService implements OnApplicationShutdown {
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DB) private readonly db: Db,
    @Inject(QUEUE) private readonly queue: QueuePort,
    private readonly transitions: JobTransitions,
    private readonly pipeline: PipelineService,
    private readonly log: PinoLogger,
  ) {
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

    const job = await this.transitions.load(wsId, jobId);
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

    const document = await this.transitions.start(job, attempt);
    if (document === null) {
      await this.failOrRetry(
        msg,
        job,
        attempt,
        ErrorCode.STORAGE_READ_FAILED,
        'Document row is missing.',
      );
      return;
    }

    // 處理期間持續續租約：只有 worker 真的死掉，訊息才會回到佇列（避免長工作被第二個 worker 重複處理）
    const lease = this.keepLease(msg.msgId);
    // 單次 attempt 的時間上限：逾時就 abort，pipeline 在下一個狀態變更前停下，這次視為失敗走重試
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new WorkerError(
            ErrorCode.EXTRACTION_FAILED,
            `Attempt timed out after ${this.env.JOB_TIMEOUT_MS} ms.`,
          ),
        ),
      this.env.JOB_TIMEOUT_MS,
    );
    const ctx: JobContext = { job, document, attempt, signal: controller.signal };
    try {
      await Promise.race([this.process(msg, ctx), abortedPromise(controller.signal)]);
    } catch (err) {
      const { code, message } = classify(err);
      this.log.warn({ job_id: jobId, attempt, code, err }, 'job attempt failed');
      await this.failOrRetry(msg, job, attempt, code, message);
    } finally {
      clearTimeout(timeout);
      clearInterval(lease);
    }
  }

  private async process(msg: QueueMessage, ctx: JobContext): Promise<void> {
    const { job, document, attempt } = ctx;
    try {
      const text = await this.pipeline.extract(ctx);
      const chunkCount = await this.pipeline.embed(ctx, text);
      ctx.signal.throwIfAborted();
      await this.transitions.complete(job, attempt, msg.msgId, chunkCount);
      this.log.info(
        { job_id: job.id, document_id: document.id, chunk_count: chunkCount },
        'job ready',
      );
    } catch (err) {
      // 已逾時的 attempt：handle() 那邊已經走重試，這裡只把被 abort 的 promise 收掉，不再處理
      if (ctx.signal.aborted) {
        this.log.info({ job_id: job.id, attempt }, 'abandoned attempt stopped at a checkpoint');
        return;
      }
      throw err;
    }
  }

  // 每 VISIBILITY_TIMEOUT / 2 秒把訊息的可見時間再往後推一個 VISIBILITY_TIMEOUT
  private keepLease(msgId: string): ReturnType<typeof setInterval> {
    const vt = this.env.WORKER_VISIBILITY_TIMEOUT_SEC;
    return setInterval(
      () => {
        this.queue.setVt(this.db, msgId, vt).catch((err: unknown) => {
          this.log.warn({ msg_id: msgId, err }, 'lease renewal failed');
        });
      },
      Math.max(500, (vt * 1000) / 2),
    );
  }

  // §9.4：未達 max_attempts 就排重試（退避 2 秒 / 5 秒），否則最終失敗
  private failOrRetry(
    msg: QueueMessage,
    job: JobRow,
    attempt: number,
    code: WorkerErrorCode,
    message: string,
  ): Promise<void> {
    if (attempt < job.max_attempts) {
      return this.transitions.retry(
        job,
        attempt,
        msg.msgId,
        code,
        message,
        BACKOFF_SEC[attempt] ?? 5,
      );
    }
    return this.transitions.fail(job, attempt, msg.msgId, code, message);
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

// abort 時以 signal.reason（WorkerError）reject，讓 Promise.race 立刻結束
function abortedPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

// 對應 §6.3 的 worker 錯誤碼；訊息經 sanitizeError 才進資料庫
function classify(err: unknown): { code: WorkerErrorCode; message: string } {
  const code = err instanceof WorkerError ? err.code : ErrorCode.EXTRACTION_FAILED;
  return { code, message: sanitizeError(err) };
}
