// docs/DESIGN.md §11.1：驗證錯誤、租戶隔離（路徑）、冪等、401。成功流程的後半（ready）在 slice 3。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { ALPHA_KEY, BETA_KEY, adminQuery, bootApp, resetTenantData } from './helpers';

const PATH = '/v1/workspaces/ws_alpha/documents';
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const validBody = {
  name: 'unit-3.txt',
  mime_type: 'text/plain',
  size_bytes: 11,
  content_text: 'hello world',
  metadata: { grade: 5 },
};

let app: INestApplication;
let http: ReturnType<typeof request>;
let keyCounter = 0;
const nextKey = (): string => `key-${Date.now()}-${keyCounter++}`;

beforeAll(async () => {
  app = await bootApp();
  http = request(app.getHttpServer());
});
afterAll(async () => {
  await app.close();
});
beforeEach(resetTenantData);

const post = (
  body: object,
  // null = 刻意不帶 Idempotency-Key（undefined 會觸發預設參數）
  key: string | null = nextKey(),
  apiKey = ALPHA_KEY,
  path = PATH,
) => {
  const req = http.post(path).set('Authorization', `Bearer ${apiKey}`).send(body);
  return key === null ? req : req.set('Idempotency-Key', key);
};

type ErrorBody = { error: Record<string, unknown> };
// 比對兩個錯誤 body 時忽略 request_id
const strip = (b: ErrorBody): ErrorBody => ({ ...b, error: { ...b.error, request_id: 'X' } });

function expectError(res: request.Response, status: number, code: string): void {
  expect(res.status).toBe(status);
  expect(res.body.error.code).toBe(code);
  expect(typeof res.body.error.message).toBe('string');
  expect(res.body.error.request_id).toMatch(/^req_/);
  expect(res.headers['x-request-id']).toBe(res.body.error.request_id);
}

