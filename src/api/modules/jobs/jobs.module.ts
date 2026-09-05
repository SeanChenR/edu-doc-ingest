import { Module } from '@nestjs/common';

import { JobEventsListener } from '@/api/modules/jobs/job-events.listener';
import { JobsController } from '@/api/modules/jobs/jobs.controller';
import { JobsService } from '@/api/modules/jobs/jobs.service';
import { SseController } from '@/api/modules/jobs/sse.controller';
import { SseService } from '@/api/modules/jobs/sse.service';

@Module({
  controllers: [JobsController, SseController],
  providers: [JobsService, JobEventsListener, SseService],
})
export class JobsModule {}
