// docs/DESIGN.md §7.4、§11.1「日誌」：抓 pino 輸出，斷言 content_text 內容與 API key 未出現。
// nestjs-pino 一個 process 只有一個 pino 實例（先起的 app 決定設定），所以這裡不在測試程序內起 app，
// 而是用 Bun.spawn 起真正的 src/api/main.ts（隨機 port、LOG_FILE），打幾個請求後關掉再讀檔——順便證明正式進入點能跑。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { z } from 'zod';

import { ALPHA_KEY } from './helpers';

const ROOT = `${import.meta.dir}/../..`;
const LOG_FILE = `${ROOT}/storage/.test-logs/api-${Date.now()}.log`;
const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET_CONTENT = 'TOP_SECRET_LESSON_CONTENT_9f3a';
const Accepted = z.object({ request_id: z.string() });

let api: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  api = Bun.spawn(['bun', '--bun', 'src/api/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), LOG_FILE, LOG_LEVEL: 'info', LOG_PRETTY: 'false' },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // 還沒起來
    }
    await Bun.sleep(250);
  }
  const stderr = api.stderr instanceof ReadableStream ? await new Response(api.stderr).text() : '';
  throw new Error(`api did not start on :${PORT}\n${stderr}`);
});
afterAll(async () => {
  api.kill('SIGTERM');
  await api.exited;
  await Bun.file(LOG_FILE).delete();
});

describe('log redaction', () => {
  test('request logs never contain document content or the raw API key; Authorization is redacted', async () => {
    const created = await fetch(`${BASE}/v1/workspaces/ws_alpha/documents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ALPHA_KEY}`,
        'Idempotency-Key': `log-${Date.now()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `${SECRET_CONTENT}.txt`,
        mime_type: 'text/plain',
        size_bytes: SECRET_CONTENT.length,
        content_text: SECRET_CONTENT,
      }),
    });
    expect(created.status).toBe(202);
    const { request_id } = Accepted.parse(await created.json());
    // 一個走到錯誤 filter 的 404，一個 401
    await fetch(`${BASE}/v1/jobs/job_nope`, { headers: { Authorization: `Bearer ${ALPHA_KEY}` } });
    await fetch(`${BASE}/v1/jobs/job_nope`, {
      headers: { Authorization: 'Bearer not-a-real-key' },
    });

    // pino 的檔案輸出是同步的，但給 process 一點時間 flush
    await Bun.sleep(200);
    const log = await Bun.file(LOG_FILE).text();
    const lines = log.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();

    expect(log).not.toContain(SECRET_CONTENT.slice(0, 20));
    expect(log).not.toContain(ALPHA_KEY);
    expect(log).not.toContain('not-a-real-key');
    expect(log).toContain('"authorization":"[Redacted]"');
    expect(log).toContain('"url":"/v1/workspaces/ws_alpha/documents"');
    expect(log).toContain(`"id":"${request_id}"`);
  });
});
