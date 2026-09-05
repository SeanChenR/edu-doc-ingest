import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import type { WorkspaceContext } from '@/api/common/auth/workspace-context';
import type { CreateDocumentDto } from '@/api/modules/documents/documents.dto';
import {
  IdempotencyService,
  type ReplayableResponse,
} from '@/api/modules/idempotency/idempotency.service';
import { ENV } from '@/shared/config/config.module';
import type { Env } from '@/shared/config/env';
import { type Db, withTenant } from '@/shared/db/client';
import { DB } from '@/shared/db/db.module';
import { DocumentsRepository } from '@/shared/db/repositories/documents.repository';
import { JobsRepository } from '@/shared/db/repositories/jobs.repository';
import { AppError } from '@/shared/errors/app-error';
import { ErrorCode } from '@/shared/errors/codes';
import { newId } from '@/shared/ids';
import { QUEUE, type QueuePort } from '@/shared/ports/queue.port';
import { STORAGE, type StoragePort } from '@/shared/ports/storage.port';
import { isValidStorageKey } from '@/shared/storage-key';

const SIZE_TOLERANCE = 0.05;
const encoder = new TextEncoder();

type ContentSource = { kind: 'inline'; bytes: Uint8Array } | { kind: 'storage'; key: string };

interface ValidatedInput {
  name: string;
  mimeType: string;
  sizeBytes: number;
  metadata: Record<string, unknown> | null;
  source: ContentSource;
}

export interface CreateDocumentResult extends ReplayableResponse {
  replayed: boolean;
}

type TxOutcome = { kind: 'created'; response: ReplayableResponse } | { kind: 'lost_race' };

