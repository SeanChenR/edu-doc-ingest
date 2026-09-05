import { DEFAULT_MESSAGE, HTTP_STATUS, type HttpErrorCode } from '@/shared/errors/codes';

export type ErrorDetail = { field: string; issue: string };

// 應用層唯一的錯誤型別；AppExceptionFilter 把它轉成 §6.2 的格式。
// status 省略時依 §6.3 的對照表；message 省略時用 DEFAULT_MESSAGE。
export class AppError extends Error {
  readonly code: HttpErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;

  constructor(code: HttpErrorCode, status?: number, details?: ErrorDetail[], message?: string) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? HTTP_STATUS[code];
    this.details = details;
  }
}
