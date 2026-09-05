// docs/DESIGN.md §7.4、D-13：錯誤訊息進 jobs.last_error_message 之前先過濾——
// 只留第一行（去堆疊）、去 URL 的 query string、去 API key 樣式字串、去檔案系統絕對路徑。
const MAX_LENGTH = 500;

const RULES: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]'],
  [/\b(?:sk|dk)[-_][A-Za-z0-9_-]+/g, '[redacted-key]'],
  [/(https?:\/\/[^\s?#]+)\?[^\s#]*/g, '$1'],
  // POSIX 絕對路徑（至少兩段），例如 /Users/x/app/storage/ws_alpha/a.txt
  [/(?:^|[\s("'`])(\/[\w.@~-]+){2,}/g, ' [path]'],
];

export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split('\n')[0] ?? '';
  const cleaned = RULES.reduce((s, [re, rep]) => s.replace(re, rep), firstLine).trim();
  return cleaned.length > MAX_LENGTH ? `${cleaned.slice(0, MAX_LENGTH - 1)}…` : cleaned;
}
