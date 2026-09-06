import { Inject, Injectable } from '@nestjs/common';

import { type Db, type Tx, withTenant } from '@/shared/db/client';
import { DB } from '@/shared/db/db.module';
import {
  DocumentChunksRepository,
  type NewChunk,
} from '@/shared/db/repositories/document-chunks.repository';
import { DocumentsRepository } from '@/shared/db/repositories/documents.repository';
import {
  JobEventsRepository,
  type NewJobEvent,
} from '@/shared/db/repositories/job-events.repository';
import { JobsRepository } from '@/shared/db/repositories/jobs.repository';
import type { DocumentRow, JobRow } from '@/shared/db/rows';
import { ErrorCode } from '@/shared/errors/codes';
import type { WorkerErrorCode } from '@/shared/errors/worker-error';
import { QUEUE, type QueuePort } from '@/shared/ports/queue.port';

const CHANNEL = 'job_events';

// §9.3 的進度區間
export const PROGRESS = {
  extracting: 10,
  extracted: 40,
  embedding: 40,
  embedded: 90,
  ready: 100,
} as const;

export interface ProgressEvent {
  type: 'stage_changed' | 'progress';
  stage: 'extracting' | 'embedding';
  progress: number;
  message?: string;
  payload?: Record<string, unknown>;
}

