import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { type Db, errorMessage } from '@/shared/db/client';
import { DB } from '@/shared/db/db.module';

const QUEUE_NAME = 'document_jobs';

// ponytail: no @Public() yet — ApiKeyGuard arrives in slice 2 and these routes get marked then.
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('health')
  @ApiOperation({ summary: 'Liveness: the process is up' })
  @ApiResponse({ status: 200, schema: { example: { status: 'ok' } } })
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: database reachable and pgmq queue exists' })
  @ApiResponse({ status: 200, schema: { example: { status: 'ok' } } })
  @ApiResponse({
    status: 503,
    schema: { example: { error: { code: 'NOT_READY', message: 'queue document_jobs missing' } } },
  })
  async ready(): Promise<{ status: 'ok' }> {
    try {
      const rows = await this.db`select 1 from pgmq.meta where queue_name = ${QUEUE_NAME}`;
      if (rows.length === 0) throw new Error(`queue ${QUEUE_NAME} missing`);
    } catch (err) {
      // ponytail: AppError + AppExceptionFilter (§6.2, request_id) land in slice 2.
      throw new ServiceUnavailableException({
        error: { code: 'NOT_READY', message: errorMessage(err) },
      });
    }
    return { status: 'ok' };
  }
}
