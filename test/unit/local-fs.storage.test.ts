import { afterAll, describe, expect, test } from 'bun:test';

import { LocalFsStorage } from '@/shared/adapters/storage/local-fs.storage';
import { loadEnv } from '@/shared/config/env';
import { AppError } from '@/shared/errors/app-error';

const root = `${import.meta.dir}/../../storage/.test-${Date.now()}`;
const storage = new LocalFsStorage(loadEnv({ ...process.env, STORAGE_ROOT: root }));

afterAll(async () => {
  for await (const f of new Bun.Glob('**/*').scan({ cwd: root }))
    await Bun.file(`${root}/${f}`).delete();
});

describe('LocalFsStorage (§7.4, D-21)', () => {
  test('put / exists / get / delete round trip', async () => {
    const key = 'ws_alpha/inline/a.txt';
    await storage.put(key, new TextEncoder().encode('hi'), 'text/plain');
    expect(await storage.exists(key)).toBe(true);
    expect(new TextDecoder().decode(await storage.get(key))).toBe('hi');
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });

  test('refuses keys that resolve outside STORAGE_ROOT', async () => {
    for (const key of ['../outside.txt', 'ws_alpha/../../x', '/etc/passwd']) {
      let caught: unknown;
      try {
        await storage.exists(key);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AppError);
    }
  });
});
