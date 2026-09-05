// docs/DESIGN.md §10、D-15：本次只有 MockEmbedding；正式環境經 LiteLLM gateway 接真模型。
export const EMBEDDING = Symbol('EMBEDDING');

export interface EmbeddingPort {
  readonly dimensions: number;
  readonly modelName: string;
  embed(texts: string[]): Promise<number[][]>;
}
