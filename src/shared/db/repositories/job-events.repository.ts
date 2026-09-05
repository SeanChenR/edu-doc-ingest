import { Injectable } from '@nestjs/common';

import type { Tx } from '@/shared/db/client';
import type { JobEventRow, JobEventType } from '@/shared/db/rows';

export interface NewJobEvent {
  job_id: string;
  type: JobEventType;
  stage: string | null;
  progress: number;
  attempt: number;
  message: string | null;
  payload: Record<string, unknown> | null;
}

// docs/DESIGN.md §4.6：id 是 bigserial，就是 SSE 的 event id（D-22）。
@Injectable()
export class JobEventsRepository {
  async insert(workspaceId: string, tx: Tx, event: NewJobEvent): Promise<string> {
    const rows: { id: string }[] = await tx`
      insert into job_events (job_id, workspace_id, type, stage, progress, attempt, message, payload)
      values (${event.job_id}, ${workspaceId}, ${event.type}, ${event.stage}, ${event.progress},
              ${event.attempt}, ${event.message}, ${event.payload})
      returning id`;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('job_events insert returned no id');
    return id;
  }

  // SSE 補發（§5.4）：id > afterId 的歷史事件，依 id 升冪
  async findAfter(
    workspaceId: string,
    tx: Tx,
    jobId: string,
    afterId: string,
  ): Promise<JobEventRow[]> {
    return tx`
      select * from job_events
      where workspace_id = ${workspaceId} and job_id = ${jobId} and id > ${afterId}::bigint
      order by id`;
  }

  // NOTIFY 只當叫醒鈴：用通知裡的 event_id 回表讀，且必須屬於同一個 job 與 workspace（D-04）
  async findOne(
    workspaceId: string,
    tx: Tx,
    jobId: string,
    id: string,
  ): Promise<JobEventRow | null> {
    const rows: JobEventRow[] = await tx`
      select * from job_events
      where workspace_id = ${workspaceId} and job_id = ${jobId} and id = ${id}::bigint
      limit 1`;
    return rows[0] ?? null;
  }

  async findLast(workspaceId: string, tx: Tx, jobId: string): Promise<JobEventRow | null> {
    const rows: JobEventRow[] = await tx`
      select * from job_events
      where workspace_id = ${workspaceId} and job_id = ${jobId}
      order by id desc limit 1`;
    return rows[0] ?? null;
  }
}
