import { Controller, Get, Headers, Param, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentWorkspace } from '@/api/common/auth/current-workspace.decorator';
import type { WorkspaceContext } from '@/api/common/auth/workspace-context';
import { ErrorResponseDto } from '@/api/common/filters/error-response.dto';
import { JobsService } from '@/api/modules/jobs/jobs.service';
import { SseService } from '@/api/modules/jobs/sse.service';

// D-05：不用 @Sse()，直接操作原始 Response。
@ApiTags('jobs')
@ApiBearerAuth()
@Controller('v1/jobs')
export class SseController {
  constructor(
    private readonly jobs: JobsService,
    private readonly sse: SseService,
  ) {}

  @Get(':jobId/events')
  @ApiOperation({
    summary:
      'Server-sent events for a job: snapshot, replay after Last-Event-ID, live (docs/DESIGN.md §5.4)',
  })
  @ApiParam({ name: 'jobId', example: 'job_01J...' })
  @ApiHeader({
    name: 'Last-Event-ID',
    required: false,
    description: 'Replay job_events with id greater than this',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description:
      'text/event-stream: snapshot, stage_changed, progress, retry_scheduled, completed, failed',
  })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'UNAUTHORIZED' })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'NOT_FOUND (missing or another workspace); no stream is opened',
  })
  async events(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('jobId') jobId: string,
    @Headers('last-event-id') lastEventIdHeader: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // 租戶不符 → 一般 404 JSON（由 filter 產生），不會建立串流
    const job = await this.jobs.getJob(ws, jobId);
    const lastEventId =
      // 最多 18 位數：超過 bigint 範圍的值當作沒帶，不讓它變成 SQL 轉型錯誤
      lastEventIdHeader !== undefined && /^\d{1,18}$/.test(lastEventIdHeader)
        ? lastEventIdHeader
        : null;
    await this.sse.stream(job, lastEventId, req, res);
  }
}
