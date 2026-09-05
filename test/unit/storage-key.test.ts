import { describe, expect, test } from 'bun:test';

import { isValidStorageKey } from '@/shared/storage-key';

describe('isValidStorageKey (§6.4, D-21)', () => {
  test('accepts keys under the caller workspace', () => {
    expect(isValidStorageKey('ws_alpha/2026/09/unit-3.pdf', 'ws_alpha')).toBe(true);
    expect(isValidStorageKey('ws_alpha/inline/doc_01.txt', 'ws_alpha')).toBe(true);
  });

  test('rejects traversal, absolute paths, backslashes, bad characters, foreign prefix', () => {
    for (const key of [
      'ws_alpha/../x',
      '/ws_alpha/x',
      'ws_alpha\\x',
      'ws_alpha',
      'ws_alpha/',
      'ws_alpha/a b',
      'ws_beta/x.txt',
      'WS_ALPHA/x.txt',
    ]) {
      expect(isValidStorageKey(key, 'ws_alpha')).toBe(false);
    }
  });
});