// docs/DESIGN.md §9.2、§9.4、D-04、D-13 的唯一落點：job 的每一次狀態變更都從這裡走，
// 每個方法就是一個短交易——UPDATE jobs（必要時 documents）+ INSERT job_events + NOTIFY，
// 終止時再加 pgmq 的 archive / set_vt。呼叫端只表達意圖（start / progress / retry / fail / complete），
// 不需要知道有幾張表、事件欄位長什麼樣。
@Injectable()
export class JobTransitions {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(QUEUE) private readonly queue: QueuePort,
    private readonly jobs: JobsRepository,
    private readonly documents: DocumentsRepository,
    private readonly chunks: DocumentChunksRepository,
    private readonly events: JobEventsRepository,
  ) {}

  load(workspaceId: string, jobId: string): Promise<JobRow | null> {
    return withTenant(this.db, workspaceId, (tx) => this.jobs.findById(workspaceId, tx, jobId));
  }

  // 領到訊息：attempt = read_ct，job → extracting/10，document → processing；回傳要處理的 document
  start(job: JobRow, attempt: number): Promise<DocumentRow | null> {
    const wsId = job.workspace_id;
    return withTenant(this.db, wsId, async (tx) => {
      await this.jobs.start(wsId, tx, job.id, attempt);
      await this.documents.setStatus(wsId, tx, job.document_id, 'processing');
      await this.emit(wsId, tx, job.id, attempt, {
        type: 'stage_changed',
        stage: 'extracting',
        progress: PROGRESS.extracting,
      });
      return this.documents.findById(wsId, tx, job.document_id);
    });
  }

  // 抽取完成：寫 checkpoint（documents.extracted_text）並推進到 40
  extracted(job: JobRow, attempt: number, text: string, pageCount: number | null): Promise<void> {
    const wsId = job.workspace_id;
    return withTenant(this.db, wsId, async (tx) => {
      await this.documents.setExtracted(wsId, tx, job.document_id, text, pageCount);
      await this.jobs.setStage(wsId, tx, job.id, 'extracting', PROGRESS.extracted);
      await this.emit(wsId, tx, job.id, attempt, {
        type: 'progress',
        stage: 'extracting',
        progress: PROGRESS.extracted,
        message: 'text extracted',
        payload: { page_count: pageCount, content_length: text.length },
      });
    });
  }

  // 只有進度／階段變更，沒有其他寫入
  progress(job: JobRow, attempt: number, event: ProgressEvent): Promise<void> {
    const wsId = job.workspace_id;
    return withTenant(this.db, wsId, async (tx) => {
      await this.jobs.setStage(wsId, tx, job.id, event.stage, event.progress);
      await this.emit(wsId, tx, job.id, attempt, event);
    });
  }

  // 重試時從已存在的 chunk 之後接續（D-13）
  resumePoint(job: JobRow): Promise<number | null> {
    const wsId = job.workspace_id;
    return withTenant(this.db, wsId, (tx) => this.chunks.maxIndex(wsId, tx, job.document_id));
  }

  // 一批 chunk 連同進度同交易落地；(document_id, chunk_index) upsert 保證重試不重複
  chunksStored(
    job: JobRow,
    attempt: number,
    batch: NewChunk[],
    done: number,
    total: number,
    progress: number,
  ): Promise<void> {
    const wsId = job.workspace_id;
    return withTenant(this.db, wsId, async (tx) => {
      for (const chunk of batch) await this.chunks.upsert(wsId, tx, chunk);
      await this.jobs.setStage(wsId, tx, job.id, 'embedding', progress);
      await this.emit(wsId, tx, job.id, attempt, {
        type: 'progress',
        stage: 'embedding',
        progress,
        message: `embedded ${done}/${total} chunks`,
        payload: { chunks_done: done, chunks_total: total },
      });
    });
  }

  // §9.4 未達上限：回 queued、記錯誤、訊息 backoff 秒後重新可見
  retry(
    job: JobRow,
    attempt: number,
    msgId: string,
    code: WorkerErrorCode,
    message: string,
    backoffSec: number,
  ): Promise<void> {
    const wsId = job.workspace_id;
    return withTenant(this.db, wsId, async (tx) => {
      await this.jobs.markRetry(wsId, tx, job.id, code, message);
      await this.insertEvent(wsId, tx, {
        job_id: job.id,
        type: 'retry_scheduled',
        stage: null,
        progress: 0,
        attempt,
        message,
        payload: { code, next_in_sec: backoffSec },
      });
      await this.queue.setVt(tx, msgId, backoffSec);
    });
  }

  // §9.4 達上限：job 與 document 都 failed，訊息歸檔供稽核
  fail(
    job: JobRow,
    attempt: number,
    msgId: string,
    code: WorkerErrorCode,
    message: string,
  ): Promise<void> {
    const wsId = job.workspace_id;
    return withTenant(this.db, wsId, async (tx) => {
      await this.jobs.markFailed(wsId, tx, job.id, code, message);
      await this.documents.setStatus(wsId, tx, job.document_id, 'failed');
      await this.insertEvent(wsId, tx, {
        job_id: job.id,
        type: 'failed',
        stage: null,
        progress: 0,
        attempt,
        message,
        payload: { code, reason: ErrorCode.MAX_ATTEMPTS_EXCEEDED },
      });
      await this.queue.archive(tx, msgId);
    });
  }

  // §9.3 ready：只寫狀態；訊息歸檔與 completed 事件同一交易
  complete(job: JobRow, attempt: number, msgId: string, chunkCount: number): Promise<void> {
    const wsId = job.workspace_id;
    return withTenant(this.db, wsId, async (tx) => {
      await this.documents.markReady(wsId, tx, job.document_id, chunkCount);
      await this.jobs.markReady(wsId, tx, job.id);
      await this.insertEvent(wsId, tx, {
        job_id: job.id,
        type: 'completed',
        stage: null,
        progress: PROGRESS.ready,
        attempt,
        message: null,
        payload: { chunk_count: chunkCount },
      });
      await this.queue.archive(tx, msgId);
    });
  }

  private emit(
    wsId: string,
    tx: Tx,
    jobId: string,
    attempt: number,
    e: ProgressEvent,
  ): Promise<void> {
    return this.insertEvent(wsId, tx, {
      job_id: jobId,
      type: e.type,
      stage: e.stage,
      progress: e.progress,
      attempt,
      message: e.message ?? null,
      payload: e.payload ?? null,
    });
  }

  // D-04：INSERT job_events 並在同一交易 pg_notify；通知只帶 job_id 與 event_id 當叫醒鈴，commit 時才送出
  private async insertEvent(wsId: string, tx: Tx, event: NewJobEvent): Promise<void> {
    const eventId = await this.events.insert(wsId, tx, event);
    const payload = JSON.stringify({ job_id: event.job_id, event_id: eventId });
    await tx`select pg_notify(${CHANNEL}, ${payload})`;
  }
}
