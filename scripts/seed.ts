// docs/DESIGN.md §4.9 — two workspaces, one API key each. Idempotent: re-running keeps the same rows.
// Ready documents + chunks are seeded once the worker pipeline exists (slice 3).
// Usage: bun run seed   (reads DATABASE_URL_ADMIN, SEED_API_KEY_ALPHA, SEED_API_KEY_BETA from .env)

import { SQL } from 'bun';
import { ulid } from 'ulid';
import { z } from 'zod';

const env = z
  .object({
    DATABASE_URL_ADMIN: z.url(),
    SEED_API_KEY_ALPHA: z.string().min(8),
    SEED_API_KEY_BETA: z.string().min(8),
  })
  .parse(process.env);

const workspaces = [
  { id: 'ws_alpha', name: 'Alpha 國中', rawKey: env.SEED_API_KEY_ALPHA, label: 'seed-teacher-a' },
  { id: 'ws_beta', name: 'Beta 高中', rawKey: env.SEED_API_KEY_BETA, label: 'seed-teacher-b' },
];

const sha256 = (s: string): string => new Bun.CryptoHasher('sha256').update(s).digest('hex');

async function main(): Promise<void> {
  const sql = new SQL(env.DATABASE_URL_ADMIN);
  try {
    for (const ws of workspaces) {
      await sql`insert into workspaces (id, name) values (${ws.id}, ${ws.name})
                on conflict (id) do update set name = excluded.name`;
      await sql`insert into api_keys (id, workspace_id, key_hash, label)
                values (${`key_${ulid()}`}, ${ws.id}, ${sha256(ws.rawKey)}, ${ws.label})
                on conflict (key_hash) do update set revoked_at = null, label = excluded.label`;
      // Never print the raw key.
      console.log(`seeded ${ws.id} (${ws.name}) with api key "${ws.label}"`);
    }
  } finally {
    await sql.close();
  }
}

await main();
