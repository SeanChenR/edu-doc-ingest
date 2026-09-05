import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ZodValidationException } from 'nestjs-zod';
import type { ZodError } from 'zod';

import { currentRequestId } from '@/api/common/request-id/request-context';
import { AppError, type ErrorDetail } from '@/shared/errors/app-error';
import { DEFAULT_MESSAGE, ErrorCode, type HttpErrorCode } from '@/shared/errors/codes';

type Translated = {
  status: number;
  code: HttpErrorCode;
  message: string;
  details?: ErrorDetail[];
};

// 框架層 HttpException 的狀態碼 → §6.3 錯誤碼
const STATUS_TO_CODE: Record<number, HttpErrorCode> = {
  400: ErrorCode.VALIDATION_ERROR,
  401: ErrorCode.UNAUTHORIZED,
  404: ErrorCode.NOT_FOUND,
  413: ErrorCode.DOCUMENT_TOO_LARGE,
  415: ErrorCode.UNSUPPORTED_MEDIA_TYPE,
};

// docs/DESIGN.md §6.2、D-24：所有錯誤（AppError、Zod 驗證、框架 404、body parser、未捕捉例外）
// 都在這裡轉成 { error: { code, message, request_id, details? } }。500 的細節只進 log。
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(@InjectPinoLogger(AppExceptionFilter.name) private readonly log: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = currentRequestId() ?? String(res.getHeader('X-Request-Id') ?? '');
    const t = translate(exception);

    if (t.status >= 500)
      this.log.error({ err: exception, request_id: requestId }, 'unhandled error');

    res.status(t.status).json({
      error: {
        code: t.code,
        message: t.message,
        request_id: requestId,
        ...(t.details === undefined ? {} : { details: t.details }),
      },
    });
  }
}

function translate(e: unknown): Translated {
  if (e instanceof AppError) {
    return { status: e.status, code: e.code, message: e.message, details: e.details };
  }
  if (e instanceof ZodValidationException) {
    const issues = (e.getZodError() as ZodError).issues;
    return {
      status: 400,
      code: ErrorCode.VALIDATION_ERROR,
      message: DEFAULT_MESSAGE[ErrorCode.VALIDATION_ERROR],
      details: issues.map((i) => ({
        field: i.path.map(String).join('.') || '(body)',
        issue: i.message,
      })),
    };
  }
  if (e instanceof HttpException) return fromStatus(e.getStatus());
  // express body-parser 的錯誤不是 HttpException，只有 status 與 type
  if (isBodyParserError(e)) {
    if (e.type === 'entity.parse.failed') {
      return {
        status: 400,
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Request body is not valid JSON.',
      };
    }
    return fromStatus(e.status);
  }
  return fromStatus(500);
}

function fromStatus(status: number): Translated {
  const code =
    status >= 500
      ? ErrorCode.INTERNAL_ERROR
      : (STATUS_TO_CODE[status] ?? ErrorCode.VALIDATION_ERROR);
  const finalStatus = code === ErrorCode.INTERNAL_ERROR ? 500 : status;
  return { status: finalStatus, code, message: DEFAULT_MESSAGE[code] };
}

function isBodyParserError(e: unknown): e is { status: number; type: string } {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { status?: unknown }).status === 'number' &&
    typeof (e as { type?: unknown }).type === 'string'
  );
}
