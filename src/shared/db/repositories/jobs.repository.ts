import { Injectable } from '@nestjs/common';

import type { Tx } from '@/shared/db/client';
import type { JobRow, JobStatus } from '@/shared/db/rows';

export interface NewJob {
  id: string;
  document_id: string;
  max_attempts: number;
  queue_msg_id: string;
}

@Injectable()
export class JobsRepository {
  async insert(workspaceId: string, tx: Tx, job: NewJob): Promise<void> {
    await tx`
      insert into jobs (id, workspace_id, document_id, kind, status, max_attempts, queue_msg_id)
      values (${job.id}, ${workspaceId}, ${job.document_id}, 'ingest', 'queued', ${job.max_attempts}, ${job.queue_msg_id}::bigint)`;
  }

  async findById(workspaceId: string, tx: Tx, id: string): Promise<JobRow | null> {
    const rows: JobRow[] = await tx`
      select * from jobs where workspace_id = ${workspaceId} and id = ${id} limit 1`;
    return rows[0] ?? null;
  }

  // §9.2：領到訊息時 attempt = read_ct，started_at 只在第一次設定
  async start(workspaceId: string, tx: Tx, id: string, attempt: number): Promise<void> {
    await tx`
      update jobs
      set status = 'extracting', progress = 10, attempt = ${attempt},
          started_at = coalesce(started_at, now()), updated_at = now()
      where workspace_id = ${workspaceId} and id = ${id}`;
  }

  async setStage(
    workspaceId: string,
    tx: Tx,
    id: string,
    status: JobStatus,
    progress: number,
  ): Promise<void> {
    await tx`
      update jobs set status = ${status}, progress = ${progress}, updated_at = now()
      where workspace_id = ${workspaceId} and id = ${id}`;
  }

  // §9.4：未達上限，回到 queued 等 pgmq 的 vt 到期
  async markRetry(
    workspaceId: string,
    tx: Tx,
    id: string,
    code: string,
    message: string,
  ): Promise<void> {
    await tx`
      update jobs
      set status = 'queued', last_error_code = ${code}, last_error_message = ${message}, updated_at = now()
      where workspace_id = ${workspaceId} and id = ${id}`;
  }

  async markFailed(
    workspaceId: string,
    tx: Tx,
    id: string,
    code: string,
    message: string,
  ): Promise<void> {
    await tx`
      update jobs
      set status = 'failed', last_error_code = ${code}, last_error_message = ${message},
          finished_at = now(), updated_at = now()
      where workspace_id = ${workspaceId} and id = ${id}`;
  }

  async markReady(workspaceId: string, tx: Tx, id: string): Promise<void> {
    await tx`
      update jobs
      set status = 'ready', progress = 100, last_error_code = null, last_error_message = null,
          finished_at = now(), updated_at = now()
      where workspace_id = ${workspaceId} and id = ${id}`;
  }
}
