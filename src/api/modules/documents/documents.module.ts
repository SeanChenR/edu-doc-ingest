import { Module } from '@nestjs/common';

import { DocumentsController } from '@/api/modules/documents/documents.controller';
import { DocumentsQueryController } from '@/api/modules/documents/documents.query.controller';
import { DocumentsService } from '@/api/modules/documents/documents.service';
import { IdempotencyModule } from '@/api/modules/idempotency/idempotency.module';

@Module({
  imports: [IdempotencyModule],
  controllers: [DocumentsController, DocumentsQueryController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
