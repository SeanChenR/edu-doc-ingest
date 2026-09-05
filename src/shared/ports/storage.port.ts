// docs/DESIGN.md §10：本次實作 LocalFsStorage；正式環境換 Cloud Storage。
export const STORAGE = Symbol('STORAGE');

export interface StoragePort {
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}