describe('POST /v1/workspaces/:workspaceId/documents', () => {
  test('202 with document_id, job_id, status, request_id; rows and queue message exist', async () => {
    const res = await post(validBody);
    expect(res.status).toBe(202);
    expect(res.body.document_id).toMatch(/^doc_/);
    expect(res.body.job_id).toMatch(/^job_/);
    expect(res.body.status).toBe('queued');
    expect(res.body.request_id).toMatch(/^req_/);
    expect(res.headers['x-request-id']).toBe(res.body.request_id);

    const { docs, jobs, msgs } = await adminQuery(async (sql) => {
      const docs = await sql`select * from documents`;
      const jobs = await sql`select * from jobs`;
      const msgs = await sql`select message from pgmq.q_document_jobs`;
      return { docs, jobs, msgs };
    });
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe('pending');
    expect(docs[0].storage_key).toBe(`ws_alpha/inline/${res.body.document_id}.txt`);
    expect(docs[0].metadata).toEqual({ grade: 5 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('queued');
    expect(jobs[0].queue_msg_id).not.toBeNull();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toEqual({ job_id: res.body.job_id, workspace_id: 'ws_alpha' });
  });

  test('client-supplied X-Request-Id (ULID) is echoed; garbage is replaced', async () => {
    const ulid = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const ok = await post(validBody).set('X-Request-Id', ulid);
    expect(ok.body.request_id).toBe(ulid);
    const bad = await post(validBody).set('X-Request-Id', 'not-an-id');
    expect(bad.body.request_id).toMatch(/^req_/);
    expect(ULID_RE.test(bad.body.request_id.slice(4))).toBe(true);
  });

  describe('validation errors (§6.3)', () => {
    test('missing field → 400 VALIDATION_ERROR with details', async () => {
      const { name: _name, ...noName } = validBody;
      const res = await post(noName);
      expectError(res, 400, 'VALIDATION_ERROR');
      expect(res.body.error.details).toEqual([{ field: 'name', issue: expect.any(String) }]);
    });

    test('missing Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
      expectError(await post(validBody, null), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    });

    test('both / neither content source → 400 CONTENT_SOURCE_INVALID', async () => {
      expectError(
        await post({ ...validBody, storage_key: 'ws_alpha/x.txt' }),
        400,
        'CONTENT_SOURCE_INVALID',
      );
      const { content_text: _t, ...neither } = validBody;
      expectError(await post(neither), 400, 'CONTENT_SOURCE_INVALID');
    });

    test('wrong MIME → 415 UNSUPPORTED_MEDIA_TYPE', async () => {
      expectError(
        await post({ ...validBody, mime_type: 'image/png' }),
        415,
        'UNSUPPORTED_MEDIA_TYPE',
      );
    });

    test('size_bytes over limit → 413 DOCUMENT_TOO_LARGE', async () => {
      expectError(await post({ ...validBody, size_bytes: 10_485_761 }), 413, 'DOCUMENT_TOO_LARGE');
    });

    test('size_bytes off by more than 5% → 422 SIZE_MISMATCH', async () => {
      expectError(await post({ ...validBody, size_bytes: 20 }), 422, 'SIZE_MISMATCH');
    });

    test('storage_key with .., leading /, backslash, or foreign prefix → 400 INVALID_STORAGE_KEY', async () => {
      const { content_text: _t, ...base } = validBody;
      for (const storage_key of [
        'ws_alpha/../etc/passwd',
        '/ws_alpha/a.txt',
        'ws_alpha\\a.txt',
        'ws_beta/a.txt',
      ]) {
        expectError(await post({ ...base, storage_key }), 400, 'INVALID_STORAGE_KEY');
      }
    });

    test('valid storage_key under own workspace → 202 without touching storage', async () => {
      const { content_text: _t, ...base } = validBody;
      const res = await post({ ...base, storage_key: 'ws_alpha/2026/09/unit-3.txt' });
      expect(res.status).toBe(202);
    });

    test('metadata over 4 KB → 400 VALIDATION_ERROR', async () => {
      const res = await post({ ...validBody, metadata: { blob: 'x'.repeat(5000) } });
      expectError(res, 400, 'VALIDATION_ERROR');
      expect(res.body.error.details[0].field).toBe('metadata');
    });

    test('invalid JSON body → 400 VALIDATION_ERROR', async () => {
      const res = await http
        .post(PATH)
        .set('Authorization', `Bearer ${ALPHA_KEY}`)
        .set('Idempotency-Key', nextKey())
        .set('Content-Type', 'application/json')
        .send('{"name":');
      expectError(res, 400, 'VALIDATION_ERROR');
    });

    test('body larger than the parser limit → 413 DOCUMENT_TOO_LARGE', async () => {
      const res = await post({ ...validBody, content_text: 'x'.repeat(10_485_760 + 70_000) });
      expectError(res, 413, 'DOCUMENT_TOO_LARGE');
    });
  });

  describe('auth and tenant scope', () => {
    test('missing / malformed / unknown API key → 401 UNAUTHORIZED', async () => {
      expectError(
        await http.post(PATH).set('Idempotency-Key', nextKey()).send(validBody),
        401,
        'UNAUTHORIZED',
      );
      expectError(await post(validBody, nextKey(), 'nope'), 401, 'UNAUTHORIZED');
      const basic = await http
        .post(PATH)
        .set('Authorization', 'Basic abc')
        .set('Idempotency-Key', nextKey())
        .send(validBody);
      expectError(basic, 401, 'UNAUTHORIZED');
    });

    test("ws_alpha key posting to ws_beta's path → 404, body identical to an unknown route", async () => {
      const cross = await post(validBody, nextKey(), ALPHA_KEY, '/v1/workspaces/ws_beta/documents');
      expectError(cross, 404, 'NOT_FOUND');
      const missing = await post(validBody, nextKey(), ALPHA_KEY, '/v1/workspaces/ws_alpha/nope');
      expectError(missing, 404, 'NOT_FOUND');
      expect(strip(cross.body)).toEqual(strip(missing.body));
    });

    test('ws_beta key with its own path works', async () => {
      const res = await post(validBody, nextKey(), BETA_KEY, '/v1/workspaces/ws_beta/documents');
      expect(res.status).toBe(202);
    });
  });

  describe('idempotency (§8)', () => {
    test('same key + same body → same ids, Idempotent-Replayed, one row per table', async () => {
      const key = nextKey();
      const first = await post(validBody, key);
      const second = await post(validBody, key);
      expect(second.status).toBe(202);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.document_id).toBe(first.body.document_id);
      expect(second.body.job_id).toBe(first.body.job_id);
      expect(first.headers['idempotent-replayed']).toBeUndefined();

      const counts = await adminQuery(
        (sql) =>
          sql`select (select count(*)::int from documents) as docs,
                   (select count(*)::int from jobs) as jobs,
                   (select count(*)::int from idempotency_keys) as keys,
                   (select count(*)::int from pgmq.q_document_jobs) as msgs`,
      );
      expect(counts[0]).toEqual({ docs: 1, jobs: 1, keys: 1, msgs: 1 });
    });

    test('same key + different body → 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const key = nextKey();
      await post(validBody, key);
      expectError(
        await post({ ...validBody, name: 'other.txt' }, key),
        409,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });

    test('key order in body does not change the hash', async () => {
      const key = nextKey();
      const a = await post(validBody, key);
      const reordered = {
        metadata: { grade: 5 },
        content_text: 'hello world',
        size_bytes: 11,
        mime_type: 'text/plain',
        name: 'unit-3.txt',
      };
      const b = await post(reordered, key);
      expect(b.status).toBe(202);
      expect(b.body.document_id).toBe(a.body.document_id);
    });

    test('10 concurrent identical requests → one document', async () => {
      const key = nextKey();
      const results = await Promise.all(Array.from({ length: 10 }, () => post(validBody, key)));
      for (const r of results) expect(r.status).toBe(202);
      const ids = new Set(results.map((r) => r.body.document_id));
      expect(ids.size).toBe(1);
      const docs = await adminQuery((sql) => sql`select count(*)::int as n from documents`);
      expect(docs[0].n).toBe(1);
    });

    test('key is scoped per workspace', async () => {
      const key = nextKey();
      const a = await post(validBody, key);
      const b = await post(validBody, key, BETA_KEY, '/v1/workspaces/ws_beta/documents');
      expect(b.status).toBe(202);
      expect(b.body.document_id).not.toBe(a.body.document_id);
    });
  });
});

describe('health (public)', () => {
  test('/health and /ready without auth → 200 with request_id', async () => {
    const h = await http.get('/health');
    expect(h.status).toBe(200);
    expect(h.body).toEqual({ status: 'ok', request_id: expect.stringMatching(/^req_/) });
    const r = await http.get('/ready');
    expect(r.status).toBe(200);
  });
});
