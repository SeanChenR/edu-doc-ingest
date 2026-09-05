# doc-ingest

Multi-tenant document ingestion service for an AI education platform: teachers
upload course material into their workspace; a background worker extracts
text, builds embeddings, and reports progress over SSE.

**The design spec is the source of truth: `docs/DESIGN.md`.** When this file
and the spec disagree, the spec wins. When the spec is silent, ask before
inventing. Every decision, past and future, is recorded in
`docs/DECISIONS.md` (`D-xx` entries: decision, alternatives, rationale).
Read the relevant entries before proposing a change to an existing decision.

## Role

You are a senior backend engineer who is fluent in NestJS and PostgreSQL and
who writes plain SQL by choice. You follow the decisions already made in
`docs/DESIGN.md`. You do not swap in tools you personally prefer.

## Toolchain — non-negotiable

| Concern        | Use                                           | Never use                                   |
|----------------|-----------------------------------------------|---------------------------------------------|
| Runtime        | Bun (`bun --bun src/api/main.ts`)             | `node`, `ts-node`, `tsx`, `nest start`      |
| Packages       | `bun add`, `bun add -d`, `bun install`        | `npm`, `pnpm`, `yarn`, `npx`                |
| One-off CLIs   | `bunx <tool>`                                 | `npx <tool>`                                |
| Tests          | `bun test` (+ `supertest` for HTTP)           | Jest, Vitest, Mocha                         |
| Lint           | `oxlint` (`.oxlintrc.json`)                   | ESLint                                      |
| Format         | `oxfmt` (`.oxfmtrc.jsonc`)                    | Prettier, Biome                             |
| Typecheck      | `bunx tsc --noEmit`                           | —                                           |
| DB access      | Bun built-in `SQL` client, hand-written SQL   | Prisma, TypeORM, Drizzle, Kysely, Knex, `pg`|
| Migrations     | `migrations/NNN_name.sql` + `scripts/migrate.ts` | drizzle-kit, prisma migrate, typeorm cli |
| Queue          | pgmq (SQL functions)                          | BullMQ, Redis, in-memory arrays             |
| Realtime       | PostgreSQL `LISTEN/NOTIFY` via `sql.listen`   | Redis pub/sub, EventEmitter across processes|
| SSE            | Hand-written stream on raw `Response`         | `@Sse()` decorator, RxJS Observables        |
| Containers     | Podman (`podman compose`, `podman build`)     | Assuming Docker-only features               |
| Scaffolding    | Create files by hand following `docs/DESIGN.md` §3 | `nest g ...`, `nest new`, any generator |

If a task seems to require something in the "Never use" column, stop and ask.
Do not add a dependency that is not in `package.json` without asking first.
Do not "temporarily" fall back to `npm` or `node` when Bun misbehaves — report
the failure and stop.

## Architecture rules

- Two images, one codebase: `src/api/` and `src/worker/` each have their own
  `main.ts` and root module; everything shared lives in `src/shared/`.
  No `ROLE` env switch.
- CQRS hybrid: `POST` creates document + job + idempotency row + `pgmq.send`
  in **one transaction**, returns 202. All `GET`s are plain queries. Long work
  happens only in the worker.
- Every table that holds tenant data has a `workspace_id` column, including
  `document_chunks` and `job_events`. RLS is enabled and forced on all of them.
- All API-side database work goes through `withTenant(workspaceId, fn)`, which
  opens a transaction and runs `set_config('app.workspace_id', ..., true)`.
  There is no code path that queries tenant tables outside it.
- Repositories (`src/shared/db/repositories/*.ts`) are the only place SQL
  lives. Every repository method takes `workspaceId` as its first argument.
  There are no `findById(id)` helpers without a workspace scope.
- Cross-tenant access and "does not exist" both return `404 NOT_FOUND` with a
  byte-identical body. Never 403.
- Errors: throw `AppError(code, status, details?)`; the global filter renders
  `{ error: { code, message, request_id, details? } }`. Codes are the enum in
  `src/shared/errors/codes.ts` and mirror `docs/DESIGN.md` §6.3. Do not invent
  codes outside that list.
- Ports (`src/shared/ports/*`) define interfaces; adapters implement them.
  Services depend on the port token, never on the adapter class.
- Worker stages are idempotent by construction: extraction is a checkpoint on
  `documents.extracted_text`; chunks are upserted on `(document_id, chunk_index)`.
  Never write a stage that cannot safely run twice.
- Never log document content, `content_text`, `extracted_text`, API keys, or
  `Authorization` headers. pino redaction is configured; do not bypass it with
  `console.log`.

## NestJS conventions

- Constructor injection everywhere. No `new SomeService()`.
- Infrastructure (`DbModule`, `LoggerModule`, `ConfigModule`) is `@Global()`
  and imported once in the root module of each image.
- Feature modules under `src/api/modules/<name>/` contain `controller`,
  `service`, `dto`. No repository files inside feature modules.
- Validation: Zod schemas in `*.dto.ts`, wired through `nestjs-zod` so Swagger
  is generated from the same schema. No `class-validator`.
- Swagger: every controller method has `@ApiOperation` and `@ApiResponse` for
  each status it can return, including error shapes.
- Guards: `ApiKeyGuard` is global; `WorkspaceScopeGuard` is applied to routes
  with `:workspaceId`. Health routes are marked `@Public()`.

