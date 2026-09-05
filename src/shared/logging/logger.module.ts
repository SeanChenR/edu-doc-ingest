import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';

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

// 本機開發：in-process 的 pino-pretty stream（不用 transport 的 worker thread，Bun 上較穩）。
// 正式環境 LOG_PRETTY=false，輸出原生 JSON 給 Cloud Logging。
// 用動態 import：pino-pretty 若進靜態 import 圖，`bun --bun` 下會改變模組評估順序，
// 讓 nestjs-pino（CJS）在 @nestjs/common（ESM）評估完成前 require 它而失敗。
async function prettyStream(): Promise<DestinationStream> {
  const { default: pinoPretty } = await import('pino-pretty');
  return pinoPretty({
    colorize: true,
    translateTime: 'SYS:HH:MM:ss.l',
    ignore: 'pid,hostname,context,req,res,responseTime',
    messageFormat: '[{context}] {msg}',
  });
}

export const LoggerModule = PinoLoggerModule.forRootAsync({
  inject: [ENV],
  useFactory: async (env: Env) => {
    const options = {
      level: env.LOG_LEVEL,
      // request id 由 RequestIdMiddleware 決定並寫進回應標頭，這裡沿用同一個值
      genReqId: (_req: unknown, res: { getHeader(name: string): unknown }) => {
        const id = res.getHeader('X-Request-Id');
        return typeof id === 'string' ? id : '';
      },
      autoLogging: { ignore: (req: { url?: string }) => HEALTH_PATHS.has(req.url ?? '') },
      redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    };
    return { pinoHttp: env.LOG_PRETTY ? [options, await prettyStream()] : options };
  },
});
