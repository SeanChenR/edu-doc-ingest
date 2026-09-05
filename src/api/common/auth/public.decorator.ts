import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

// 標在不需要 API key 的路由上（目前只有 /health、/ready）。
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
