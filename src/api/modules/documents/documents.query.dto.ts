import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import type { DocumentRow, JobRow } from '@/shared/db/rows';

// docs/DESIGN.md §5.3 GET /v1/documents/:documentId 的回應；request_id 由 ResponseInterceptor 補。
export const TEXT_PREVIEW_CHARS = 500;

export const DocumentResponseSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  name: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int(),
  status: z.enum(['pending', 'processing', 'ready', 'failed']),
  page_count: z.number().int().nullable(),
  chunk_count: z.number().int().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  latest_job: z
    .object({
      id: z.string(),
      status: z.string(),
      progress: z.number().int(),
      attempt: z.number().int(),
      finished_at: z.iso.datetime().nullable(),
    })
    .nullable(),
  result: z
    .object({
      text_preview: z.string(),
      embedding_model: z.string(),
      embedding_dimensions: z.number().int(),
    })
    .nullable(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  request_id: z.string(),
});

export class DocumentResponseDto extends createZodDto(DocumentResponseSchema) {}

export type DocumentResponse = Omit<z.infer<typeof DocumentResponseSchema>, 'request_id'>;

export interface EmbeddingInfo {
  modelName: string;
  dimensions: number;
}

export function toDocumentResponse(
  doc: DocumentRow,
  latestJob: JobRow | null,
  embedding: EmbeddingInfo,
): DocumentResponse {
  return {
    id: doc.id,
    workspace_id: doc.workspace_id,
    name: doc.name,
    mime_type: doc.mime_type,
    size_bytes: doc.size_bytes,
    status: doc.status,
    page_count: doc.page_count,
    chunk_count: doc.chunk_count,
    metadata: doc.metadata,
    latest_job:
      latestJob === null
        ? null
        : {
            id: latestJob.id,
            status: latestJob.status,
            progress: latestJob.progress,
            attempt: latestJob.attempt,
            finished_at: latestJob.finished_at?.toISOString() ?? null,
          },
    // §5.3：result 在非 ready 狀態為 null
    result:
      doc.status === 'ready'
        ? {
            text_preview: (doc.extracted_text ?? '').slice(0, TEXT_PREVIEW_CHARS),
            embedding_model: embedding.modelName,
            embedding_dimensions: embedding.dimensions,
          }
        : null,
    created_at: doc.created_at.toISOString(),
    updated_at: doc.updated_at.toISOString(),
  };
}
