import 'reflect-metadata';

import { Logger } from 'nestjs-pino';

import { createApp } from '@/api/app';
import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';

const app = await createApp();
const env = app.get<Env>(ENV);
await app.listen(env.PORT);
app.get(Logger).log(`listening on :${env.PORT}, swagger at /docs`);
