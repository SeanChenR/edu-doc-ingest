import { Injectable } from '@nestjs/common';

import type { Db } from '@/shared/db/client';
import type { ApiKeyRow } from '@/shared/db/rows';

export type ActiveApiKey = Pick<ApiKeyRow, 'id' | 'workspace_id'>;

// api_keys 不是租戶表（§7.3 未列入 RLS），而且這個查詢就是「用 key 找出 workspace」，
// 所以是整個 repositories 目錄裡唯一不以 workspaceId 為第一參數的方法。
@Injectable()
export class ApiKeysRepository {
  async findActiveByHash(db: Db, keyHash: string): Promise<ActiveApiKey | null> {
    const rows: ActiveApiKey[] = await db`
      select id, workspace_id from api_keys
      where key_hash = ${keyHash} and revoked_at is null
      limit 1`;
    return rows[0] ?? null;
  }
}
