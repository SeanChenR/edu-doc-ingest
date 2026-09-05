import { Injectable } from '@nestjs/common';

import type { Tx } from '@/shared/db/client';
import type { DocumentRow, DocumentStatus } from '@/shared/db/rows';

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

  async findById(workspaceId: string, tx: Tx, id: string): Promise<DocumentRow | null> {
    const rows: DocumentRow[] = await tx`
      select * from documents where workspace_id = ${workspaceId} and id = ${id} limit 1`;
    return rows[0] ?? null;
  }

  async setStatus(workspaceId: string, tx: Tx, id: string, status: DocumentStatus): Promise<void> {
    await tx`
      update documents set status = ${status}, updated_at = now()
      where workspace_id = ${workspaceId} and id = ${id}`;
  }

  // §9.3 extracting 的 checkpoint：已有 extracted_text 就代表這階段做過了
  async setExtracted(
    workspaceId: string,
    tx: Tx,
    id: string,
    text: string,
    pageCount: number | null,
  ): Promise<void> {
    await tx`
      update documents set extracted_text = ${text}, page_count = ${pageCount}, updated_at = now()
      where workspace_id = ${workspaceId} and id = ${id}`;
  }

  async markReady(workspaceId: string, tx: Tx, id: string, chunkCount: number): Promise<void> {
    await tx`
      update documents set status = 'ready', chunk_count = ${chunkCount}, updated_at = now()
      where workspace_id = ${workspaceId} and id = ${id}`;
  }
}
