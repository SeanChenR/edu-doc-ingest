import { Global, Module } from '@nestjs/common';

import { PgmqQueue } from '@/shared/adapters/queue/pgmq.queue';
import { LocalFsStorage } from '@/shared/adapters/storage/local-fs.storage';
import { QUEUE } from '@/shared/ports/queue.port';
import { STORAGE } from '@/shared/ports/storage.port';

// Port → Adapter 的綁定只在這裡（§10）。Service 只依賴 port token。
@Global()
@Module({
  providers: [
    { provide: STORAGE, useClass: LocalFsStorage },
    { provide: QUEUE, useClass: PgmqQueue },
  ],
  exports: [STORAGE, QUEUE],
})
export class AdaptersModule {}
