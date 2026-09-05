import { Global, Module } from '@nestjs/common';

import { type Env, loadEnv } from '@/shared/config/env';

export const ENV = Symbol('ENV');

@Global()
@Module({
  providers: [{ provide: ENV, useFactory: (): Env => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
