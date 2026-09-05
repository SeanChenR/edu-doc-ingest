import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from 'nestjs-zod';

import { ApiKeyGuard } from '@/api/common/auth/api-key.guard';
import { AppExceptionFilter } from '@/api/common/filters/app-exception.filter';
import { ResponseInterceptor } from '@/api/common/interceptors/response.interceptor';
import { DocumentsModule } from '@/api/modules/documents/documents.module';
import { HealthModule } from '@/api/modules/health/health.module';
import { AdaptersModule } from '@/shared/adapters/adapters.module';
import { ConfigModule } from '@/shared/config/config.module';
import { DbModule } from '@/shared/db/db.module';
import { LoggerModule } from '@/shared/logging/logger.module';

// docs/DESIGN.md §2.2 請求生命週期：RequestIdMiddleware（app.ts）→ ApiKeyGuard → WorkspaceScopeGuard（controller）
// → ZodValidationPipe → Controller → ResponseInterceptor → AppExceptionFilter。
@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    DbModule.register('DATABASE_URL'),
    AdaptersModule,
    HealthModule,
    DocumentsModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class ApiModule {}
