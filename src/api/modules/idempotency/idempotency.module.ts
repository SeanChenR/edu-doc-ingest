import { Module } from '@nestjs/common';

import { IdempotencyService } from '@/api/modules/idempotency/idempotency.service';

@Module({ providers: [IdempotencyService], exports: [IdempotencyService] })
export class IdempotencyModule {}
