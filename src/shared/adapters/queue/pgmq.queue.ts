import { Injectable } from '@nestjs/common';

import type { Tx } from '@/shared/db/client';
import { type JobMessage, QUEUE_NAME, type QueuePort } from '@/shared/ports/queue.port';

@Injectable()
export class PgmqQueue implements QueuePort {
  async enqueue(tx: Tx, message: JobMessage): Promise<string> {
    const rows: { msg_id: string }[] = await tx`
      select pgmq.send(${QUEUE_NAME}, ${JSON.stringify(message)}::jsonb) as msg_id`;
    const msgId = rows[0]?.msg_id;
    if (msgId === undefined) throw new Error('pgmq.send returned no msg_id');
    return String(msgId);
  }
}
