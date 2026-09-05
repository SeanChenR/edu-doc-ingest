import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { cleanupOpenApiDoc } from 'nestjs-zod';

import { ApiModule } from '@/api/api.module';
import { requestIdMiddleware } from '@/api/common/request-id/request-id.middleware';
import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';

// JSON 本身的括號、引號與其他欄位的餘裕；body 上限與 MAX_DOCUMENT_BYTES 對齊（§7.5）
const BODY_OVERHEAD_BYTES = 64 * 1024;

// main.ts 與 e2e 測試共用；這裡不 listen。
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(ApiModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  const env = app.get<Env>(ENV);

  app.useLogger(app.get(Logger));
  // 順序：request id 先於 pino-http（它從回應標頭沿用同一個 id），body parser 在路由之前擋大小
  app.use(requestIdMiddleware);
  app.use(helmet());
  app.useBodyParser('json', { limit: env.MAX_DOCUMENT_BYTES + BODY_OVERHEAD_BYTES });
  app.enableShutdownHooks();

  const swagger = new DocumentBuilder()
    .setTitle('doc-ingest')
    .setDescription('Multi-tenant document ingestion service')
    .setVersion('v1')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, () => cleanupOpenApiDoc(SwaggerModule.createDocument(app, swagger)), {
    jsonDocumentUrl: 'docs-json',
  });

  return app;
}
