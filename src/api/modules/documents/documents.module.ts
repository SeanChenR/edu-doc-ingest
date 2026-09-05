import { Module } from '@nestjs/common';

import { DocumentsController } from '@/api/modules/documents/documents.controller';
import { DocumentsService } from '@/api/modules/documents/documents.service';
import { IdempotencyModule } from '@/api/modules/idempotency/idempotency.module';

@Module({
  imports: [IdempotencyModule],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
