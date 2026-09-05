import { describe, expect, test } from 'bun:test';

import { UnpdfParser } from '@/shared/adapters/parser/unpdf.parser';
import { ErrorCode } from '@/shared/errors/codes';
import { WorkerError } from '@/shared/errors/worker-error';

const parser = new UnpdfParser();
const fixture = `${import.meta.dir}/../../scripts/fixtures/unit-3-fractions.pdf`;

// 回傳 WorkerError 的 code；沒丟錯或丟的不是 WorkerError 都回 undefined
async function failureCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return err instanceof WorkerError ? err.code : undefined;
  }
  return undefined;
}

describe('UnpdfParser (D-15, §6.4)', () => {
  test('extracts text and page count from the sample PDF', async () => {
    const parsed = await parser.parse(await Bun.file(fixture).bytes(), 'application/pdf');
    expect(parsed.pageCount).toBe(2);
    expect(parsed.text).toContain('Hello unpdf page one');
    expect(parsed.text).toContain('Fractions unit three page two');
  });

  test('rejects bytes without the %PDF- header as EXTRACTION_FAILED', async () => {
    const err = await failure(
      parser.parse(new TextEncoder().encode('not a pdf'), 'application/pdf'),
    );
    expect(err).toBeInstanceOf(WorkerError);
    expect((err as WorkerError).code).toBe(ErrorCode.EXTRACTION_FAILED);
  });

  test('decodes text/plain and text/markdown as UTF-8; invalid UTF-8 fails', async () => {
    const ok = await parser.parse(new TextEncoder().encode('第三單元 分數'), 'text/markdown');
    expect(ok).toEqual({ text: '第三單元 分數', pageCount: null });
    const code = await failureCode(parser.parse(new Uint8Array([0xff, 0xfe, 0xc0]), 'text/plain'));
    expect(code).toBe(ErrorCode.EXTRACTION_FAILED);
  });
});
