import type { NextFunction, Request, Response } from 'express';

import { requestContext } from '@/api/common/request-id/request-context';
import { newId } from '@/shared/ids';

// docs/DESIGN.md §5.1：client 可自帶 X-Request-Id，限 UUID 或 ULID；否則忽略並自產 req_<ULID>。
const CLIENT_ID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})$/i;

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId = incoming !== undefined && CLIENT_ID_RE.test(incoming) ? incoming : newId('req');
  res.setHeader('X-Request-Id', requestId);
  requestContext.run({ requestId }, next);
}
