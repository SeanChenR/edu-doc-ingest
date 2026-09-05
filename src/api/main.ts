import 'reflect-metadata';
// @nestjs/common 的模組圖在 Bun 下是非同步評估；nestjs-pino 只有 CJS 版本，會同步 require 它。
// ESM 允許不相依的同層模組並行評估，所以這裡先靜態 import 等它評估完，其餘一律動態 import，
// 否則 Bun 會偶發「require() async module is unsupported」。測試的 helpers 用同一招。
import '@nestjs/common';
import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';

const { createApp } = await import('@/api/app');
const { Logger } = await import('nestjs-pino');

const app = await createApp();
const env = app.get<Env>(ENV);
await app.listen(env.PORT);
app.get(Logger).log(`listening on :${env.PORT}, swagger at /docs`);
