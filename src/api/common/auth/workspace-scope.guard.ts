import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

import type { AuthedRequest } from '@/api/common/auth/workspace-context';
import { AppError } from '@/shared/errors/app-error';
import { ErrorCode } from '@/shared/errors/codes';

// docs/DESIGN.md §7.1：路徑的 :workspaceId 必須等於 token 的 workspace；不符回 404，不回 403（D-09）。
// 掛在含 :workspaceId 的 controller 上；global 的 ApiKeyGuard 先跑，所以 req.workspace 已存在。
@Injectable()
export class WorkspaceScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const pathWorkspaceId = req.params['workspaceId'];
    if (req.workspace === undefined || pathWorkspaceId !== req.workspace.workspaceId) {
      throw new AppError(ErrorCode.NOT_FOUND);
    }
    return true;
  }
}
