import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PinoLogger } from 'nestjs-pino';

import { Public } from '@/api/common/auth/public.decorator';
import { ErrorResponseDto } from '@/api/common/filters/error-response.dto';
import type { Db } from '@/shared/db/client';
import { DB } from '@/shared/db/db.module';
import { AppError } from '@/shared/errors/app-error';
import { ErrorCode } from '@/shared/errors/codes';
import { QUEUE_NAME } from '@/shared/ports/queue.port';

// docs/DESIGN.md §5.5：health 不需要身分驗證。
@ApiTags('health')
@Public()
@Controller()
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly log: PinoLogger,
  ) {
    this.log.setContext(HealthController.name);
  }

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
  // 對外只回固定訊息（不帶驅動程式的錯誤文字，避免洩漏主機、port 之類的內部資訊），細節進 log
  async ready(): Promise<{ status: 'ok' }> {
    let rows: unknown[];
    try {
      rows = await this.db`select 1 from pgmq.meta where queue_name = ${QUEUE_NAME}`;
    } catch (err) {
      this.log.warn({ err }, 'readiness check: database query failed');
      throw new AppError(
        ErrorCode.NOT_READY,
        undefined,
        undefined,
        'Not ready: database unavailable.',
      );
    }
    if (rows.length === 0) {
      this.log.warn({ queue: QUEUE_NAME }, 'readiness check: queue missing');
      throw new AppError(
        ErrorCode.NOT_READY,
        undefined,
        undefined,
        'Not ready: job queue missing.',
      );
    }
    return { status: 'ok' };
  }
}
