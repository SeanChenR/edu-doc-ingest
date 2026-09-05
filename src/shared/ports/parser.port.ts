// docs/DESIGN.md §10：本次實作 UnpdfParser（PDF 用 unpdf，text / markdown 直接解碼）。
export const PARSER = Symbol('PARSER');

export interface ParsedDocument {
  text: string;
  pageCount: number | null;
}

export interface ParserPort {
  parse(bytes: Uint8Array, mime: string): Promise<ParsedDocument>;
}
