// docs/DESIGN.md §7.3、§11.1「RLS」、D-10：用 app_user 直接下不帶 WHERE 的 SELECT，
// 只看得到 SET LOCAL 的租戶；沒設租戶什麼都看不到；跨租戶寫入被擋。worker_user 有 BYPASSRLS 看得到全部。
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';
import request from 'supertest';
import { z } from 'zod';

import { withTenant } from '@/shared/db/client';

import { ALPHA_KEY, BETA_KEY, bootApp, resetTenantData } from './helpers';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is required`);
  return v;
}

const Accepted = z.object({ document_id: z.string() });

let app: INestApplication;
let http: ReturnType<typeof request>;
let appUser: SQL;
let workerUser: SQL;
let n = 0;

beforeAll(async () => {
  app = await bootApp();
  http = request(app.getHttpServer());
  appUser = new SQL(requireEnv('DATABASE_URL'));
  workerUser = new SQL(requireEnv('DATABASE_URL_WORKER'));
});
afterAll(async () => {
  await appUser.close();
  await workerUser.close();
  await app.close();
});
beforeEach(resetTenantData);

async function createIn(ws: 'ws_alpha' | 'ws_beta', key: string): Promise<string> {
  const res = await http
    .post(`/v1/workspaces/${ws}/documents`)
    .set('Authorization', `Bearer ${key}`)
    .set('Idempotency-Key', `rls-${Date.now()}-${n++}`)
    .send({ name: 'r.txt', mime_type: 'text/plain', size_bytes: 5, content_text: 'hello' });
  expect(res.status).toBe(202);
  return Accepted.parse(res.body).document_id;
}

const workspaceIds = (rows: { workspace_id: string }[]): string[] =>
  rows.map((r) => r.workspace_id).toSorted();

describe('Row-Level Security', () => {
  test('app_user without a tenant setting sees nothing; with SET LOCAL sees only that tenant', async () => {
    await createIn('ws_alpha', ALPHA_KEY);
    await createIn('ws_beta', BETA_KEY);

    // 故意不帶 WHERE workspace_id
    const noTenant: { workspace_id: string }[] = await appUser`select workspace_id from documents`;
    expect(noTenant).toHaveLength(0);

    const alphaOnly = await withTenant(
      appUser,
      'ws_alpha',
      (tx): Promise<{ workspace_id: string }[]> => tx`select workspace_id from documents`,
    );
    expect(workspaceIds(alphaOnly)).toEqual(['ws_alpha']);

    const betaOnly = await withTenant(
      appUser,
      'ws_beta',
      (tx): Promise<{ workspace_id: string }[]> => tx`select workspace_id from jobs`,
    );
    expect(workspaceIds(betaOnly)).toEqual(['ws_beta']);
  });

  test('the tenant setting is transaction-local: it does not leak to the next query on the pool', async () => {
    await createIn('ws_alpha', ALPHA_KEY);
    await withTenant(appUser, 'ws_alpha', (tx) => tx`select 1`);
    const after: unknown[] = await appUser`select id from documents`;
    expect(after).toHaveLength(0);
  });

  test('app_user cannot insert a row for another workspace even inside a tenant transaction', async () => {
    let message = '';
    try {
      await withTenant(
        appUser,
        'ws_alpha',
        (tx) => tx`
          insert into documents (id, workspace_id, name, mime_type, size_bytes, storage_key)
          values ('doc_rls_probe', 'ws_beta', 'x', 'text/plain', 1, 'ws_beta/x.txt')`,
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('row-level security');
    const probe: unknown[] = await workerUser`select id from documents where id = 'doc_rls_probe'`;
    expect(probe).toHaveLength(0);
  });

  test('worker_user (BYPASSRLS) sees every tenant, which is why it still wraps jobs in withTenant', async () => {
    await createIn('ws_alpha', ALPHA_KEY);
    await createIn('ws_beta', BETA_KEY);
    const all: { workspace_id: string }[] = await workerUser`select workspace_id from documents`;
    expect(workspaceIds(all)).toEqual(['ws_alpha', 'ws_beta']);
  });

  test('every tenant table has RLS enabled and forced', async () => {
    const rows: { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[] =
      await workerUser`
        select relname, relrowsecurity, relforcerowsecurity from pg_class
        where relnamespace = 'public'::regnamespace
          and relname in ('documents', 'document_chunks', 'jobs', 'job_events', 'idempotency_keys')
        order by relname`;
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.relrowsecurity).toBe(true);
      expect(r.relforcerowsecurity).toBe(true);
    }
  });
});
