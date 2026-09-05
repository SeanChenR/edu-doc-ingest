import 'reflect-metadata';
// 與 src/api/main.ts 相同的理由：先讓 @nestjs/common 評估完成，再動態載入其餘模組。
import '@nestjs/common';

const { NestFactory } = await import('@nestjs/core');
const { WorkerModule } = await import('@/worker/worker.module');

const app = await NestFactory.createApplicationContext(WorkerModule);
// SIGTERM / SIGINT 由 Nest 處理：跑 onApplicationShutdown、關閉 context、結束 process。
// 在 poll loop（slice 3）進來之前，沒有其他東西讓 event loop 忙碌。
app.enableShutdownHooks();
await new Promise<never>(() => {});