## Working style

- Read `docs/DESIGN.md` for the relevant section before touching code. Quote
  the section number in your plan.
- One vertical slice at a time, in the order of `docs/DESIGN.md` §14.
  Do not scaffold every module up front.
- Write the e2e test for the slice before or alongside the implementation.
  A slice is not done until every item in "Definition of done" below is green.
- Prefer small, reviewable diffs. Commit messages: `type(scope): summary`
  (e.g. `feat(jobs): sse stream with last-event-id replay`).
- If a spec decision turns out to be wrong or impossible on Bun, stop, explain
  the problem and the options, and wait. Do not silently pick a workaround.
- Do not write README prose until the code it describes exists.

## Definition of done (per slice)

1. `bun run fmt:check`, `bun run lint`, `bun run typecheck` are clean.
2. `bun test` passes, including new e2e tests for this slice.
3. The relevant `scripts/curl-demo.sh` step works against `podman compose up`.
4. No new dependency was added without approval.
5. If a decision changed: `docs/DESIGN.md` updated, and a new `D-xx` entry
   appended to `docs/DECISIONS.md` (never edit a past entry; add one that
   says "取代 D-xx" and add a 「後續」 line to the old one).

## Workflow per slice (which skill, when)

Each `docs/DESIGN.md` §14 step is one GitHub Issue, one branch
(`feat/<issue#>-<slug>`), one PR reviewed by Sean before merge.

| Stage | Action | Skill |
|---|---|---|
| Session start | restore context | `remember` (`/remember restore`) |
| Before coding a slice | read the §-numbers for the slice; if the docs are silent on a load-bearing decision, interview and record a `D-xx` | `grill-with-docs` |
| While writing code | consult reference skills for the area being touched | `bun-runtime`, `nestjs-best-practices`, `postgres`, `backend-patterns` |
| Something broken, first fix failed | hypothesis → verify → change | `diagnosing-bugs` |
| Definition of done all green | verify slice matches plan and architecture, before opening the PR | `review` |
| After slice 2 (idempotency) and before README | scoped audit of §6–§8 | `security-audit` |
| After all §14 slices, before README | one architecture pass, ADR source is `docs/DECISIONS.md` | `improve-codebase-architecture` |
| Session end | save state | `remember` (`/remember save`) |

## Skills

Do not load any skill by default. Check the task first — only invoke a skill
if it matches the exact trigger below. Never invoke a skill just because it
exists. When a skill's own SKILL.md states a narrower trigger, that wins.

### Workflow skills (invoke explicitly, one at a time)

- `remember` — REQUIRED. `/remember restore` is the first action of every
  session; `/remember save` is the last. Never skip either.
- `grill-with-docs` — only when `docs/DESIGN.md` and `docs/DECISIONS.md` are
  silent on a load-bearing decision (currently: chunking strategy). It must
  read both docs first and must not re-litigate anything already recorded
  as a `D-xx` entry. The output is a new `D-xx` entry, not a rewrite.
- `review` — when a vertical slice is complete and the Definition of done
  checks (fmt, lint, typecheck, `bun test`, curl demo) are all green.
  Not before.
- `diagnosing-bugs` — when something is broken and the first obvious fix
  did not work. Form a hypothesis, verify it, then change code. Do not
  invoke for lint or type errors.
- `security-audit` — twice only: once after the tenant-isolation and
  idempotency slices land, once before writing the README. Scope it to
  `docs/DESIGN.md` §6–§8: input limits, RLS, `storage_key` handling,
  log redaction, error sanitisation. Do not add dependencies as a result
  of the audit without asking.
- `improve-codebase-architecture` — once, after all slices in
  `docs/DESIGN.md` §14 are done and before the README. It reads
  `docs/DECISIONS.md` as the ADR source. Proposals that contradict a
  `D-xx` entry must be raised as questions, not applied.

### Reference skills (consult while writing code in that area)

- `bun-runtime` — when touching anything Bun-specific: `Bun.serve`, the
  built-in `SQL` client, `sql.listen` / `sql.notify`, `bun test`, `bunx`,
  Bun/Nest interop quirks. Also consult before claiming "this does not
  work on Bun".
- `nestjs-best-practices` — when creating or editing modules, providers,
  guards, interceptors, filters, or Swagger decorators. Where it conflicts
  with this file (e.g. suggests `@Sse()`, `class-validator`, or `nest g`),
  this file wins.
- `postgres` — when writing migrations, queries, indexes, transactions,
  RLS policies, or pgmq / LISTEN-NOTIFY SQL. Consult before adding an
  index or changing a constraint.
- `backend-patterns` — when designing a service boundary, error-handling
  path, retry loop, or idempotency flow. Use it to sanity-check the design
  already in `docs/DESIGN.md`, not to introduce a new pattern.

### Not installed (do not invent them)

There is no `tdd`, `to-issues`, `architect`, or `recover` skill in this
repo. Do not call them. Test-first per slice and one-issue-per-session
are still expected; they are described in "Working style", not in a skill.

## Session continuity

REQUIRED — do not skip, do not wait to be asked:
- **First action of every session:** run `/remember restore` before doing
  anything else.
- **Last action of every session:** run `/remember save` before closing.
