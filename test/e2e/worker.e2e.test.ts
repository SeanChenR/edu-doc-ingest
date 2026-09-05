// docs/DESIGN.md §11.1：成功流程（文字、PDF）、重試成功、重試耗盡、checkpoint、失敗注入。
// api 與 worker 都在測試程序內：POST 建任務，然後直接呼叫 WorkerService.pollOnce()，不靠背景 process。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { INestApplication, INestApplicationContext } from '@nestjs/common';
import request from 'supertest';

import type { WorkerService } from '@/worker/worker.service';

import { ALPHA_KEY, adminQuery, bootApp, bootWorker, resetTenantData } from './helpers';

const PATH = '/v1/workspaces/ws_alpha/documents';
const FIXTURE_PDF = `${import.meta.dir}/../../scripts/fixtures/unit-3-fractions.pdf`;
const STORAGE_ROOT = process.env['STORAGE_ROOT'] ?? './storage';

let app: INestApplication;
let workerCtx: INestApplicationContext;
let worker: WorkerService;
let http: ReturnType<typeof request>;
let n = 0;

beforeAll(async () => {
  // 測試不要等人為延遲；失敗注入要開
  process.env['STAGE_DELAY_MS'] = '0';
  process.env['FAILURE_INJECTION'] = 'true';
  app = await bootApp();
  http = request(app.getHttpServer());
  ({ ctx: workerCtx, worker } = await bootWorker());
  await Bun.write(
    `${STORAGE_ROOT}/ws_alpha/samples/e2e-unit-3.pdf`,
    await Bun.file(FIXTURE_PDF).bytes(),
  );
});
afterAll(async () => {
  await workerCtx.close();
  await app.close();
});
beforeEach(resetTenantData);

async function createDocument(body: object): Promise<{ document_id: string; job_id: string }> {
  const res = await http
    .post(PATH)
    .set('Authorization', `Bearer ${ALPHA_KEY}`)
    .set('Idempotency-Key', `worker-${Date.now()}-${n++}`)
    .send(body);
  expect(res.status).toBe(202);
  return res.body;
}

const textDoc = (content_text: string, name = 'note.txt'): object => ({
  name,
  mime_type: 'text/plain',
  size_bytes: new TextEncoder().encode(content_text).byteLength,
  content_text,
});

// 讓重試中的訊息立刻可見，不用等 set_vt 的退避時間
const makeVisible = (): Promise<unknown> =>
  adminQuery((sql) => sql`update pgmq.q_document_jobs set vt = now()`);

const job = (id: string) =>
  adminQuery(async (sql) => (await sql`select * from jobs where id = ${id}`)[0]);
const doc = (id: string) =>
  adminQuery(async (sql) => (await sql`select * from documents where id = ${id}`)[0]);
const events = (
  jobId: string,
): Promise<
  {
    type: string;
    stage: string | null;
    progress: number;
    attempt: number;
    message: string | null;
  }[]
> =>
  adminQuery(
    (sql) =>
      sql`select type, stage, progress, attempt, message from job_events where job_id = ${jobId} order by id`,
  );
type Count = { n: number };
const queueCounts = () =>
  adminQuery(async (sql) => {
    const q: Count[] = await sql`select count(*)::int as n from pgmq.q_document_jobs`;
    const a: Count[] = await sql`select count(*)::int as n from pgmq.a_document_jobs`;
    return { queued: q[0]?.n ?? 0, archived: a[0]?.n ?? 0 };
  });

