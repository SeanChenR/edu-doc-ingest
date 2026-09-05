import { Injectable } from '@nestjs/common';

import type { Tx } from '@/shared/db/client';

export interface NewDocument {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  metadata: Record<string, unknown> | null;
  latest_job_id: string;
}

// 每個方法第一參數是 workspaceId，SQL 一律帶 workspace_id（§7.2 第一道防線）；
// 呼叫端必須在 withTenant() 交易內，RLS 是第二道。
@Injectable()
export class DocumentsRepository {
  async insert(workspaceId: string, tx: Tx, doc: NewDocument): Promise<void> {
    await tx`
      insert into documents (id, workspace_id, name, mime_type, size_bytes, storage_key, status, latest_job_id, metadata)
      values (${doc.id}, ${workspaceId}, ${doc.name}, ${doc.mime_type}, ${doc.size_bytes}, ${doc.storage_key},
              'pending', ${doc.latest_job_id}, ${doc.metadata})`;
  }
}
