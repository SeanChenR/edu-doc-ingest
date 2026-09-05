import { Injectable } from '@nestjs/common';

import type { Tx } from '@/shared/db/client';

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
}
