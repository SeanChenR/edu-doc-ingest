import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// docs/DESIGN.md §5.3、§6.4。這裡只做形狀與型別檢查（→ VALIDATION_ERROR）；
// 需要專屬錯誤碼的規則（二擇一、MIME 白名單、大小上限、storage_key 前綴、size 差異）在 DocumentsService。
export const METADATA_MAX_BYTES = 4096;

export const CreateDocumentSchema = z.object({
  name: z.string().min(1).max(255),
  mime_type: z.string().min(1).max(255),
  size_bytes: z.number().int().min(1),
  content_text: z.string().optional(),
  storage_key: z.string().min(1).max(1024).optional(),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    // 以 UTF-8 位元組計（§6.4「序列化後 ≤ 4 KB」），不是字元數：CJK 一個字元佔 3 bytes
    .refine(
      (m) => m === undefined || Buffer.byteLength(JSON.stringify(m), 'utf8') <= METADATA_MAX_BYTES,
      {
        message: `must be <= ${METADATA_MAX_BYTES} bytes when serialized`,
      },
    ),
});

export class CreateDocumentDto extends createZodDto(CreateDocumentSchema) {}

export const CreateDocumentAcceptedSchema = z.object({
  document_id: z.string(),
  job_id: z.string(),
  status: z.literal('queued'),
  request_id: z.string(),
});

export class CreateDocumentAcceptedDto extends createZodDto(CreateDocumentAcceptedSchema) {}
