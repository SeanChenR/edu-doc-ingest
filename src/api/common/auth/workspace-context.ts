import type { Request } from 'express';

// ApiKeyGuard 解析出的身分（§7.1）：一把 key = 一個 workspace 的完整權限（D-08）。
export interface WorkspaceContext {
  workspaceId: string;
  apiKeyId: string;
}

export type AuthedRequest = Request & { workspace?: WorkspaceContext };
