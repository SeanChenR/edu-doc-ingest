import { Inject, Injectable } from '@nestjs/common';
// Bun 沒有原生的路徑正規化 API，這裡只能用 node:path。
import { resolve, sep } from 'node:path';

import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';
import { AppError } from '@/shared/errors/app-error';
import { ErrorCode } from '@/shared/errors/codes';
import type { StoragePort } from '@/shared/ports/storage.port';

// docs/DESIGN.md §7.4、D-21：key 解析成實體路徑後必須仍在 STORAGE_ROOT 之下。
@Injectable()
export class LocalFsStorage implements StoragePort {
  private readonly root: string;

  constructor(@Inject(ENV) env: Env) {
    this.root = resolve(env.STORAGE_ROOT);
  }

  async put(key: string, bytes: Uint8Array, _mime: string): Promise<void> {
    await Bun.write(this.pathOf(key), bytes);
  }

  async get(key: string): Promise<Uint8Array> {
    return Bun.file(this.pathOf(key)).bytes();
  }

  exists(key: string): Promise<boolean> {
    return Bun.file(this.pathOf(key)).exists();
  }

  async delete(key: string): Promise<void> {
    await Bun.file(this.pathOf(key)).delete();
  }

  private pathOf(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new AppError(ErrorCode.INVALID_STORAGE_KEY);
    return full;
  }
}
