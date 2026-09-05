import { Injectable } from '@nestjs/common';

import type { Db, Tx } from '@/shared/db/client';
import type { IdempotencyKeyRow } from '@/shared/db/rows';

// docs/DESIGN.md §8、D-11：主鍵 (workspace_id, key) 的衝突就是鎖。
@Injectable()
export class IdempotencyKeysRepository {
  async find(workspaceId: string, sql: Db | Tx, key: string): Promise<IdempotencyKeyRow | null> {
    const rows: IdempotencyKeyRow[] = await sql`
      select * from idempotency_keys
      where workspace_id = ${workspaceId} and key = ${key}
      limit 1`;
    return rows[0] ?? null;
  }

  // 搶到回 true；已有同 key 的列回 false（併發時後到者會在這裡等前一筆交易 commit）。
  async claim(
    workspaceId: string,
    tx: Tx,
    key: string,
    requestHash: string,
    expiresAt: Date,
  ): Promise<boolean> {
    const rows: { key: string }[] = await tx`
      insert into idempotency_keys (workspace_id, key, request_hash, expires_at)
      values (${workspaceId}, ${key}, ${requestHash}, ${expiresAt})
      on conflict (workspace_id, key) do nothing
      returning key`;
    return rows.length === 1;
  }

  async complete(
    workspaceId: string,
    tx: Tx,
    key: string,
    responseStatus: number,
    responseBody: Record<string, unknown>,
  ): Promise<void> {
    await tx`
      update idempotency_keys
      set response_status = ${responseStatus}, response_body = ${responseBody}
      where workspace_id = ${workspaceId} and key = ${key}`;
  }
}
