import { Module } from '@nestjs/common';

import { AdaptersModule } from '@/shared/adapters/adapters.module';
import { ConfigModule } from '@/shared/config/config.module';
import { DbModule } from '@/shared/db/db.module';
import { LoggerModule } from '@/shared/logging/logger.module';
import { JobTransitions } from '@/worker/job-transitions';
import { PipelineService } from '@/worker/pipeline/pipeline.service';
import { WorkerService } from '@/worker/worker.service';

@Module({
  imports: [ConfigModule, LoggerModule, DbModule.register('DATABASE_URL_WORKER'), AdaptersModule],
  providers: [JobTransitions, PipelineService, WorkerService],
})
export class WorkerModule {}
