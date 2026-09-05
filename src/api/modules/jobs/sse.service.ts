import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { JobEventsListener } from '@/api/modules/jobs/job-events.listener';
import { toSnapshot } from '@/api/modules/jobs/jobs.dto';
import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';
import { type Db, withTenant } from '@/shared/db/client';
import { DB } from '@/shared/db/db.module';
import { JobEventsRepository } from '@/shared/db/repositories/job-events.repository';
import type { JobEventRow, JobRow } from '@/shared/db/rows';

const TERMINAL_STATUS = new Set(['ready', 'failed']);
const TERMINAL_EVENT = new Set(['completed', 'failed']);

// docs/DESIGN.md §5.4、D-05：手寫串流。順序固定 snapshot → 補發（只在帶 Last-Event-ID 時，id > 它）→ 即時；
// 每 SSE_PING_INTERVAL_MS 送一行 `: ping`；送出終止事件後主動關閉；連線時已終止則 snapshot（+ 終止事件）後關閉。
@Injectable()
export class SseService implements OnApplicationShutdown {
  // 目前開著的串流的關閉函式；shutdown 時全部關掉，滾動部署不用等連線自然斷
  private readonly open = new Set<() => void>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DB) private readonly db: Db,
    private readonly events: JobEventsRepository,
    private readonly listener: JobEventsListener,
    private readonly log: PinoLogger,
  ) {
    this.log.setContext(SseService.name);
  }

  async stream(
    job: JobRow,
    lastEventId: string | null,
    req: Request,
    res: Response,
  ): Promise<void> {
    const wsId = job.workspace_id;
    let lastSent = BigInt(lastEventId ?? '0');
    let closed = false;
    let replayed = false;
    const buffered: JobEventRow[] = [];

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const ping = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, this.env.SSE_PING_INTERVAL_MS);

    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribe();
      this.open.delete(close);
      res.end();
    };
    this.open.add(close);

    // 只送 id 比上一則大的事件：補發與即時之間靠 id 去重
    const send = (row: JobEventRow): void => {
      const id = BigInt(row.id);
      if (closed || id <= lastSent) return;
      lastSent = id;
      res.write(frame(row.type, eventData(row), row.id));
      if (TERMINAL_EVENT.has(row.type)) close();
    };

    // 先訂閱再查歷史；歷史送完之前收到的即時事件先暫存，之後依 id 排序補上
    const unsubscribe = this.listener.subscribe(job.id, wsId, (row) => {
      if (replayed) send(row);
      else buffered.push(row);
    });
    req.on('close', close);

    res.write(frame('snapshot', toSnapshot(job)));

    try {
      // 帶 Last-Event-ID → 補發漏掉的；沒帶且已終止 → 只補終止事件；沒帶且進行中 → 不補，接即時
      const history = await withTenant(this.db, wsId, async (tx) => {
        if (lastEventId !== null) return this.events.findAfter(wsId, tx, job.id, lastEventId);
        if (!TERMINAL_STATUS.has(job.status)) return [];
        const last = await this.events.findLast(wsId, tx, job.id);
        return last === null ? [] : [last];
      });
      for (const row of history) send(row);
      replayed = true;
      for (const row of buffered.toSorted((a, b) => Number(BigInt(a.id) - BigInt(b.id)))) send(row);
      buffered.length = 0;
    } catch (err) {
      this.log.error({ err, job_id: job.id }, 'sse replay failed');
      close();
      return;
    }

    // 連線時已終止且終止事件已在 Last-Event-ID 之前 → 沒東西可等，直接關
    if (TERMINAL_STATUS.has(job.status)) close();
  }

  onApplicationShutdown(): void {
    // close() 會把自己從 Set 移除；JS 的 Set 迭代允許邊走邊刪
    for (const close of this.open) close();
  }
}

function frame(event: string, data: unknown, id?: string): string {
  const idLine = id === undefined ? '' : `id: ${id}\n`;
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// §5.4 的事件格式：job_id、stage、progress、attempt、at，終止事件多 status 與 payload（chunk_count / code）
function eventData(row: JobEventRow): Record<string, unknown> {
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
