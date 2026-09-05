// docs/DESIGN.md §6.4：storage_key 的白名單格式，且第一段必須等於目前的 workspace_id（D-21）。
const STORAGE_KEY_RE = /^[a-z0-9_]+(\/[A-Za-z0-9._-]+)+$/;

export function isValidStorageKey(key: string, workspaceId: string): boolean {
  return STORAGE_KEY_RE.test(key) && key.split('/')[0] === workspaceId;
}
