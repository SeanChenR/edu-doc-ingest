import { describe, expect, test } from 'bun:test';

import { sanitizeError } from '@/shared/errors/sanitize';

describe('sanitizeError (§7.4, D-13)', () => {
  test('keeps only the first line (no stack)', () => {
    const err = new Error('boom\n    at somewhere (/Users/x/app/file.ts:1:1)');
    expect(sanitizeError(err)).toBe('boom');
  });

  test('redacts bearer tokens and key-looking strings', () => {
    expect(sanitizeError('auth failed: Bearer abc.def-ghi')).toBe('auth failed: Bearer [redacted]');
    expect(sanitizeError('provider rejected sk-live-1234567890abcdef')).toBe(
      'provider rejected [redacted-key]',
    );
    expect(sanitizeError('used dk_alpha_local_only')).toBe('used [redacted-key]');
  });

  test('strips URL query strings and absolute file paths', () => {
    expect(sanitizeError('503 from https://api.example.com/v1/embed?key=zzz&x=1')).toBe(
      '503 from https://api.example.com/v1/embed',
    );
    expect(sanitizeError('ENOENT: no such file, open /Users/sean/app/storage/ws_alpha/a.txt')).toBe(
      'ENOENT: no such file, open [path]',
    );
  });

  test('caps length and handles non-Error values', () => {
    expect(sanitizeError('x'.repeat(600))).toHaveLength(500);
    expect(sanitizeError(42)).toBe('42');
  });
});
