// docs/DESIGN.md §6.4：storage_key 的白名單格式，且第一段必須等於目前的 workspace_id（D-21）。
const STORAGE_KEY_RE = /^[a-z0-9_]+(\/[A-Za-z0-9._-]+)+$/;

export function isValidStorageKey(key: string, workspaceId: string): boolean {
  if (!STORAGE_KEY_RE.test(key)) return false;
  const segments = key.split('/');
  // 正規式允許純點的段落（例如 ..），§6.3 明定含 .. 要拒絕
  if (segments.some((s) => s === '.' || s === '..')) return false;
  return segments[0] === workspaceId;
}
