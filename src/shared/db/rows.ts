// docs/DESIGN.md §4：每張表一個手寫 Row 介面（D-02）。
// Bun SQL 的對應：timestamptz → Date、jsonb → object、bigint → string、smallint/integer → number。

export interface WorkspaceRow {
  id: string;
  name: string;
  created_at: Date;
}

export interface ApiKeyRow {
  id: string;
  workspace_id: string;
  key_hash: string;
  label: string;
  created_at: Date;
  revoked_at: Date | null;
}

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface DocumentRow {
  id: string;
  workspace_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  status: DocumentStatus;
  latest_job_id: string | null;
  extracted_text: string | null;
  page_count: number | null;
  chunk_count: number | null;
  metadata: Record<string, unknown> | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DocumentChunkRow {
  id: string;
  document_id: string;
  workspace_id: string;
  chunk_index: number;
  content: string;
  token_count: number;
  embedding: string | null;
  created_at: Date;
}

export type JobStatus = 'queued' | 'extracting' | 'embedding' | 'ready' | 'failed';

export interface JobRow {
  id: string;
  workspace_id: string;
  document_id: string;
  kind: string;
  status: JobStatus;
  progress: number;
  attempt: number;
  max_attempts: number;
  last_error_code: string | null;
  last_error_message: string | null;
  queue_msg_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export type JobEventType =
  | 'snapshot'
  | 'stage_changed'
  | 'progress'
  | 'retry_scheduled'
  | 'completed'
  | 'failed';

export interface JobEventRow {
  id: string;
  job_id: string;
  workspace_id: string;
  type: JobEventType;
  stage: string | null;
  progress: number;
  attempt: number;
  message: string | null;
  payload: Record<string, unknown> | null;
  created_at: Date;
}

export interface IdempotencyKeyRow {
  workspace_id: string;
  key: string;
  request_hash: string;
  response_status: number | null;
  response_body: Record<string, unknown> | null;
  created_at: Date;
  expires_at: Date;
}
