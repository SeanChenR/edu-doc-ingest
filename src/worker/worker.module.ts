import { Module } from '@nestjs/common';

import { ConfigModule } from '@/shared/config/config.module';
import { DbModule } from '@/shared/db/db.module';
import { WorkerService } from '@/worker/worker.service';

@Module({
  imports: [ConfigModule, DbModule.register('DATABASE_URL_WORKER')],
  providers: [WorkerService],
})
export class WorkerModule {}
