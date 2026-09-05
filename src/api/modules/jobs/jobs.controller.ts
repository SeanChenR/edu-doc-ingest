import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ZodSerializerDto } from 'nestjs-zod';

import { CurrentWorkspace } from '@/api/common/auth/current-workspace.decorator';
import type { WorkspaceContext } from '@/api/common/auth/workspace-context';
import { ErrorResponseDto } from '@/api/common/filters/error-response.dto';
import { type JobResponse, JobResponseDto, toJobResponse } from '@/api/modules/jobs/jobs.dto';
import { JobsService } from '@/api/modules/jobs/jobs.service';

@ApiTags('jobs')
@ApiBearerAuth()
@Controller('v1/jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get(':jobId')
  @ApiOperation({ summary: 'Job status, progress, attempt and last error (docs/DESIGN.md §5.4)' })
  @ApiParam({ name: 'jobId', example: 'job_01J...' })
  @ZodSerializerDto(JobResponseDto)
  @ApiResponse({ status: 200, type: JobResponseDto })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'UNAUTHORIZED' })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'NOT_FOUND (missing or another workspace)',
  })
  async get(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('jobId') jobId: string,
  ): Promise<JobResponse> {
    return toJobResponse(await this.jobs.getJob(ws, jobId));
  }
}
