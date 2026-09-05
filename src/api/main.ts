import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { ApiModule } from '@/api/api.module';
import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ApiModule);
  app.enableShutdownHooks();

  const swagger = new DocumentBuilder()
    .setTitle('doc-ingest')
    .setDescription('Multi-tenant document ingestion service')
    .setVersion('v1')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, swagger), {
    jsonDocumentUrl: 'docs-json',
  });

  const env = app.get<Env>(ENV);
  await app.listen(env.PORT);
  new Logger('api').log(`listening on :${env.PORT}, swagger at /docs`);
}

await bootstrap();
