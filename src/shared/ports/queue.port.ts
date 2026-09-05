import type { Db, Tx } from '@/shared/db/client';

// docs/DESIGN.md §4.8、§10、D-03。
export const QUEUE = Symbol('QUEUE');
export const QUEUE_NAME = 'document_jobs';

export interface JobMessage {
  job_id: string;
  workspace_id: string;
}

export interface QueueMessage {
  msgId: string;
  // pgmq 記錄的領取次數，就是 attempt（D-13）
  readCt: number;
  message: JobMessage;
}

export interface QueuePort {
  // 必須在呼叫端的交易內執行（D-12：與 documents / jobs 的寫入要成功一起成功）。回傳 pgmq 的 msg_id。
  enqueue(tx: Tx, message: JobMessage): Promise<string>;
  // 領取最多 qty 則，領走後 vtSec 秒內其他 worker 看不到
  read(db: Db, qty: number, vtSec: number): Promise<QueueMessage[]>;
  // 處理完成或重試耗盡：搬到歸檔表
  archive(sql: Db | Tx, msgId: string): Promise<void>;
  // 重試：delaySec 秒後重新可見（nack）
  setVt(sql: Db | Tx, msgId: string, delaySec: number): Promise<void>;
}
