// Bun 沒有原生的 AsyncLocalStorage，只能用 node:async_hooks。
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

// docs/DESIGN.md §2.2：request id 掛在 AsyncLocalStorage，filter / interceptor / service 都拿得到；
// pino 的 mixin 也從這裡取值，讓 request 範圍內的所有 log 自動帶 request_id（worker 沒有 request，取不到就不加）。
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
