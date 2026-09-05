import type { CreateDocumentDto } from '@/api/modules/documents/documents.dto';
import type { Env } from '@/shared/config/env';
import { AppError } from '@/shared/errors/app-error';
import { ErrorCode } from '@/shared/errors/codes';
import { isValidStorageKey } from '@/shared/storage-key';

// docs/DESIGN.md §6.4 的輸入限制，每條對應 §6.3 的專屬錯誤碼。純函式，不碰 DB 與檔案。
// DTO（Zod）只管形狀；這裡管語意：二擇一、MIME 白名單、大小上限、size 差異、storage_key 前綴、name 去分隔符。
const SIZE_TOLERANCE = 0.05;
const encoder = new TextEncoder();

export type ContentSource =
  | { kind: 'inline'; bytes: Uint8Array }
  | { kind: 'storage'; key: string };

export interface ValidatedInput {
  name: string;
  mimeType: string;
  sizeBytes: number;
  metadata: Record<string, unknown> | null;
  source: ContentSource;
}

type Limits = Pick<Env, 'ALLOWED_MIME_TYPES' | 'MAX_DOCUMENT_BYTES'>;

export function validateCreateInput(
  env: Limits,
  workspaceId: string,
  dto: CreateDocumentDto,
): ValidatedInput {
  const hasText = dto.content_text !== undefined;
  const hasKey = dto.storage_key !== undefined;
  if (hasText === hasKey) throw new AppError(ErrorCode.CONTENT_SOURCE_INVALID);

  if (!env.ALLOWED_MIME_TYPES.includes(dto.mime_type)) {
    throw new AppError(ErrorCode.UNSUPPORTED_MEDIA_TYPE);
  }

  const max = env.MAX_DOCUMENT_BYTES;
  if (dto.size_bytes > max) {
    throw new AppError(ErrorCode.DOCUMENT_TOO_LARGE, undefined, [
      { field: 'size_bytes', issue: `must be <= ${max}` },
    ]);
  }

  // §6.4「去除路徑分隔符」
  const name = dto.name.replace(/[\\/]/g, '');
  if (name.length === 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, undefined, [
      { field: 'name', issue: 'must contain characters other than path separators' },
    ]);
  }

  const metadata = dto.metadata ?? null;
  const base = { name, mimeType: dto.mime_type, sizeBytes: dto.size_bytes, metadata };

  if (dto.content_text !== undefined) {
    // content_text 只能是文字類型；PDF 一律走 storage_key（§6.4）
    if (!dto.mime_type.startsWith('text/')) {
      throw new AppError(
        ErrorCode.CONTENT_SOURCE_INVALID,
        undefined,
        undefined,
        'content_text is only accepted for text/* mime types; use storage_key for PDF.',
      );
    }
    const bytes = encoder.encode(dto.content_text);
    if (bytes.byteLength > max) {
      throw new AppError(ErrorCode.DOCUMENT_TOO_LARGE, undefined, [
        { field: 'content_text', issue: `must be <= ${max} bytes` },
      ]);
    }
    if (Math.abs(bytes.byteLength - dto.size_bytes) / dto.size_bytes > SIZE_TOLERANCE) {
      throw new AppError(ErrorCode.SIZE_MISMATCH, undefined, [
        { field: 'size_bytes', issue: `declared ${dto.size_bytes}, actual ${bytes.byteLength}` },
      ]);
    }
    return { ...base, source: { kind: 'inline', bytes } };
  }

  const storageKey = dto.storage_key ?? '';
  if (!isValidStorageKey(storageKey, workspaceId))
    throw new AppError(ErrorCode.INVALID_STORAGE_KEY);
  return { ...base, source: { kind: 'storage', key: storageKey } };
}
