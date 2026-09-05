import { Inject, Injectable } from '@nestjs/common';

import { requestHash } from '@/api/modules/idempotency/canonical-json';
import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';
import type { Db, Tx } from '@/shared/db/client';
import { IdempotencyKeysRepository } from '@/shared/db/repositories/idempotency-keys.repository';
import type { IdempotencyKeyRow } from '@/shared/db/rows';
import { AppError } from '@/shared/errors/app-error';
import { ErrorCode } from '@/shared/errors/codes';

// docs/DESIGN.md §6.4：Idempotency-Key 1–128 字元 ASCII
const KEY_RE = /^[\x21-\x7e]{1,128}$/;

export interface ReplayableResponse {
  status: number;
  body: Record<string, unknown>;
}

// docs/DESIGN.md §8、D-11。DocumentsService 呼叫順序：requireKey → find（交易外）→ claim → complete。
@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly repo: IdempotencyKeysRepository,
  ) {}

  requireKey(header: string | undefined): string {
    if (header === undefined || header === '') throw new AppError(ErrorCode.IDEMPOTENCY_KEY_REQUIRED);
    if (!KEY_RE.test(header)) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, undefined, [
        { field: 'Idempotency-Key', issue: 'must be 1-128 printable ASCII characters' },
      ]);
    }
    return header;
  }

  hash(body: unknown): string {
    return requestHash(body);
  }

  find(workspaceId: string, sql: Db | Tx, key: string): Promise<IdempotencyKeyRow | null> {
    return this.repo.find(workspaceId, sql, key);
  }

  claim(workspaceId: string, tx: Tx, key: string, hash: string): Promise<boolean> {
    const expiresAt = new Date(Date.now() + this.env.IDEMPOTENCY_TTL_HOURS * 3_600_000);
    return this.repo.claim(workspaceId, tx, key, hash, expiresAt);
  }

  complete(workspaceId: string, tx: Tx, key: string, response: ReplayableResponse): Promise<void> {
    return this.repo.complete(workspaceId, tx, key, response.status, response.body);
  }

  // 既有列與目前請求比對：hash 相同 → 重播存好的回應；不同 → 409。
  replay(row: IdempotencyKeyRow, hash: string): ReplayableResponse {
    if (row.request_hash !== hash) throw new AppError(ErrorCode.IDEMPOTENCY_KEY_REUSED);
    if (row.response_status === null || row.response_body === null) {
      // claim 與 complete 在同一交易，理論上不會走到；防禦性處理
      throw new AppError(ErrorCode.INTERNAL_ERROR);
    }
    return { status: row.response_status, body: row.response_body };
  }
}
