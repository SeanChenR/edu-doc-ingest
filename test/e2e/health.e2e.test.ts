// docs/DESIGN.md §5.5、§11.1「Health」：/health 永遠 200；資料庫不可用時 /ready 回 503 NOT_READY。
// 「資料庫不可用」用關掉這個 app 自己的連線池模擬，其他測試檔的 app 不受影響。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { z } from 'zod';

import type { Db } from '@/shared/db/client';
import { DB } from '@/shared/db/db.module';

import { bootApp } from './helpers';

const ErrorBody = z.object({
  error: z.object({ code: z.string(), message: z.string(), request_id: z.string() }),
});

let app: INestApplication;
let http: ReturnType<typeof request>;

beforeAll(async () => {
  app = await bootApp();
  http = request(app.getHttpServer());
});
afterAll(async () => {
  await app.close();
});

describe('health', () => {
  test('/health and /ready are 200 while the database is reachable', async () => {
    expect((await http.get('/health')).status).toBe(200);
    const ready = await http.get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ok', request_id: expect.stringMatching(/^req_/) });
  });

  test('/ready → 503 NOT_READY once the database is unreachable; /health stays 200', async () => {
    await app.get<Db>(DB).close();

    const ready = await http.get('/ready');
    expect(ready.status).toBe(503);
    const error = ErrorBody.parse(ready.body).error;
    expect(error.code).toBe('NOT_READY');
    expect(error.message).toStartWith('Not ready');
    expect(error.request_id).toMatch(/^req_/);
    // 錯誤訊息不得洩漏連線字串
    expect(error.message).not.toMatch(/postgres:\/\//);

    expect((await http.get('/health')).status).toBe(200);
  });
});
