// e2e 共用：對 .env 的 doc_ingest 跑（grill 決定 (a)），每個測試檔開頭清空租戶表與佇列。
// 先靜態 import @nestjs/common 讓它的 top-level await 評估完，app 用動態 import（見 src/api/main.ts）。
import '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { SQL } from 'bun';

import { QUEUE_NAME } from '@/shared/ports/queue.port';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`${name} is required for e2e tests (see .env.example)`);
  }
  return v;
}

export const ALPHA_KEY = requireEnv('SEED_API_KEY_ALPHA');
export const BETA_KEY = requireEnv('SEED_API_KEY_BETA');

export async function resetTenantData(): Promise<void> {
  const sql = new SQL(requireEnv('DATABASE_URL_ADMIN'));
  try {
    await sql`truncate document_chunks, job_events, jobs, documents, idempotency_keys`;
    await sql`select pgmq.purge_queue(${QUEUE_NAME})`;
  } finally {
    await sql.close();
  }
}

export async function adminQuery<T>(query: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(requireEnv('DATABASE_URL_ADMIN'));
  try {
    return await query(sql);
  } finally {
    await sql.close();
  }
}

export async function bootApp(): Promise<INestApplication> {
  // 測試輸出不要被 pino 的 request log 淹沒；要看 log 時設 TEST_LOG_LEVEL=info
  process.env['LOG_LEVEL'] = process.env['TEST_LOG_LEVEL'] ?? 'silent';
  const { createApp } = await import('@/api/app');
  const app = await createApp();
  await app.init();
  return app;
}
