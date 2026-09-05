// docs/DESIGN.md §6.3 的錯誤碼一覽。不得在這份清單之外發明新碼。

export enum ErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  IDEMPOTENCY_KEY_REQUIRED = 'IDEMPOTENCY_KEY_REQUIRED',
  CONTENT_SOURCE_INVALID = 'CONTENT_SOURCE_INVALID',
  INVALID_STORAGE_KEY = 'INVALID_STORAGE_KEY',
  UNAUTHORIZED = 'UNAUTHORIZED',
  NOT_FOUND = 'NOT_FOUND',
  IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED',
  DOCUMENT_TOO_LARGE = 'DOCUMENT_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE = 'UNSUPPORTED_MEDIA_TYPE',
  SIZE_MISMATCH = 'SIZE_MISMATCH',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NOT_READY = 'NOT_READY',

  // worker 端：寫入 jobs.last_error_code，不對應 HTTP 狀態碼
  EXTRACTION_FAILED = 'EXTRACTION_FAILED',
  EMBEDDING_PROVIDER_ERROR = 'EMBEDDING_PROVIDER_ERROR',
  STORAGE_READ_FAILED = 'STORAGE_READ_FAILED',
  MAX_ATTEMPTS_EXCEEDED = 'MAX_ATTEMPTS_EXCEEDED',
}

export type HttpErrorCode = Exclude<
  ErrorCode,
  | ErrorCode.EXTRACTION_FAILED
  | ErrorCode.EMBEDDING_PROVIDER_ERROR
  | ErrorCode.STORAGE_READ_FAILED
  | ErrorCode.MAX_ATTEMPTS_EXCEEDED
>;

export const HTTP_STATUS: Record<HttpErrorCode, number> = {
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.IDEMPOTENCY_KEY_REQUIRED]: 400,
  [ErrorCode.CONTENT_SOURCE_INVALID]: 400,
  [ErrorCode.INVALID_STORAGE_KEY]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 409,
  [ErrorCode.DOCUMENT_TOO_LARGE]: 413,
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: 415,
  [ErrorCode.SIZE_MISMATCH]: 422,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.NOT_READY]: 503,
};

// 面向開發者的單句英文訊息（§6.2）。NOT_FOUND 的訊息對「不存在」與「跨租戶」必須完全相同（D-09）。
export const DEFAULT_MESSAGE: Record<HttpErrorCode, string> = {
  [ErrorCode.VALIDATION_ERROR]: 'Request validation failed.',
  [ErrorCode.IDEMPOTENCY_KEY_REQUIRED]: 'Idempotency-Key header is required.',
  [ErrorCode.CONTENT_SOURCE_INVALID]: 'Provide exactly one of content_text or storage_key.',
  [ErrorCode.INVALID_STORAGE_KEY]: 'storage_key is not valid for this workspace.',
  [ErrorCode.UNAUTHORIZED]: 'Missing or invalid API key.',
  [ErrorCode.NOT_FOUND]: 'Resource not found.',
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]:
    'Idempotency-Key was already used with a different request body.',
  [ErrorCode.DOCUMENT_TOO_LARGE]: 'Document exceeds the allowed size.',
  [ErrorCode.UNSUPPORTED_MEDIA_TYPE]: 'mime_type is not supported.',
  [ErrorCode.SIZE_MISMATCH]: 'Declared size_bytes does not match the content length.',
  [ErrorCode.INTERNAL_ERROR]: 'Unexpected error.',
  [ErrorCode.NOT_READY]: 'Service is not ready.',
};
