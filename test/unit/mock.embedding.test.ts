import { describe, expect, test } from 'bun:test';

import { MockEmbedding } from '@/shared/adapters/embedding/mock.embedding';
import { loadEnv } from '@/shared/config/env';

const embedding = new MockEmbedding(loadEnv({ ...process.env, EMBEDDING_DIMENSIONS: '1536' }));

describe('MockEmbedding (D-15)', () => {
  test('exposes dimensions and model name', () => {
    expect(embedding.dimensions).toBe(1536);
    expect(embedding.modelName).toBe('mock-1536');
  });

  test('is deterministic, content-sensitive and unit-length', async () => {
    const [a1, b, a2] = await embedding.embed(['分數的加法', 'fractions', '分數的加法']);
    expect(a1).toHaveLength(1536);
    expect(a1).toEqual(a2 ?? []);
    expect(a1).not.toEqual(b ?? []);
    const norm = Math.hypot(...(a1 ?? []));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-9);
  });
});
