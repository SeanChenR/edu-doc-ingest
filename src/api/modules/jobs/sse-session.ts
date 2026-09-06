import { toSnapshot } from '@/api/modules/jobs/jobs.dto';
import type { JobEventRow, JobRow } from '@/shared/db/rows';

const TERMINAL_STATUS = new Set(['ready', 'failed']);
const TERMINAL_EVENT = new Set(['completed', 'failed']);

// 只負責「寫出一段文字」與「結束」；SseService 用 Express 的 res 實作，測試用陣列實作。
export interface SseWriter {
  write(chunk: string): void;
  end(): void;
}

// docs/DESIGN.md §5.4、D-05 的順序規則，與 HTTP 無關：
// snapshot → 補發（呼叫端決定要補哪些）→ 即時；以 job_events.id 去重；補發完成前收到的即時事件先暫存；
// 送出終止事件（completed / failed）後關閉；連線時已終止且沒東西可補也關閉。
export class SseSession {
  private lastSent: bigint;
  private replayed = false;
  private closed = false;
  private readonly buffered: JobEventRow[] = [];

  constructor(
    private readonly job: JobRow,
    lastEventId: string | null,
    private readonly writer: SseWriter,
    private readonly onClose: () => void = () => {},
  ) {
    this.lastSent = BigInt(lastEventId ?? '0');
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // 連線時的現況，來自 jobs 表，不帶 id
  snapshot(): void {
    if (this.closed) return;
    this.writer.write(frame('snapshot', toSnapshot(this.job)));
  }

  // 即時事件：補發完成前先暫存，之後依 id 排序補上
  live(row: JobEventRow): void {
    if (this.replayed) this.send(row);
    else this.buffered.push(row);
  }

  // 補發歷史，然後把暫存的即時事件依 id 排序送出（send 會用 id 去重）
  replay(rows: JobEventRow[]): void {
    for (const row of rows) this.send(row);
    this.replayed = true;
    const pending = this.buffered.toSorted((a, b) => Number(BigInt(a.id) - BigInt(b.id)));
    this.buffered.length = 0;
    for (const row of pending) this.send(row);
  }

  // 連線時已終止且終止事件已在 Last-Event-ID 之前 → 沒東西可等，直接關
  finishIfTerminal(): void {
    if (TERMINAL_STATUS.has(this.job.status)) this.close();
  }

  ping(): void {
    if (!this.closed) this.writer.write(': ping\n\n');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.writer.end();
    this.onClose();
  }

  // 只送 id 比上一則大的事件
  private send(row: JobEventRow): void {
    const id = BigInt(row.id);
    if (this.closed || id <= this.lastSent) return;
    this.lastSent = id;
    this.writer.write(frame(row.type, eventData(row), row.id));
    if (TERMINAL_EVENT.has(row.type)) this.close();
  }
}

export function frame(event: string, data: unknown, id?: string): string {
  const idLine = id === undefined ? '' : `id: ${id}\n`;
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// §5.4 的事件格式：job_id、stage、progress、attempt、at，終止事件多 status 與 payload（chunk_count / code）
export function eventData(row: JobEventRow): Record<string, unknown> {
  const base: Record<string, unknown> = {
    job_id: row.job_id,
    stage: row.stage,
    progress: row.progress,
    attempt: row.attempt,
    ...(row.message === null ? {} : { message: row.message }),
    ...row.payload,
    at: row.created_at.toISOString(),
  };
  if (row.type === 'completed') return { ...base, status: 'ready' };
  if (row.type === 'failed') return { ...base, status: 'failed' };
  return base;
}
