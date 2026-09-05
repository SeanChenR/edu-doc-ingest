import { Injectable } from '@nestjs/common';

import type { Db, Tx } from '@/shared/db/client';
import {
  type JobMessage,
  QUEUE_NAME,
  type QueueMessage,
  type QueuePort,
} from '@/shared/ports/queue.port';

interface MessageRecord {
  msg_id: string;
  read_ct: number;
  message: JobMessage;
}

@Injectable()
export class PgmqQueue implements QueuePort {
  async enqueue(tx: Tx, message: JobMessage): Promise<string> {
    const rows: { msg_id: string }[] = await tx`
      select pgmq.send(${QUEUE_NAME}, ${message}) as msg_id`;
    const msgId = rows[0]?.msg_id;
    if (msgId === undefined) throw new Error('pgmq.send returned no msg_id');
    return msgId;
  }

  async read(db: Db, qty: number, vtSec: number): Promise<QueueMessage[]> {
    const rows: MessageRecord[] = await db`
      select msg_id, read_ct, message from pgmq.read(${QUEUE_NAME}, ${vtSec}, ${qty})`;
    return rows.map((r) => ({ msgId: r.msg_id, readCt: r.read_ct, message: r.message }));
  }

  async archive(sql: Db | Tx, msgId: string): Promise<void> {
    await sql`select pgmq.archive(${QUEUE_NAME}, ${msgId}::bigint)`;
  }

  async setVt(sql: Db | Tx, msgId: string, delaySec: number): Promise<void> {
    await sql`select pgmq.set_vt(${QUEUE_NAME}, ${msgId}::bigint, ${delaySec}::integer)`;
  }
}
