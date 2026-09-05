// docs/DESIGN.md §4.9 — 兩個 workspace 各一把 API key，各一份已 ready 的文件（範例 PDF）與 chunks。
// 冪等：重跑不會增加列。文字抽取、切 chunk、向量都用真的 adapter 算（script 裡直接 new，不走 Nest DI）。
// Usage: bun run seed   (reads DATABASE_URL_ADMIN, SEED_API_KEY_ALPHA, SEED_API_KEY_BETA, STORAGE_ROOT from .env)

import { SQL } from 'bun';
import { ulid } from 'ulid';
import { z } from 'zod';

import { FixedWindowChunker } from '@/shared/adapters/chunker/fixed-window.chunker';
import { MockEmbedding } from '@/shared/adapters/embedding/mock.embedding';
import { UnpdfParser } from '@/shared/adapters/parser/unpdf.parser';
import { loadEnv } from '@/shared/config/env';

const seedEnv = z
  .object({
    DATABASE_URL_ADMIN: z.url(),
    SEED_API_KEY_ALPHA: z.string().min(8),
    SEED_API_KEY_BETA: z.string().min(8),
  })
  .parse(process.env);
const env = loadEnv();

const FIXTURE_PDF = `${import.meta.dir}/fixtures/unit-3-fractions.pdf`;

const workspaces = [
  {
    id: 'ws_alpha',
    name: 'Alpha 國中',
    rawKey: seedEnv.SEED_API_KEY_ALPHA,
    label: 'seed-teacher-a',
  },
  { id: 'ws_beta', name: 'Beta 高中', rawKey: seedEnv.SEED_API_KEY_BETA, label: 'seed-teacher-b' },
];

const sha256 = (s: string): string => new Bun.CryptoHasher('sha256').update(s).digest('hex');

async function seedWorkspace(sql: SQL, ws: (typeof workspaces)[number]): Promise<void> {
  await sql`insert into workspaces (id, name) values (${ws.id}, ${ws.name})
            on conflict (id) do update set name = excluded.name`;
  await sql`insert into api_keys (id, workspace_id, key_hash, label)
            values (${`key_${ulid()}`}, ${ws.id}, ${sha256(ws.rawKey)}, ${ws.label})
            on conflict (key_hash) do update set revoked_at = null, label = excluded.label`;
  // 永遠不印明文 key
  console.log(`seeded ${ws.id} (${ws.name}) with api key "${ws.label}"`);
}

// 一份已處理完成的 PDF：檔案放進 storage，資料庫有 document / job / chunks / completed 事件
async function seedReadyDocument(sql: SQL, wsId: string): Promise<void> {
  const parser = new UnpdfParser();
  const chunker = new FixedWindowChunker(env);
  const embedding = new MockEmbedding(env);

  const storageKey = `${wsId}/samples/unit-3-fractions.pdf`;
  const bytes = await Bun.file(FIXTURE_PDF).bytes();
  await Bun.write(`${env.STORAGE_ROOT}/${storageKey}`, bytes);

  const parsed = await parser.parse(bytes, 'application/pdf');
  const chunks = chunker.chunk(parsed.text);
  const vectors = await embedding.embed(chunks.map((c) => c.content));

  // 固定 id 讓重跑冪等（seed 例外於 D-22 的 ULID 規則，與 ws_alpha / ws_beta 同理）
  const docId = `doc_seed_${wsId}_unit3`;
  const jobId = `job_seed_${wsId}_unit3`;

  await sql.begin(async (tx) => {
    await tx`
      insert into documents (id, workspace_id, name, mime_type, size_bytes, storage_key, status,
                             latest_job_id, extracted_text, page_count, chunk_count, metadata)
      values (${docId}, ${wsId}, 'unit-3-fractions.pdf', 'application/pdf', ${bytes.byteLength},
              ${storageKey}, 'ready', ${jobId}, ${parsed.text}, ${parsed.pageCount}, ${chunks.length},
              ${{ grade: 5, subject: 'math', seed: true }})
      on conflict (id) do update
        set extracted_text = excluded.extracted_text, page_count = excluded.page_count,
            chunk_count = excluded.chunk_count, status = 'ready', updated_at = now()`;
    await tx`
      insert into jobs (id, workspace_id, document_id, kind, status, progress, attempt, max_attempts,
                        started_at, finished_at)
      values (${jobId}, ${wsId}, ${docId}, 'ingest', 'ready', 100, 1, ${env.WORKER_MAX_ATTEMPTS}, now(), now())
      on conflict (id) do update set status = 'ready', progress = 100, updated_at = now()`;
    for (const [i, chunk] of chunks.entries()) {
      await tx`
        insert into document_chunks (id, document_id, workspace_id, chunk_index, content, token_count, embedding)
        values (${`chk_${ulid()}`}, ${docId}, ${wsId}, ${chunk.index}, ${chunk.content}, ${chunk.tokenCount},
                ${`[${(vectors[i] ?? []).join(',')}]`}::vector)
        on conflict (document_id, chunk_index) do update
          set content = excluded.content, token_count = excluded.token_count, embedding = excluded.embedding`;
    }
    const existing: { n: number }[] = await tx`
      select count(*)::int as n from job_events where job_id = ${jobId} and type = 'completed'`;
    if ((existing[0]?.n ?? 0) === 0) {
      await tx`
        insert into job_events (job_id, workspace_id, type, stage, progress, attempt, message, payload)
        values (${jobId}, ${wsId}, 'completed', null, 100, 1, 'seeded', ${{ chunk_count: chunks.length }})`;
    }
  });
  console.log(`seeded ${docId}: ${parsed.pageCount} pages, ${chunks.length} chunks`);
}

async function main(): Promise<void> {
  const sql = new SQL(seedEnv.DATABASE_URL_ADMIN);
  try {
    for (const ws of workspaces) {
      await seedWorkspace(sql, ws);
      await seedReadyDocument(sql, ws.id);
    }
  } finally {
    await sql.close();
  }
}

await main();
