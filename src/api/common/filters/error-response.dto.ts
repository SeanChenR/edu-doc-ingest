import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { ErrorCode } from '@/shared/errors/codes';

// docs/DESIGN.md §6.2 的統一錯誤格式；只給 Swagger 用，實際輸出由 AppExceptionFilter 產生。
export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum(ErrorCode),
    message: z.string(),
    request_id: z.string(),
    details: z.array(z.object({ field: z.string(), issue: z.string() })).optional(),
  }),
});

export class ErrorResponseDto extends createZodDto(ErrorResponseSchema) {}
