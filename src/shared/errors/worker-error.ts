import { ErrorCode } from '@/shared/errors/codes';

// docs/DESIGN.md §6.3 worker 端錯誤碼：寫進 jobs.last_error_code，不對應 HTTP。
export type WorkerErrorCode =
  | ErrorCode.EXTRACTION_FAILED
  | ErrorCode.EMBEDDING_PROVIDER_ERROR
  | ErrorCode.STORAGE_READ_FAILED
  | ErrorCode.MAX_ATTEMPTS_EXCEEDED;

export class WorkerError extends Error {
  readonly code: WorkerErrorCode;

  constructor(code: WorkerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkerError';
    this.code = code;
  }
}
