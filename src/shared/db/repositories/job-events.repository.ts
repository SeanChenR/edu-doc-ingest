import { Injectable } from '@nestjs/common';

import type { Tx } from '@/shared/db/client';
import type { JobEventType } from '@/shared/db/rows';

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
}
