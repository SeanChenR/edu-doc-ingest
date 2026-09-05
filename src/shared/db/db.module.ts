import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';
import { connectWithRetry, createDb, type Db } from '@/shared/db/client';

export const DB = Symbol('DB');

type DbUrlKey = 'DATABASE_URL' | 'DATABASE_URL_WORKER';

@Injectable()
class DbShutdown implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.close();
  }
}

@Global()
@Module({})
export class DbModule {
  // api passes 'DATABASE_URL' (app_user), worker passes 'DATABASE_URL_WORKER' (worker_user).
  static register(urlKey: DbUrlKey): DynamicModule {
    return {
      module: DbModule,
      providers: [
        {
          provide: DB,
          inject: [ENV],
          useFactory: async (env: Env): Promise<Db> => {
            const log = new Logger('DbModule');
            const db = createDb(env[urlKey]);
            await connectWithRetry(db, env.DB_CONNECT_RETRY_SEC, (m) => log.warn(m));
            log.log(`connected as ${urlKey}`);
            return db;
          },
        },
        DbShutdown,
      ],
      exports: [DB],
    };
  }
}
