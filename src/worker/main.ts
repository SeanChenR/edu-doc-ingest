import 'reflect-metadata';
// 與 src/api/main.ts 相同的理由：先讓 @nestjs/common 評估完成，再動態載入其餘模組。
import '@nestjs/common';

const { NestFactory } = await import('@nestjs/core');
const { Logger } = await import('nestjs-pino');
const { WorkerModule } = await import('@/worker/worker.module');
const { WorkerService } = await import('@/worker/worker.service');

const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
app.useLogger(app.get(Logger));
// SIGTERM / SIGINT：Nest 呼叫 WorkerService.onApplicationShutdown 讓迴圈停止領新訊息並等進行中的完成
app.enableShutdownHooks();
await app.get(WorkerService).run();
await app.close();
