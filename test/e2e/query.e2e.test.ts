// docs/DESIGN.md §5.3 GET document、§5.4 GET job、§11.1 租戶隔離（ws_beta 的 key 讀 ws_alpha 的資源 → 404 且 body 相同）
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';
import { z } from 'zod';

import type { WorkerService } from '@/worker/worker.service';

import { ALPHA_KEY, BETA_KEY, adminQuery, bootApp, bootWorker, resetTenantData } from './helpers';

const Accepted = z.object({ document_id: z.string(), job_id: z.string() });

let app: INestApplication;
let workerCtx: INestApplicationContext;
let worker: WorkerService;
let http: ReturnType<typeof request>;
let n = 0;

beforeAll(async () => {
  process.env['STAGE_DELAY_MS'] = '0';
  process.env['FAILURE_INJECTION'] = 'true';
  app = await bootApp();
  http = request(app.getHttpServer());
  ({ ctx: workerCtx, worker } = await bootWorker());
});
afterAll(async () => {
  await workerCtx.close();
  await app.close();
});
beforeEach(resetTenantData);

const get = (path: string, key = ALPHA_KEY) => http.get(path).set('Authorization', `Bearer ${key}`);

async function create(content_text: string, extra: object = {}) {
  const res = await http
    .post('/v1/workspaces/ws_alpha/documents')
    .set('Authorization', `Bearer ${ALPHA_KEY}`)
    .set('Idempotency-Key', `q-${Date.now()}-${n++}`)
    .send({
      name: 'q.txt',
      mime_type: 'text/plain',
      size_bytes: new TextEncoder().encode(content_text).byteLength,
      content_text,
      ...extra,
    });
  expect(res.status).toBe(202);
  return Accepted.parse(res.body);
}

const stripRequestId = (body: { error: Record<string, unknown> }) => ({
  ...body,
  error: { ...body.error, request_id: 'X' },
});

describe('GET /v1/jobs/:jobId', () => {
  test('queued job before the worker picks it up', async () => {
    const { document_id, job_id } = await create('hello');
    const res = await get(`/v1/jobs/${job_id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: job_id,
      workspace_id: 'ws_alpha',
      document_id,
      kind: 'ingest',
      status: 'queued',
      progress: 0,
      attempt: 0,
      max_attempts: 3,
      retries_used: 0,
      last_error: null,
      started_at: null,
      finished_at: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
      request_id: expect.stringMatching(/^req_/),
    });
  });

  test('ready job after processing; failed job exposes last_error and retries_used', async () => {
    const ok = await create('hello');
    const bad = await create('[[FAIL_EMBED]] nope');
    for (let i = 0; i < 3; i++) {
      await worker.pollOnce();
      await adminQuery((sql) => sql`update pgmq.q_document_jobs set vt = now()`);
    }
    const ready = await get(`/v1/jobs/${ok.job_id}`);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.progress).toBe(100);
    expect(ready.body.retries_used).toBe(0);
    expect(ready.body.finished_at).toEqual(expect.any(String));

    const failed = await get(`/v1/jobs/${bad.job_id}`);
    expect(failed.body.status).toBe('failed');
    expect(failed.body.attempt).toBe(3);
    expect(failed.body.retries_used).toBe(2);
    expect(failed.body.last_error).toEqual({
      code: 'EMBEDDING_PROVIDER_ERROR',
      message: expect.stringContaining('[[FAIL_EMBED]]'),
    });
  });

  test("another workspace's key and an unknown id both get the same 404 body", async () => {
    const { job_id } = await create('hello');
    const cross = await get(`/v1/jobs/${job_id}`, BETA_KEY);
    const missing = await get('/v1/jobs/job_does_not_exist');
    expect(cross.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(stripRequestId(cross.body)).toEqual(stripRequestId(missing.body));
    expect(cross.body.error.code).toBe('NOT_FOUND');
  });
});

describe('GET /v1/documents/:documentId', () => {
  test('pending document has latest_job and result null; ready document has result', async () => {
    const { document_id, job_id } = await create('第三單元 分數的加法', { metadata: { grade: 5 } });
    const pending = await get(`/v1/documents/${document_id}`);
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({
      id: document_id,
      workspace_id: 'ws_alpha',
      name: 'q.txt',
      mime_type: 'text/plain',
      status: 'pending',
      page_count: null,
      chunk_count: null,
      metadata: { grade: 5 },
      latest_job: { id: job_id, status: 'queued', progress: 0, attempt: 0, finished_at: null },
      result: null,
    });

    await worker.pollOnce();
    const ready = await get(`/v1/documents/${document_id}`);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.chunk_count).toBe(1);
    expect(ready.body.latest_job).toMatchObject({
      id: job_id,
      status: 'ready',
      progress: 100,
      attempt: 1,
    });
    expect(ready.body.result).toEqual({
      text_preview: '第三單元 分數的加法',
      embedding_model: 'mock-1536',
      embedding_dimensions: 1536,
    });
    expect(ready.body.request_id).toMatch(/^req_/);
  });

  test('text_preview is capped at 500 characters', async () => {
    const long = 'x'.repeat(1200);
    const { document_id } = await create(long);
    await worker.pollOnce();
    const res = await get(`/v1/documents/${document_id}`);
    expect(res.body.result.text_preview).toHaveLength(500);
  });

  test("another workspace's key and an unknown id both get the same 404 body", async () => {
    const { document_id } = await create('hello');
    const cross = await get(`/v1/documents/${document_id}`, BETA_KEY);
    const missing = await get('/v1/documents/doc_does_not_exist');
    expect(cross.status).toBe(404);
    expect(stripRequestId(cross.body)).toEqual(stripRequestId(missing.body));
  });
});
