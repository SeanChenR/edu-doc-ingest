import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

import { JobEventsListener } from '@/api/modules/jobs/job-events.listener';
import { SseSession } from '@/api/modules/jobs/sse-session';
import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';
import { type Db, withTenant } from '@/shared/db/client';
import { DB } from '@/shared/db/db.module';
import { JobEventsRepository } from '@/shared/db/repositories/job-events.repository';
import type { JobRow } from '@/shared/db/rows';

const TERMINAL_STATUS = new Set(['ready', 'failed']);
const noop = (): void => {};

// docs/DESIGN.md §5.4、D-05：手寫串流的「接線」——設 header、把 res 當 writer、把 listener 與 job_events
// 接進 SseSession；順序規則本身在 SseSession。每 SSE_PING_INTERVAL_MS 送一行 `: ping`。
@Injectable()
export class SseService implements OnApplicationShutdown {
  // 目前開著的串流；shutdown 時全部關掉，滾動部署不用等連線自然斷
  private readonly open = new Set<SseSession>();

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

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let unsubscribe: () => void = noop;
    let ping: ReturnType<typeof setInterval> | undefined;
    const session = new SseSession(
      job,
      lastEventId,
      { write: (chunk) => void res.write(chunk), end: () => res.end() },
      () => {
        clearInterval(ping);
        unsubscribe();
        this.open.delete(session);
      },
    );
    this.open.add(session);
    ping = setInterval(() => session.ping(), this.env.SSE_PING_INTERVAL_MS);
    // 先訂閱再查歷史，補發前收到的即時事件由 session 暫存
    unsubscribe = this.listener.subscribe(job.id, wsId, (row) => session.live(row));
    req.on('close', () => session.close());

    session.snapshot();
    try {
      // 帶 Last-Event-ID → 補發漏掉的；沒帶且已終止 → 只補終止事件；沒帶且進行中 → 不補，接即時
      const history = await withTenant(this.db, wsId, async (tx) => {
        if (lastEventId !== null) return this.events.findAfter(wsId, tx, job.id, lastEventId);
        if (!TERMINAL_STATUS.has(job.status)) return [];
        const last = await this.events.findLast(wsId, tx, job.id);
        return last === null ? [] : [last];
      });
      session.replay(history);
    } catch (err) {
      this.log.error({ err, job_id: job.id }, 'sse replay failed');
      session.close();
      return;
    }
    session.finishIfTerminal();
  }

  onApplicationShutdown(): void {
    // close() 會把自己從 Set 移除；JS 的 Set 迭代允許邊走邊刪
    for (const session of this.open) session.close();
  }
}
