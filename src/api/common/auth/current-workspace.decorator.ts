import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthedRequest, WorkspaceContext } from '@/api/common/auth/workspace-context';
import { AppError } from '@/shared/errors/app-error';
import { ErrorCode } from '@/shared/errors/codes';

export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WorkspaceContext => {
    const ws = ctx.switchToHttp().getRequest<AuthedRequest>().workspace;
    // ApiKeyGuard 是 global guard，走到這裡一定有；沒有代表路由誤標了 @Public()
    if (ws === undefined) throw new AppError(ErrorCode.UNAUTHORIZED);
    return ws;
  },
);
