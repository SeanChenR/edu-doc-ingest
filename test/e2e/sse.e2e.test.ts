// docs/DESIGN.md §5.4 SSE、§11.1「SSE 完整流程」「SSE 斷線重連」。
// 用真的 listen 埠 + fetch 串流讀（supertest 不適合長連線）；worker 在同一程序內用 pollOnce() 推進。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import { z } from 'zod';

import type { WorkerService } from '@/worker/worker.service';

import { ALPHA_KEY, BETA_KEY, adminQuery, bootApp, bootWorker, resetTenantData } from './helpers';

const Accepted = z.object({ document_id: z.string(), job_id: z.string() });
const ErrorBody = z.object({ error: z.object({ code: z.string() }) });
const Addr = z.object({ port: z.number() });

interface Frame {
  id?: string;
  event?: string;
  data?: unknown;
  comment?: string;
}

let app: INestApplication;
let workerCtx: INestApplicationContext;
let worker: WorkerService;
let base: string;
let n = 0;

beforeAll(async () => {
  process.env['STAGE_DELAY_MS'] = '0';
  process.env['FAILURE_INJECTION'] = 'true';
  process.env['SSE_PING_INTERVAL_MS'] = '100';
  app = await bootApp();
  await app.listen(0);
  const { port } = Addr.parse(app.getHttpServer().address());
  base = `http://127.0.0.1:${port}`;
  ({ ctx: workerCtx, worker } = await bootWorker());
});
afterAll(async () => {
  await workerCtx.close();
  await app.close();
});
beforeEach(resetTenantData);

async function create(content_text: string): Promise<{ document_id: string; job_id: string }> {
  const res = await fetch(`${base}/v1/workspaces/ws_alpha/documents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ALPHA_KEY}`,
      'Idempotency-Key': `sse-${Date.now()}-${n++}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'sse.txt',
      mime_type: 'text/plain',
      size_bytes: new TextEncoder().encode(content_text).byteLength,
      content_text,
    }),
  });
  expect(res.status).toBe(202);
  return Accepted.parse(await res.json());
}

// 解析 text/event-stream：以空行分隔，`:` 開頭是註解
function parseFrames(text: string): Frame[] {
  return text
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const frame: Frame = {};
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) frame.comment = line.slice(1).trim();
        else if (line.startsWith('id: ')) frame.id = line.slice(4);
        else if (line.startsWith('event: ')) frame.event = line.slice(7);
        else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
      }
      return frame;
    });
}

// 開串流，回傳「收完整個串流（伺服器關閉）」的 promise 與 response 本身
function open(jobId: string, headers: Record<string, string> = {}, key = ALPHA_KEY) {
  const started = fetch(`${base}/v1/jobs/${jobId}/events`, {
    headers: { Authorization: `Bearer ${key}`, ...headers },
  });
  const frames = started.then(async (res) => {
    if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return [];
    return parseFrames(await res.text());
  });
  return { started, frames };
}

const events = (frames: Frame[]): Frame[] => frames.filter((f) => f.event !== undefined);
const makeVisible = (): Promise<unknown> =>
  adminQuery((sql) => sql`update pgmq.q_document_jobs set vt = now()`);

describe('GET /v1/jobs/:jobId/events', () => {
  test('live: snapshot first, then stage/progress events, completed closes the stream; pings in between', async () => {
    const { job_id } = await create('hello world');
    const { started, frames } = open(job_id);
    const res = await started;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    // 讓 ping 有機會出現，再讓 worker 推進
    await Bun.sleep(250);
    await worker.pollOnce();

    const all = await frames;
    const ev = events(all);
    expect(ev[0]).toMatchObject({
      event: 'snapshot',
      data: { job_id, status: 'queued', progress: 0, attempt: 0 },
    });
    expect(ev[0]?.id).toBeUndefined();
    expect(ev.slice(1).map((f) => f.event)).toEqual([
      'stage_changed',
      'progress',
      'stage_changed',
      'progress',
      'completed',
    ]);
    const ids = ev.slice(1).map((f) => BigInt(f.id ?? '0'));
    expect(ids.every((id, i) => i === 0 || id > (ids[i - 1] ?? 0n))).toBe(true);
    expect(ev.at(-1)?.data).toMatchObject({
      job_id,
      status: 'ready',
      progress: 100,
      chunk_count: 1,
    });
    expect(all.some((f) => f.comment === 'ping')).toBe(true);
  });

  test('reconnect with Last-Event-ID replays only what was missed, without duplicates', async () => {
    const { job_id } = await create('hello world');
    await worker.pollOnce();
    const rows: { id: string }[] = await adminQuery(
      (sql) => sql`select id from job_events where job_id = ${job_id} order by id`,
    );
    const secondId = rows[1]?.id ?? '0';

    const ev = events(await open(job_id, { 'Last-Event-ID': secondId }).frames);
    expect(ev[0]).toMatchObject({ event: 'snapshot', data: { status: 'ready' } });
    const replayed = ev.slice(1);
    expect(replayed.map((f) => f.id)).toEqual(rows.slice(2).map((r) => r.id));
    expect(replayed.at(-1)?.event).toBe('completed');
  });

  test('already-terminal job without Last-Event-ID: snapshot + terminal event, then close', async () => {
    const { job_id } = await create('hello world');
    await worker.pollOnce();
    const ev = events(await open(job_id).frames);
    expect(ev.map((f) => f.event)).toEqual(['snapshot', 'completed']);
  });

  test('Last-Event-ID already past the terminal event: snapshot only', async () => {
    const { job_id } = await create('hello world');
    await worker.pollOnce();
    const ev = events(await open(job_id, { 'Last-Event-ID': '999999999' }).frames);
    expect(ev.map((f) => f.event)).toEqual(['snapshot']);
  });

  test('failed job: retry_scheduled events, then failed closes the stream', async () => {
    const { job_id } = await create('[[FAIL_EMBED]] nope');
    const { frames } = open(job_id);
    for (let i = 0; i < 3; i++) {
      if (i > 0) await makeVisible();
      await worker.pollOnce();
    }
    const ev = events(await frames);
    expect(ev.filter((f) => f.event === 'retry_scheduled')).toHaveLength(2);
    expect(ev.at(-1)).toMatchObject({
      event: 'failed',
      data: { status: 'failed', code: 'EMBEDDING_PROVIDER_ERROR', reason: 'MAX_ATTEMPTS_EXCEEDED' },
    });
  });

  test("another workspace's key gets a plain 404 JSON and no stream", async () => {
    const { job_id } = await create('hello world');
    const res = await open(job_id, {}, BETA_KEY).started;
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(ErrorBody.parse(await res.json()).error.code).toBe('NOT_FOUND');
  });
});
