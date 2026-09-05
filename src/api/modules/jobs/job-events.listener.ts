import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { type Db, withTenant } from '@/shared/db/client';
import { DB } from '@/shared/db/db.module';
import { JobEventsRepository } from '@/shared/db/repositories/job-events.repository';
import type { JobEventRow } from '@/shared/db/rows';

const CHANNEL = 'job_events';

type Subscription = Awaited<ReturnType<Db['listen']>>;

interface Subscriber {
  workspaceId: string;
  handler: (row: JobEventRow) => void;
}

const NotificationSchema = z.object({ job_id: z.string(), event_id: z.string() });

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// docs/DESIGN.md §9.2、D-04：一個 api process 一個 LISTEN。通知只帶 job_id 與 event_id 當叫醒鈴；
// 收到後在訂閱者的 withTenant 內回 job_events 讀那一列（RLS 仍生效），再推給訂閱同一個 job 的 SSE 連線。
// 多台 api 都 LISTEN 同一頻道即可橫向擴展。
@Injectable()
export class JobEventsListener implements OnModuleInit, OnModuleDestroy {
  private subscription: Subscription | null = null;
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly events: JobEventsRepository,
    private readonly log: PinoLogger,
  ) {
    this.log.setContext(JobEventsListener.name);
  }

  async onModuleInit(): Promise<void> {
    this.subscription = await this.db.listen(CHANNEL, (payload) => {
      void this.onNotify(payload);
    });
    this.log.info({ channel: CHANNEL }, 'listening');
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscription?.unlisten();
    this.subscription = null;
  }

  // 回傳取消訂閱的函式
  subscribe(jobId: string, workspaceId: string, handler: (row: JobEventRow) => void): () => void {
    const sub: Subscriber = { workspaceId, handler };
    const set = this.subscribers.get(jobId) ?? new Set<Subscriber>();
    set.add(sub);
    this.subscribers.set(jobId, set);
    return () => {
      set.delete(sub);
      if (set.size === 0) this.subscribers.delete(jobId);
    };
  }

  private async onNotify(payload: string): Promise<void> {
    const parsed = NotificationSchema.safeParse(tryJson(payload));
    if (!parsed.success) {
      this.log.warn('ignoring malformed notification');
      return;
    }
    const n = parsed.data;
    const subs = this.subscribers.get(n.job_id);
    if (subs === undefined || subs.size === 0) return;

    // 同一個 job 的訂閱者理論上同一個 workspace；仍以 workspace 分組各自讀，不共用查詢結果
    const byWorkspace = new Map<string, Subscriber[]>();
    for (const s of subs)
      byWorkspace.set(s.workspaceId, [...(byWorkspace.get(s.workspaceId) ?? []), s]);

    for (const [wsId, list] of byWorkspace) {
      try {
        const row = await withTenant(this.db, wsId, (tx) =>
          this.events.findOne(wsId, tx, n.job_id, n.event_id),
        );
        if (row === null) continue;
        for (const s of list) s.handler(row);
      } catch (err) {
        this.log.error({ err, job_id: n.job_id, event_id: n.event_id }, 'failed to load event row');
      }
    }
  }
}
