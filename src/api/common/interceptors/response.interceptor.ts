import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';

import { currentRequestId } from '@/api/common/request-id/request-context';

// docs/DESIGN.md §6.1、D-24：成功回應把資源欄位攤平在最上層，末尾附 request_id。
// X-Request-Id 標頭由 RequestIdMiddleware 負責。
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(map((body) => (isPlainObject(body) ? { ...body, request_id: currentRequestId() } : body)));
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
