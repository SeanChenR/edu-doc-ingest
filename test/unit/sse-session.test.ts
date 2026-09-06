import { describe, expect, test } from 'bun:test';

import { SseSession } from '@/api/modules/jobs/sse-session';
import type { JobEventRow, JobRow } from '@/shared/db/rows';

const now = new Date('2026-09-06T00:00:00Z');

function job(status: JobRow['status']): JobRow {
  return {
    id: 'job_1',
    workspace_id: 'ws_alpha',
    document_id: 'doc_1',
    kind: 'ingest',
    status,
    progress: status === 'ready' ? 100 : 0,
    attempt: 1,
    max_attempts: 3,
    last_error_code: null,
    last_error_message: null,
    queue_msg_id: null,
    started_at: null,
    finished_at: null,
    created_at: now,
    updated_at: now,
  };
}

function event(id: number, type: JobEventRow['type'], progress = 0): JobEventRow {
  return {
    id: String(id),
    job_id: 'job_1',
    workspace_id: 'ws_alpha',
    type,
    stage: type === 'completed' ? null : 'embedding',
    progress,
    attempt: 1,
    message: null,
    payload: type === 'completed' ? { chunk_count: 1 } : null,
    created_at: now,
  };
}

// 把串流拆成 [event, id] 對；註解行（ping）另外記
function collector() {
  const chunks: string[] = [];
  let ended = false;
  const writer = { write: (c: string) => void chunks.push(c), end: () => void (ended = true) };
  const events = (): [string, string | undefined][] =>
    chunks
      .filter((c) => c.startsWith('id: ') || c.startsWith('event: '))
      .map((c) => {
        const id = /^id: (\d+)/.exec(c)?.[1];
        const ev = /event: (\w+)/.exec(c)?.[1] ?? '';
        return [ev, id];
      });
  return { writer, events, chunks, isEnded: () => ended };
}

describe('SseSession (§5.4, D-05)', () => {
  test('snapshot first (no id), then live events in id order, terminal event closes', () => {
    const c = collector();
    const s = new SseSession(job('queued'), null, c.writer);
    s.snapshot();
    s.replay([]);
    s.live(event(10, 'stage_changed', 10));
    s.live(event(11, 'progress', 40));
    s.live(event(12, 'completed', 100));
    s.live(event(13, 'progress', 100)); // 關閉後的事件被忽略
    expect(c.events()).toEqual([
      ['snapshot', undefined],
      ['stage_changed', '10'],
      ['progress', '11'],
      ['completed', '12'],
    ]);
    expect(c.isEnded()).toBe(true);
    expect(s.isClosed).toBe(true);
  });

  test('live events arriving before replay finishes are buffered, sorted and de-duplicated by id', () => {
    const c = collector();
    const s = new SseSession(job('extracting'), '10', c.writer);
    s.snapshot();
    s.live(event(13, 'progress', 90)); // 補發還沒完成：先暫存
    s.live(event(12, 'stage_changed', 40));
    s.replay([event(11, 'progress', 40), event(12, 'stage_changed', 40)]); // 12 在歷史與暫存都出現
    expect(c.events().map(([e, id]) => `${e}:${id ?? '-'}`)).toEqual([
      'snapshot:-',
      'progress:11',
      'stage_changed:12',
      'progress:13',
    ]);
    expect(s.isClosed).toBe(false);
  });

  test('Last-Event-ID filters replayed rows at or below it', () => {
    const c = collector();
    const s = new SseSession(job('ready'), '11', c.writer);
    s.snapshot();
    s.replay([event(10, 'stage_changed'), event(11, 'progress'), event(12, 'completed')]);
    expect(c.events().map(([e]) => e)).toEqual(['snapshot', 'completed']);
    expect(s.isClosed).toBe(true);
  });

  test('terminal job with nothing to replay closes after snapshot; onClose runs exactly once', () => {
    const c = collector();
    let closes = 0;
    const s = new SseSession(job('ready'), '999', c.writer, () => closes++);
    s.snapshot();
    s.replay([]);
    s.finishIfTerminal();
    s.close();
    expect(c.events().map(([e]) => e)).toEqual(['snapshot']);
    expect(closes).toBe(1);
  });

  test('ping writes a comment line only while open', () => {
    const c = collector();
    const s = new SseSession(job('queued'), null, c.writer);
    s.ping();
    s.close();
    s.ping();
    expect(c.chunks.filter((x) => x === ': ping\n\n')).toHaveLength(1);
  });
});
