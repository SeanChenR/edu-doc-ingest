import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

// docs/DESIGN.md §13 — one schema for api and worker; Bun loads .env automatically.
export const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url(),
  DATABASE_URL_WORKER: z.url(),
  DB_CONNECT_RETRY_SEC: z.coerce.number().int().positive().default(30),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // 本機開發用 pino-pretty 輸出可讀格式；正式環境保持 JSON（false）
  LOG_PRETTY: bool,
  // 設了就把 log 寫到這個檔案（同步寫入）；測試用它抓 pino 輸出驗證 redaction，正式環境可留空走 stdout
  LOG_FILE: z.string().min(1).optional(),

  MAX_DOCUMENT_BYTES: z.coerce.number().int().positive().default(10_485_760),
  ALLOWED_MIME_TYPES: z
    .string()
    .default('application/pdf,text/plain,text/markdown')
    .transform((v) => v.split(',').map((s) => s.trim())),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),

  STORAGE_ROOT: z.string().default('./storage'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  // D-26 chunk 視窗與重疊（字元）
  CHUNK_SIZE: z.coerce.number().int().min(50).default(1000),
  CHUNK_OVERLAP: z.coerce.number().int().nonnegative().default(200),
  STAGE_DELAY_MS: z.coerce.number().int().nonnegative().default(800),
  FAILURE_INJECTION: bool,

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  WORKER_VISIBILITY_TIMEOUT_SEC: z.coerce.number().int().positive().default(60),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  // 單次 attempt 的時間上限；逾時視為該次失敗，走 §9.4 的重試
  JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // worker 主迴圈每輪 touch 一次，給容器 healthcheck 看 mtime 用
  WORKER_HEARTBEAT_FILE: z.string().default('./storage/.worker-heartbeat'),

  SSE_PING_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
