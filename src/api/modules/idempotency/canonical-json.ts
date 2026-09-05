// docs/DESIGN.md §8 步驟 1：request_hash = sha256(canonical_json(body))。
// canonical = 物件鍵遞迴排序後的緊湊 JSON；陣列順序保留；字串內容不動（含 metadata）。
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function requestHash(body: unknown): string {
  return new Bun.CryptoHasher('sha256').update(canonicalJson(body)).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}
