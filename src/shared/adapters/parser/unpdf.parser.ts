import { Injectable } from '@nestjs/common';
import { extractText, getDocumentProxy } from 'unpdf';

import { ErrorCode } from '@/shared/errors/codes';
import { WorkerError } from '@/shared/errors/worker-error';
import type { ParsedDocument, ParserPort } from '@/shared/ports/parser.port';

const PDF_MAGIC = '%PDF-';
const utf8 = new TextDecoder('utf-8', { fatal: true });

// docs/DESIGN.md §10、D-15：PDF 走 unpdf；text / markdown 直接 UTF-8 解碼。
// §6.4：讀取 PDF 前以 magic bytes 二次驗證。
@Injectable()
export class UnpdfParser implements ParserPort {
  async parse(bytes: Uint8Array, mime: string): Promise<ParsedDocument> {
    if (mime === 'application/pdf') return this.parsePdf(bytes);
    try {
      return { text: utf8.decode(bytes), pageCount: null };
    } catch (err) {
      throw new WorkerError(ErrorCode.EXTRACTION_FAILED, 'Content is not valid UTF-8 text.', {
        cause: err,
      });
    }
  }

  private async parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, PDF_MAGIC.length));
    if (head !== PDF_MAGIC) {
      throw new WorkerError(
        ErrorCode.EXTRACTION_FAILED,
        'File is not a PDF (missing %PDF- header).',
      );
    }
    try {
      // unpdf / pdf.js 可能會轉移（transfer）傳入的 buffer，給它一份複本
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { totalPages, text } = await extractText(pdf, { mergePages: true });
      return { text, pageCount: totalPages };
    } catch (err) {
      throw new WorkerError(ErrorCode.EXTRACTION_FAILED, 'PDF text extraction failed.', {
        cause: err,
      });
    }
  }
}
