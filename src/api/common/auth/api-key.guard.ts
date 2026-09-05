import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC } from '@/api/common/auth/public.decorator';
import type { AuthedRequest, WorkspaceContext } from '@/api/common/auth/workspace-context';
import type { Db } from '@/shared/db/client';
import { DB } from '@/shared/db/db.module';
import { ApiKeysRepository } from '@/shared/db/repositories/api-keys.repository';
import { AppError } from '@/shared/errors/app-error';
import { ErrorCode } from '@/shared/errors/codes';

const CACHE_TTL_MS = 60_000;

type CacheEntry = { ctx: WorkspaceContext; expiresAt: number };

// docs/DESIGN.md §7.1：Bearer token → SHA-256 → api_keys.key_hash 且未撤銷。
// 查詢結果快取 60 秒（D-07 允許的唯一快取）；只快取成功結果，錯誤的 key 每次都打 DB。
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Db,
    private readonly apiKeys: ApiKeysRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const rawKey = bearerToken(req.header('authorization'));
    if (rawKey === null) throw new AppError(ErrorCode.UNAUTHORIZED);

    const hash = new Bun.CryptoHasher('sha256').update(rawKey).digest('hex');
    req.workspace = await this.resolve(hash);
    return true;
  }

  private async resolve(hash: string): Promise<WorkspaceContext> {
    const now = Date.now();
    const cached = this.cache.get(hash);
    if (cached !== undefined && cached.expiresAt > now) return cached.ctx;
    this.cache.delete(hash);

    const row = await this.apiKeys.findActiveByHash(this.db, hash);
    if (row === null) throw new AppError(ErrorCode.UNAUTHORIZED);

    const ctx: WorkspaceContext = { workspaceId: row.workspace_id, apiKeyId: row.id };
    this.cache.set(hash, { ctx, expiresAt: now + CACHE_TTL_MS });
    return ctx;
  }
}

function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined || rest.length > 0) return null;
  return token;
}
