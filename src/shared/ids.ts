import { ulid } from 'ulid';

// D-22：帶前綴的 ULID，由應用程式在交易開始前產生。
export type IdPrefix = 'ws' | 'doc' | 'job' | 'key' | 'req' | 'chk';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
