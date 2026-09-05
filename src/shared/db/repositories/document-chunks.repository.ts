import { Injectable } from '@nestjs/common';

import type { Tx } from '@/shared/db/client';

export interface NewChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
  embedding: number[];
}

// docs/DESIGN.md §4.4、D-13：(document_id, chunk_index) 唯一鍵 upsert，重試不會重複。
@Injectable()
export class DocumentChunksRepository {
  async upsert(workspaceId: string, tx: Tx, chunk: NewChunk): Promise<void> {
    // pgvector 的文字輸入格式是 '[x,y,z]'
    const vector = `[${chunk.embedding.join(',')}]`;
    await tx`
      insert into document_chunks (id, document_id, workspace_id, chunk_index, content, token_count, embedding)
      values (${chunk.id}, ${chunk.document_id}, ${workspaceId}, ${chunk.chunk_index}, ${chunk.content},
              ${chunk.token_count}, ${vector}::vector)
      on conflict (document_id, chunk_index) do update
        set content = excluded.content, token_count = excluded.token_count, embedding = excluded.embedding`;
  }

  // 重試時從已存在的 chunk 之後接續（§9.3）
  async maxIndex(workspaceId: string, tx: Tx, documentId: string): Promise<number | null> {
    const rows: { max: number | null }[] = await tx`
      select max(chunk_index)::int as max from document_chunks
      where workspace_id = ${workspaceId} and document_id = ${documentId}`;
    return rows[0]?.max ?? null;
  }

  async count(workspaceId: string, tx: Tx, documentId: string): Promise<number> {
    const rows: { n: number }[] = await tx`
      select count(*)::int as n from document_chunks
      where workspace_id = ${workspaceId} and document_id = ${documentId}`;
    return rows[0]?.n ?? 0;
  }
}
