import type { Tx } from '@/shared/db/client';

// docs/DESIGN.md §4.8、§10。read / ack / nack 在 slice 3（worker）加入。
export const QUEUE = Symbol('QUEUE');
export const QUEUE_NAME = 'document_jobs';

export interface JobMessage {
  job_id: string;
  workspace_id: string;
}

export interface QueuePort {
  // 必須在呼叫端的交易內執行（D-12：與 documents / jobs 的寫入要成功一起成功）。回傳 pgmq 的 msg_id。
  enqueue(tx: Tx, message: JobMessage): Promise<string>;
}
