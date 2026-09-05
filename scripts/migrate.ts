// docs/DESIGN.md §1.3 / §1.4, docs/DECISIONS.md D-23.
// Usage: bun run migrate   (reads DATABASE_URL_ADMIN, APP_DB_PASSWORD, WORKER_DB_PASSWORD from .env)

import { SQL } from 'bun';
import { z } from 'zod';

const MIGRATIONS_DIR = `${import.meta.dir}/../migrations`;
const MIGRATION_GLOB = new Bun.Glob('[0-9][0-9][0-9]_*.sql');
const INCLUDE_DIRECTIVE = /^--\s*@include\s+(\S+)\s*$/gm;

const adminEnv = z
  .object({
    DATABASE_URL_ADMIN: z.url(),
    APP_DB_PASSWORD: z.string().min(1),
    WORKER_DB_PASSWORD: z.string().min(1),
  })
  .parse(process.env);

type Migration = { version: number; name: string; file: string };

async function listMigrations(): Promise<Migration[]> {
  const names = await Array.fromAsync(MIGRATION_GLOB.scan({ cwd: MIGRATIONS_DIR }));
  return names
    .map((name) => ({ version: Number(name.slice(0, 3)), name, file: `${MIGRATIONS_DIR}/${name}` }))
    .toSorted((a, b) => a.version - b.version);
}

// `-- @include path/relative/to/migrations` splices another SQL file in place (used for pgmq.sql).
async function readSql(file: string): Promise<string> {
  const raw = await Bun.file(file).text();
  const parts: string[] = [];
  let last = 0;
  for (const m of raw.matchAll(INCLUDE_DIRECTIVE)) {
    const include = m[1] ?? '';
    parts.push(raw.slice(last, m.index), await Bun.file(`${MIGRATIONS_DIR}/${include}`).text());
    last = m.index + m[0].length;
  }
  parts.push(raw.slice(last));
  return parts.join('\n');
}

// Roles are environment-level: created here, passwords from env, never in .sql (D-23).
async function ensureRoles(sql: SQL): Promise<void> {
  const roles = [
    { name: 'app_user', password: adminEnv.APP_DB_PASSWORD, extra: 'NOBYPASSRLS' },
    { name: 'worker_user', password: adminEnv.WORKER_DB_PASSWORD, extra: 'BYPASSRLS' },
  ];
  for (const r of roles) {
    // Password is bound as a parameter into a session setting, then quoted by format(%L):
    // no string interpolation of secrets into SQL text.
    await sql`select set_config('migrate.role_password', ${r.password}, false)`;
    await sql.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${r.name}') THEN
          EXECUTE 'CREATE ROLE ${r.name} LOGIN';
        END IF;
        EXECUTE format('ALTER ROLE ${r.name} WITH LOGIN ${r.extra} PASSWORD %L',
                       current_setting('migrate.role_password'));
      END
      $$;
    `);
    await sql`select set_config('migrate.role_password', '', false)`;
  }
}

async function main(): Promise<void> {
  const sql = new SQL(adminEnv.DATABASE_URL_ADMIN);
  try {
    await ensureRoles(sql);
    console.log('roles ok: app_user, worker_user');

    await sql`create table if not exists schema_migrations (
      version int primary key,
      name text not null,
      applied_at timestamptz not null default now()
    )`;
    const rows: { version: number }[] = await sql`select version from schema_migrations`;
    const applied = new Set(rows.map((r) => r.version));

    for (const m of await listMigrations()) {
      if (applied.has(m.version)) {
        console.log(`skip    ${m.name}`);
        continue;
      }
      const body = await readSql(m.file);
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (version, name) values (${m.version}, ${m.name})`;
      });
      console.log(`applied ${m.name}`);
    }
  } finally {
    await sql.close();
  }
}

await main();
