// security-audit run-2 的兩個修正：
// MEDIUM-1 處理中續租約，長工作不會在 vt 過期後被第二次領走；LOW-1 單次 attempt 有時間上限，逾時走重試。
// 這個檔案用自己的 worker context（短 vt、短 timeout），不影響其他測試檔的 worker。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import { z } from 'zod';

import type { WorkerService } from '@/worker/worker.service';

import { ALPHA_KEY, adminQuery, bootApp, bootWorker, resetTenantData } from './helpers';

const Accepted = z.object({ document_id: z.string(), job_id: z.string() });

let app: INestApplication;
let http: ReturnType<typeof request>;
let leaseCtx: INestApplicationContext;
let leaseWorker: WorkerService;
let timeoutCtx: INestApplicationContext;
let timeoutWorker: WorkerService;
let n = 0;

beforeAll(async () => {
  process.env['FAILURE_INJECTION'] = 'true';
  process.env['STAGE_DELAY_MS'] = '0';
  app = await bootApp();
  http = request(app.getHttpServer());

  // 租約測試：vt 2 秒，每階段 1.5 秒 → 一個 job 約 3 秒，超過 vt
  process.env['WORKER_VISIBILITY_TIMEOUT_SEC'] = '2';
  process.env['STAGE_DELAY_MS'] = '1500';
  process.env['JOB_TIMEOUT_MS'] = '300000';
  ({ ctx: leaseCtx, worker: leaseWorker } = await bootWorker());

  // 逾時測試：attempt 上限 500 ms，每階段 1.5 秒 → 一定逾時
  process.env['JOB_TIMEOUT_MS'] = '500';
  process.env['WORKER_VISIBILITY_TIMEOUT_SEC'] = '60';
  ({ ctx: timeoutCtx, worker: timeoutWorker } = await bootWorker());

  process.env['STAGE_DELAY_MS'] = '0';
  process.env['JOB_TIMEOUT_MS'] = '300000';
});
afterAll(async () => {
  await leaseCtx.close();
  await timeoutCtx.close();
  await app.close();
});
beforeEach(resetTenantData);

async function create(content_text: string): Promise<{ document_id: string; job_id: string }> {
  const res = await http
    .post('/v1/workspaces/ws_alpha/documents')
    .set('Authorization', `Bearer ${ALPHA_KEY}`)
    .set('Idempotency-Key', `lease-${Date.now()}-${n++}`)
    .send({
      name: 'lease.txt',
      mime_type: 'text/plain',
      size_bytes: new TextEncoder().encode(content_text).byteLength,
      content_text,
    });
  expect(res.status).toBe(202);
  return Accepted.parse(res.body);
}

const job = (id: string) =>
  adminQuery(async (sql) => (await sql`select * from jobs where id = ${id}`)[0]);
const eventTypes = (jobId: string): Promise<{ type: string; attempt: number }[]> =>
  adminQuery(
    (sql) => sql`select type, attempt from job_events where job_id = ${jobId} order by id`,
  );

describe('visibility lease (audit run-2 MEDIUM-1)', () => {
  test('a job longer than the visibility timeout is not picked up a second time', async () => {
    const { job_id } = await create('slow but healthy');
    const first = leaseWorker.pollOnce(); // 約 3 秒（兩階段各 1.5 秒），vt 只有 2 秒
    await Bun.sleep(2500);
    // 沒有續租約的話這裡會再領到同一則訊息（read_ct 2）
    expect(await leaseWorker.pollOnce()).toBe(0);
    expect(await first).toBe(1);

    const j = await job(job_id);
    expect(j.status).toBe('ready');
    expect(j.attempt).toBe(1);
    const ev = await eventTypes(job_id);
    expect(ev.filter((e) => e.type === 'stage_changed' && e.attempt === 1)).toHaveLength(2);
    expect(ev.every((e) => e.attempt === 1)).toBe(true);
    const archived = await adminQuery((sql) => sql`select read_ct from pgmq.a_document_jobs`);
    expect(archived).toEqual([{ read_ct: 1 }]);
  }, 15_000);
});

describe('slot refill in run() (audit run-2 LOW-1, throughput)', () => {
  test('a finished slot picks the next message while a slow job is still running', async () => {
    // A：[[SLOW]] 每階段 3 秒 → 約 6 秒；B、C：每階段 1.5 秒 → 約 3 秒
    const a = await create('slow one');
    await adminQuery(
      (sql) => sql`update documents set name = '[[SLOW]].txt' where id = ${a.document_id}`,
    );
    const b = await create('fast one');

    const loop = leaseWorker.run();
    try {
      await Bun.sleep(3500);
      expect((await job(b.job_id)).status).toBe('ready');
      const c = await create('third one'); // 此時 A 還在跑，空出來的 slot 應該馬上領 C
      await Bun.sleep(4000); // t ≈ 7.5 s：舊迴圈要等 A（6 s）結束才領 C，C 會在 9 s 才 ready
      expect((await job(c.job_id)).status).toBe('ready');
      expect((await job(a.job_id)).status).toBe('ready');
    } finally {
      await leaseWorker.onApplicationShutdown('test');
      await loop;
    }
  }, 20_000);
});

describe('attempt timeout (audit run-2 LOW-1)', () => {
  test('an attempt over JOB_TIMEOUT_MS is retried with a sanitized error; the abandoned run writes nothing more', async () => {
    const { job_id } = await create('takes too long');
    expect(await timeoutWorker.pollOnce()).toBe(1);

    const j = await job(job_id);
    expect(j.status).toBe('queued');
    expect(j.attempt).toBe(1);
    expect(j.last_error_code).toBe('EXTRACTION_FAILED');
    expect(j.last_error_message).toContain('timed out');

    // 讓被放棄的那次跑到下一個 checkpoint（1.5 秒延遲之後）再檢查：不得寫入 extracted / 事件
    await Bun.sleep(2000);
    const ev = await eventTypes(job_id);
    expect(ev.map((e) => e.type)).toEqual(['stage_changed', 'retry_scheduled']);
    expect((await job(job_id)).status).toBe('queued');
  }, 15_000);
});