// docs/DESIGN.md §2.1 命令路徑、§8 冪等、D-12 單一交易、D-25 content_text 先落 StoragePort。
@Injectable()
export class DocumentsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DB) private readonly db: Db,
    @Inject(STORAGE) private readonly storage: StoragePort,
    @Inject(QUEUE) private readonly queue: QueuePort,
    private readonly documents: DocumentsRepository,
    private readonly jobs: JobsRepository,
    private readonly idempotency: IdempotencyService,
    @InjectPinoLogger(DocumentsService.name) private readonly log: PinoLogger,
  ) {}

  async create(
    ws: WorkspaceContext,
    dto: CreateDocumentDto,
    idempotencyKeyHeader: string | undefined,
  ): Promise<CreateDocumentResult> {
    const key = this.idempotency.requireKey(idempotencyKeyHeader);
    const input = this.validate(ws.workspaceId, dto);
    const hash = this.idempotency.hash(dto);
    const wsId = ws.workspaceId;

    // D-25 步驟 1：交易外先查，重播不寫第二個檔。response_body 為 null 代表另一個請求進行中，
    // 交給步驟 3 的主鍵鎖去等它。
    const existing = await withTenant(this.db, wsId, (tx) => this.idempotency.find(wsId, tx, key));
    if (existing?.response_body)
      return { ...this.idempotency.replay(existing, hash), replayed: true };

    const documentId = newId('doc');
    const jobId = newId('job');
    const storageKey =
      input.source.kind === 'inline'
        ? `${wsId}/inline/${documentId}.${input.mimeType === 'text/markdown' ? 'md' : 'txt'}`
        : input.source.key;

    // D-25 步驟 2
    if (input.source.kind === 'inline')
      await this.storage.put(storageKey, input.source.bytes, input.mimeType);
    const wroteFile = input.source.kind === 'inline';

    try {
      // D-25 步驟 3、D-12：搶 key、documents、jobs、pgmq.send、回存回應，同一交易
      const outcome = await withTenant(this.db, wsId, async (tx): Promise<TxOutcome> => {
        const claimed = await this.idempotency.claim(wsId, tx, key, hash);
        if (!claimed) return { kind: 'lost_race' };

        const msgId = await this.queue.enqueue(tx, { job_id: jobId, workspace_id: wsId });
        await this.documents.insert(wsId, tx, {
          id: documentId,
          name: input.name,
          mime_type: input.mimeType,
          size_bytes: input.sizeBytes,
          storage_key: storageKey,
          metadata: input.metadata,
          latest_job_id: jobId,
        });
        await this.jobs.insert(wsId, tx, {
          id: jobId,
          document_id: documentId,
          max_attempts: this.env.WORKER_MAX_ATTEMPTS,
          queue_msg_id: msgId,
        });

        const response: ReplayableResponse = {
          status: 202,
          body: { document_id: documentId, job_id: jobId, status: 'queued' },
        };
        await this.idempotency.complete(wsId, tx, key, response);
        return { kind: 'created', response };
      });

      if (outcome.kind === 'created') return { ...outcome.response, replayed: false };

      // 併發下輸給另一個相同 key 的請求：它已 commit，讀回來重播
      if (wroteFile) await this.cleanupFile(storageKey);
      const row = await withTenant(this.db, wsId, (tx) => this.idempotency.find(wsId, tx, key));
      if (row === null) throw new AppError(ErrorCode.INTERNAL_ERROR);
      return { ...this.idempotency.replay(row, hash), replayed: true };
    } catch (err) {
      // D-25 步驟 4：交易失敗時 best-effort 刪檔
      if (wroteFile) await this.cleanupFile(storageKey);
      throw err;
    }
  }

  // §6.4 的輸入限制，每條對應 §6.3 的專屬錯誤碼。
  private validate(workspaceId: string, dto: CreateDocumentDto): ValidatedInput {
    const hasText = dto.content_text !== undefined;
    const hasKey = dto.storage_key !== undefined;
    if (hasText === hasKey) throw new AppError(ErrorCode.CONTENT_SOURCE_INVALID);

    if (!this.env.ALLOWED_MIME_TYPES.includes(dto.mime_type)) {
      throw new AppError(ErrorCode.UNSUPPORTED_MEDIA_TYPE);
    }

    const max = this.env.MAX_DOCUMENT_BYTES;
    if (dto.size_bytes > max) {
      throw new AppError(ErrorCode.DOCUMENT_TOO_LARGE, undefined, [
        { field: 'size_bytes', issue: `must be <= ${max}` },
      ]);
    }

    // §6.4「去除路徑分隔符」
    const name = dto.name.replace(/[\\/]/g, '');
    if (name.length === 0) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, undefined, [
        { field: 'name', issue: 'must contain characters other than path separators' },
      ]);
    }

    const metadata = dto.metadata ?? null;
    const base = { name, mimeType: dto.mime_type, sizeBytes: dto.size_bytes, metadata };

    if (dto.content_text !== undefined) {
      // content_text 只能是文字類型；PDF 一律走 storage_key（§6.4）
      if (!dto.mime_type.startsWith('text/')) {
        throw new AppError(
          ErrorCode.CONTENT_SOURCE_INVALID,
          undefined,
          undefined,
          'content_text is only accepted for text/* mime types; use storage_key for PDF.',
        );
      }
      const bytes = encoder.encode(dto.content_text);
      if (bytes.byteLength > max) {
        throw new AppError(ErrorCode.DOCUMENT_TOO_LARGE, undefined, [
          { field: 'content_text', issue: `must be <= ${max} bytes` },
        ]);
      }
      if (Math.abs(bytes.byteLength - dto.size_bytes) / dto.size_bytes > SIZE_TOLERANCE) {
        throw new AppError(ErrorCode.SIZE_MISMATCH, undefined, [
          { field: 'size_bytes', issue: `declared ${dto.size_bytes}, actual ${bytes.byteLength}` },
        ]);
      }
      return { ...base, source: { kind: 'inline', bytes } };
    }

    const storageKey = dto.storage_key ?? '';
    if (!isValidStorageKey(storageKey, workspaceId))
      throw new AppError(ErrorCode.INVALID_STORAGE_KEY);
    return { ...base, source: { kind: 'storage', key: storageKey } };
  }

  private async cleanupFile(storageKey: string): Promise<void> {
    try {
      await this.storage.delete(storageKey);
    } catch (err) {
      // 孤兒檔是可接受的已知限制（D-25）；記 warn 供人工清理
      this.log.warn({ storage_key: storageKey, err }, 'failed to delete orphan file');
    }
  }
}
