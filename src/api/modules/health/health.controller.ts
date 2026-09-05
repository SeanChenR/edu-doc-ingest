import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { Public } from '@/api/common/auth/public.decorator';
import { ErrorResponseDto } from '@/api/common/filters/error-response.dto';
import { type Db, errorMessage } from '@/shared/db/client';
import { DB } from '@/shared/db/db.module';
import { AppError } from '@/shared/errors/app-error';
import { ErrorCode } from '@/shared/errors/codes';
import { QUEUE_NAME } from '@/shared/ports/queue.port';

// docs/DESIGN.md §5.5：health 不需要身分驗證。
@ApiTags('health')
@Public()
@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get('health')
  @ApiOperation({ summary: 'Liveness: the process is up' })
  @ApiResponse({ status: 200, schema: { example: { status: 'ok', request_id: 'req_01J...' } } })
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness: database reachable and pgmq queue exists' })
  @ApiResponse({ status: 200, schema: { example: { status: 'ok', request_id: 'req_01J...' } } })
  @ApiResponse({ status: 503, type: ErrorResponseDto, description: 'NOT_READY' })
  async ready(): Promise<{ status: 'ok' }> {
    try {
      const rows = await this.db`select 1 from pgmq.meta where queue_name = ${QUEUE_NAME}`;
      if (rows.length === 0) throw new Error(`queue ${QUEUE_NAME} missing`);
    } catch (err) {
      throw new AppError(ErrorCode.NOT_READY, undefined, undefined, `Not ready: ${errorMessage(err)}`);
    }
    return { status: 'ok' };
  }
}