describe('worker pipeline', () => {
  test('text document: queued → extracting → embedding → ready with chunks, events and archive', async () => {
    const { document_id, job_id } = await createDocument(
      textDoc('第一段落。\n\n第二段落 hello world.'),
    );
    expect(await worker.pollOnce()).toBe(1);

    const j = await job(job_id);
    expect(j.status).toBe('ready');
    expect(j.progress).toBe(100);
    expect(j.attempt).toBe(1);
    expect(j.started_at).not.toBeNull();
    expect(j.finished_at).not.toBeNull();

    const d = await doc(document_id);
    expect(d.status).toBe('ready');
    expect(d.extracted_text).toBe('第一段落。\n\n第二段落 hello world.');
    expect(d.chunk_count).toBe(1);

    const chunks = await adminQuery(
      (sql) =>
        sql`select chunk_index, content, token_count, vector_dims(embedding) as dims from document_chunks where document_id = ${document_id}`,
    );
    expect(chunks).toEqual([
      {
        chunk_index: 0,
        content: '第一段落。\n\n第二段落 hello world.',
        token_count: expect.any(Number),
        dims: 1536,
      },
    ]);

    expect((await events(job_id)).map((e) => e.type)).toEqual([
      'stage_changed',
      'progress',
      'stage_changed',
      'progress',
      'completed',
    ]);
    expect(await queueCounts()).toEqual({ queued: 0, archived: 1 });
  });

  test('PDF via storage_key: page_count and extracted text', async () => {
    const { document_id, job_id } = await createDocument({
      name: 'unit-3.pdf',
      mime_type: 'application/pdf',
      size_bytes: 877,
      storage_key: 'ws_alpha/samples/e2e-unit-3.pdf',
    });
    await worker.pollOnce();
    expect((await job(job_id)).status).toBe('ready');
    const d = await doc(document_id);
    expect(d.page_count).toBe(2);
    expect(d.extracted_text).toContain('Fractions unit three page two');
    expect(d.chunk_count).toBe(1);
  });

  test('whitespace-only text: ready with zero chunks (D-26)', async () => {
    const { document_id, job_id } = await createDocument(textDoc('   \n  '));
    await worker.pollOnce();
    expect((await job(job_id)).status).toBe('ready');
    expect((await doc(document_id)).chunk_count).toBe(0);
  });

  test('[[FAIL_EMBED_ONCE]]: retry succeeds on attempt 2, extraction checkpoint reused, no duplicate chunks', async () => {
    const { document_id, job_id } = await createDocument(textDoc('[[FAIL_EMBED_ONCE]] retry me'));
    await worker.pollOnce();
    let j = await job(job_id);
    expect(j.status).toBe('queued');
    expect(j.attempt).toBe(1);
    expect(j.last_error_code).toBe('EMBEDDING_PROVIDER_ERROR');
    expect(await queueCounts()).toEqual({ queued: 1, archived: 0 });

    await makeVisible();
    expect(await worker.pollOnce()).toBe(1);
    j = await job(job_id);
    expect(j.status).toBe('ready');
    expect(j.attempt).toBe(2);
    expect(j.last_error_code).toBeNull();

    const ev = await events(job_id);
    expect(ev.filter((e) => e.type === 'retry_scheduled')).toHaveLength(1);
    // 第 2 次沒有重抽：extracted 事件只出現一次，checkpoint 事件出現一次
    expect(ev.filter((e) => e.message === 'text extracted')).toHaveLength(1);
    expect(ev.filter((e) => e.message === 'extraction checkpoint reused')).toHaveLength(1);

    const chunkRows = await adminQuery(
      (sql) => sql`select chunk_index from document_chunks where document_id = ${document_id}`,
    );
    expect(chunkRows).toHaveLength(1);
    expect((await doc(document_id)).chunk_count).toBe(1);
    expect(await queueCounts()).toEqual({ queued: 0, archived: 1 });
  });

  test('[[FAIL_EMBED]]: fails after max_attempts with a sanitized error and an archived message', async () => {
    const { document_id, job_id } = await createDocument(textDoc('[[FAIL_EMBED]] never'));
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await makeVisible();
      await worker.pollOnce();
    }
    const j = await job(job_id);
    expect(j.status).toBe('failed');
    expect(j.attempt).toBe(3);
    expect(j.last_error_code).toBe('EMBEDDING_PROVIDER_ERROR');
    expect(j.last_error_message).not.toMatch(/\n| at |\/Users|dk_/);
    expect((await doc(document_id)).status).toBe('failed');
    const ev = await events(job_id);
    expect(ev.filter((e) => e.type === 'retry_scheduled')).toHaveLength(2);
    expect(ev.at(-1)?.type).toBe('failed');
    expect(await queueCounts()).toEqual({ queued: 0, archived: 1 });
  });

  test('[[FAIL_EXTRACT]] in the name never extracts; missing storage file is STORAGE_READ_FAILED without paths', async () => {
    const a = await createDocument(textDoc('plain', '[[FAIL_EXTRACT]].txt'));
    const b = await createDocument({
      name: 'ghost.pdf',
      mime_type: 'application/pdf',
      size_bytes: 10,
      storage_key: 'ws_alpha/samples/does-not-exist.pdf',
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await makeVisible();
      await worker.pollOnce();
    }
    const ja = await job(a.job_id);
    expect(ja.status).toBe('failed');
    expect(ja.last_error_code).toBe('EXTRACTION_FAILED');
    expect((await doc(a.document_id)).extracted_text).toBeNull();

    const jb = await job(b.job_id);
    expect(jb.status).toBe('failed');
    expect(jb.last_error_code).toBe('STORAGE_READ_FAILED');
    expect(jb.last_error_message).not.toContain('/');
  });

  test('duplicate delivery of a finished job is archived without changes', async () => {
    const { job_id } = await createDocument(textDoc('done once'));
    await worker.pollOnce();
    const before = await job(job_id);
    await adminQuery(
      (sql) => sql`select pgmq.send('document_jobs', ${{ job_id, workspace_id: 'ws_alpha' }})`,
    );
    expect(await worker.pollOnce()).toBe(1);
    const after = await job(job_id);
    expect(after.updated_at).toEqual(before.updated_at);
    expect(await queueCounts()).toEqual({ queued: 0, archived: 2 });
  });
});
