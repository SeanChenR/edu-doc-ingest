import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';

// docs/DESIGN.md §7.4：pino 的 redaction 在 logger 設定層做，不靠每個呼叫點記得。
// pino 的 redact 只支援路徑，不支援「鍵名含 key/token/secret」的模糊比對，所以列明確路徑；
// 新增會出現在 log 裡的敏感欄位時，在這裡補一行。
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.content_text',
  'req.body.extracted_text',
  '*.content_text',
  '*.extracted_text',
  '*.api_key',
  '*.apiKey',
  '*.key_hash',
  '*.token',
  '*.secret',
  '*.password',
];

const HEALTH_PATHS = new Set(['/health', '/ready']);

export const LoggerModule = PinoLoggerModule.forRootAsync({
  inject: [ENV],
  useFactory: (env: Env) => ({
    pinoHttp: {
      level: env.LOG_LEVEL,
      // request id 由 RequestIdMiddleware 決定並寫進回應標頭，這裡沿用同一個值
      genReqId: (_req, res) => String(res.getHeader('X-Request-Id') ?? ''),
      autoLogging: { ignore: (req) => HEALTH_PATHS.has(req.url ?? '') },
      redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    },
  }),
});
