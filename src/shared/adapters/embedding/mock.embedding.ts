import { Inject, Injectable } from '@nestjs/common';

import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';
import type { EmbeddingPort } from '@/shared/ports/embedding.port';

// docs/DESIGN.md §10、D-15：sha256 → 確定性假向量並正規化。同一段文字永遠得到同一個向量，
// 測試不需要金鑰或網路。向量由 sha256(text) 為種子、逐塊 sha256(seed || i) 展開到指定維度。
@Injectable()
export class MockEmbedding implements EmbeddingPort {
  readonly dimensions: number;
  readonly modelName: string;

  constructor(@Inject(ENV) env: Env) {
    this.dimensions = env.EMBEDDING_DIMENSIONS;
    this.modelName = `mock-${this.dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectorOf(t));
  }

  private vectorOf(text: string): number[] {
    const seed = new Bun.CryptoHasher('sha256').update(text).digest();
    const values: number[] = [];
    for (let block = 0; values.length < this.dimensions; block++) {
      const bytes = new Bun.CryptoHasher('sha256').update(seed).update(String(block)).digest();
      for (const b of bytes) {
        if (values.length === this.dimensions) break;
        values.push((b / 255) * 2 - 1);
      }
    }
    const norm = Math.hypot(...values) || 1;
    return values.map((v) => v / norm);
  }
}
