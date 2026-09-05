import { describe, expect, test } from 'bun:test';

import type { CreateDocumentDto } from '@/api/modules/documents/documents.dto';
import { validateCreateInput } from '@/api/modules/documents/documents.validation';
import { AppError } from '@/shared/errors/app-error';
import { ErrorCode } from '@/shared/errors/codes';

const env = {
  ALLOWED_MIME_TYPES: ['application/pdf', 'text/plain', 'text/markdown'],
  MAX_DOCUMENT_BYTES: 100,
};
const base = { name: 'a/b\\c.txt', mime_type: 'text/plain', size_bytes: 5 };

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof AppError ? err.code : undefined;
  }
  return undefined;
}

describe('validateCreateInput (§6.4 → §6.3 codes)', () => {
  test('inline text: strips path separators, keeps bytes', () => {
    const v = validateCreateInput(env, 'ws_alpha', { ...base, content_text: 'hello' });
    expect(v.name).toBe('abc.txt');
    expect(v.source.kind).toBe('inline');
    if (v.source.kind === 'inline') expect(v.source.bytes.byteLength).toBe(5);
  });

  test('storage_key under own workspace', () => {
    const v = validateCreateInput(env, 'ws_alpha', { ...base, storage_key: 'ws_alpha/x/a.txt' });
    expect(v.source).toEqual({ kind: 'storage', key: 'ws_alpha/x/a.txt' });
  });

  test('each rule maps to its own error code', () => {
    const cases: [CreateDocumentDto, ErrorCode][] = [
      [{ ...base }, ErrorCode.CONTENT_SOURCE_INVALID],
      [
        { ...base, content_text: 'hello', storage_key: 'ws_alpha/a' },
        ErrorCode.CONTENT_SOURCE_INVALID,
      ],
      [
        { ...base, mime_type: 'image/png', content_text: 'hello' },
        ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      ],
      [{ ...base, size_bytes: 101, content_text: 'hello' }, ErrorCode.DOCUMENT_TOO_LARGE],
      [{ ...base, name: '///', content_text: 'hello' }, ErrorCode.VALIDATION_ERROR],
      [
        { ...base, mime_type: 'application/pdf', content_text: 'hello' },
        ErrorCode.CONTENT_SOURCE_INVALID,
      ],
      [{ ...base, size_bytes: 100, content_text: 'x'.repeat(101) }, ErrorCode.DOCUMENT_TOO_LARGE],
      [{ ...base, size_bytes: 10, content_text: 'hello' }, ErrorCode.SIZE_MISMATCH],
      [{ ...base, storage_key: 'ws_beta/a.txt' }, ErrorCode.INVALID_STORAGE_KEY],
    ];
    for (const [dto, code] of cases) {
      expect(codeOf(() => validateCreateInput(env, 'ws_alpha', dto))).toBe(code);
    }
  });
});
