import { Injectable } from '@nestjs/common';

import type { Tx } from '@/shared/db/client';
import {
  JobEventsRepository,
  type NewJobEvent,
} from '@/shared/db/repositories/job-events.repository';

const CHANNEL = 'job_events';

// docs/DESIGN.md §9.2、D-04：每次狀態變更在同一交易內 INSERT job_events 並 NOTIFY。
// 通知只帶 job_id 與 event_id 當叫醒鈴；api 收到後回表讀事件列。pg_notify 在 commit 時才送出。
@Injectable()
export class JobEventsService {
  constructor(private readonly events: JobEventsRepository) {}

  async emit(workspaceId: string, tx: Tx, event: NewJobEvent): Promise<string> {
    const eventId = await this.events.insert(workspaceId, tx, event);
    const payload = JSON.stringify({ job_id: event.job_id, event_id: eventId });
    await tx`select pg_notify(${CHANNEL}, ${payload})`;
    return eventId;
  }
}
