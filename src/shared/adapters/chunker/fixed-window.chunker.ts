import { Inject, Injectable } from '@nestjs/common';

import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';
import type { Chunk, ChunkerPort } from '@/shared/ports/chunker.port';

// CJK 統一表意文字、假名、全形符號：每個字元估 1 token；其他每 4 字元估 1 token（D-26）
const CJK_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/g;
const SEPARATORS = ['\n\n', '\n', ' '];

export function estimateTokens(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

// docs/DESIGN.md §9.3、D-26：固定字元視窗 + overlap，切點優先落在段落邊界。
// 同一段文字永遠切出同樣的結果，重試時 upsert 才對得上 (document_id, chunk_index)。
@Injectable()
export class FixedWindowChunker implements ChunkerPort {
  private readonly size: number;
  private readonly overlap: number;

  constructor(@Inject(ENV) env: Env) {
    this.size = env.CHUNK_SIZE;
    // overlap 必須小於視窗，否則永遠不前進
    this.overlap = Math.min(env.CHUNK_OVERLAP, env.CHUNK_SIZE - 1);
  }

  chunk(input: string): Chunk[] {
    const text = input.trim();
    if (text.length === 0) return [];

    const chunks: Chunk[] = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + this.size, text.length);
      if (end < text.length) end = this.cutPoint(text, start, end);

      const content = text.slice(start, end).trim();
      if (content.length > 0) {
        chunks.push({ index: chunks.length, content, tokenCount: estimateTokens(content) });
      }
      if (end >= text.length) break;
      start = Math.max(end - this.overlap, start + 1);
    }
    return chunks;
  }

  // 在視窗的後半段往回找分隔符；找到就切在分隔符之後，找不到就硬切在視窗尾端。
  private cutPoint(text: string, start: number, end: number): number {
    const floor = start + Math.floor(this.size / 2);
    for (const sep of SEPARATORS) {
      const at = text.lastIndexOf(sep, end - 1);
      if (at >= floor) return at + sep.length;
    }
    return end;
  }
}
