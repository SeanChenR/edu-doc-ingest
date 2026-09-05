import { describe, expect, test } from 'bun:test';

import { estimateTokens, FixedWindowChunker } from '@/shared/adapters/chunker/fixed-window.chunker';
import { loadEnv } from '@/shared/config/env';

const chunker = new FixedWindowChunker(
  loadEnv({ ...process.env, CHUNK_SIZE: '50', CHUNK_OVERLAP: '10' }),
);

describe('FixedWindowChunker (D-26)', () => {
  test('empty or whitespace-only text yields no chunks', () => {
    expect(chunker.chunk('')).toEqual([]);
    expect(chunker.chunk('   \n\n  ')).toEqual([]);
  });

  test('short text is a single chunk with index 0', () => {
    const [only, ...rest] = chunker.chunk('hello world');
    expect(rest).toHaveLength(0);
    expect(only).toEqual({ index: 0, content: 'hello world', tokenCount: 3 });
  });

  test('cuts at the nearest paragraph boundary in the second half of the window', () => {
    // overlap 設 0 看純粹的切點；有 overlap 時下一塊會往回多帶 overlap 個字元
    const noOverlap = new FixedWindowChunker(
      loadEnv({ ...process.env, CHUNK_SIZE: '50', CHUNK_OVERLAP: '0' }),
    );
    const text = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}\n\n${'c'.repeat(30)}`;
    const chunks = noOverlap.chunk(text);
    expect(chunks.map((c) => c.content)).toEqual(['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)]);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);

    const withOverlap = chunker.chunk(text);
    expect(withOverlap[0]?.content).toBe('a'.repeat(30));
    expect(withOverlap[1]?.content.startsWith('aaaaaaaa\n\nbbb')).toBe(true);
  });

  test('hard-cuts and overlaps when there is no separator', () => {
    const text = 'x'.repeat(120);
    const chunks = chunker.chunk(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(50);
    // 相鄰視窗前進 size - overlap = 40 個字元
    expect(chunks[1]?.content.length).toBe(50);
    expect(chunks.at(-1)?.content.length).toBe(120 - 40 * (chunks.length - 1));
  });

  test('is deterministic', () => {
    const text = 'Lorem ipsum dolor sit amet. '.repeat(20);
    expect(chunker.chunk(text)).toEqual(chunker.chunk(text));
  });
});

describe('estimateTokens', () => {
  test('CJK characters count one each, other text four chars per token', () => {
    expect(estimateTokens('分數')).toBe(2);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('第三單元 abcd')).toBe(4 + 2);
  });
});
