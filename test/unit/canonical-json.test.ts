import { describe, expect, test } from 'bun:test';

import { canonicalJson, requestHash } from '@/api/modules/idempotency/canonical-json';

describe('canonicalJson / requestHash (§8)', () => {
  test('sorts object keys recursively, keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  test('drops undefined values so optional fields do not change the hash', () => {
    expect(requestHash({ a: 1, b: undefined })).toBe(requestHash({ a: 1 }));
  });

  test('hash is order-independent but content-sensitive', () => {
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
    expect(requestHash({ a: 1, b: 2 })).not.toBe(requestHash({ a: 1, b: 3 }));
    expect(requestHash({ a: 'x' })).toMatch(/^[0-9a-f]{64}$/);
  });
});
