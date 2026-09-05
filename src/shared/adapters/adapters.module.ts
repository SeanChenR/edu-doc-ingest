import { Global, Module } from '@nestjs/common';

import { FixedWindowChunker } from '@/shared/adapters/chunker/fixed-window.chunker';
import { MockEmbedding } from '@/shared/adapters/embedding/mock.embedding';
import { UnpdfParser } from '@/shared/adapters/parser/unpdf.parser';
import { PgmqQueue } from '@/shared/adapters/queue/pgmq.queue';
import { LocalFsStorage } from '@/shared/adapters/storage/local-fs.storage';
import { CHUNKER } from '@/shared/ports/chunker.port';
import { EMBEDDING } from '@/shared/ports/embedding.port';
import { PARSER } from '@/shared/ports/parser.port';
import { QUEUE } from '@/shared/ports/queue.port';
import { STORAGE } from '@/shared/ports/storage.port';

// Port → Adapter 的綁定只在這裡（§10）。Service 只依賴 port token。
@Global()
@Module({
  providers: [
    { provide: STORAGE, useClass: LocalFsStorage },
    { provide: QUEUE, useClass: PgmqQueue },
    { provide: PARSER, useClass: UnpdfParser },
    { provide: EMBEDDING, useClass: MockEmbedding },
    { provide: CHUNKER, useClass: FixedWindowChunker },
  ],
  exports: [STORAGE, QUEUE, PARSER, EMBEDDING, CHUNKER],
})
export class AdaptersModule {}
