// docs/DESIGN.md §10、D-26。
export const CHUNKER = Symbol('CHUNKER');

export interface Chunk {
  index: number;
  content: string;
  tokenCount: number;
}

export interface ChunkerPort {
  chunk(text: string): Chunk[];
}
