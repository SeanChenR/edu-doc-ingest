import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { JobRow } from '@/shared/db/rows';

// docs/DESIGN.md §5.4 GET /v1/jobs/:jobId 的回應；request_id 由 ResponseInterceptor 補。
export const JobResponseSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  document_id: z.string(),
  kind: z.string(),
  status: z.enum(['queued', 'extracting', 'embedding', 'ready', 'failed']),
  progress: z.number().int(),
  attempt: z.number().int(),
  max_attempts: z.number().int(),
  retries_used: z.number().int(),
  last_error: z.object({ code: z.string(), message: z.string() }).nullable(),
  started_at: z.iso.datetime().nullable(),
  finished_at: z.iso.datetime().nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  request_id: z.string(),
});

export class JobResponseDto extends createZodDto(JobResponseSchema) {}

export type JobResponse = Omit<z.infer<typeof JobResponseSchema>, 'request_id'>;

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function toJobResponse(job: JobRow): JobResponse {
  return {
    id: job.id,
    workspace_id: job.workspace_id,
    document_id: job.document_id,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    attempt: job.attempt,
    max_attempts: job.max_attempts,
    // attempt 0 代表還沒被 worker 領走
    retries_used: Math.max(0, job.attempt - 1),
    last_error:
      job.last_error_code === null
        ? null
        : { code: job.last_error_code, message: job.last_error_message ?? '' },
    started_at: iso(job.started_at),
    finished_at: iso(job.finished_at),
    created_at: job.created_at.toISOString(),
    updated_at: job.updated_at.toISOString(),
  };
}

// SSE 的 snapshot 事件（§5.4）：連線時的現況，來自 jobs 表，不帶 id
export const SnapshotSchema = z.object({
  job_id: z.string(),
  status: JobResponseSchema.shape.status,
  progress: z.number().int(),
  attempt: z.number().int(),
  last_error: JobResponseSchema.shape.last_error,
  at: z.iso.datetime(),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

export function toSnapshot(job: JobRow): Snapshot {
  const r = toJobResponse(job);
  return {
    job_id: r.id,
    status: r.status,
    progress: r.progress,
    attempt: r.attempt,
    last_error: r.last_error,
    at: new Date().toISOString(),
  };
}
