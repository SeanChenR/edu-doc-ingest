import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';

import { WorkerModule } from '@/worker/worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM / SIGINT are handled by Nest: it runs onApplicationShutdown hooks, closes the
  // context and exits the process. Nothing else keeps the loop busy until the poll loop (slice 3).
  app.enableShutdownHooks();
  await new Promise<never>(() => {});
}

await bootstrap();
