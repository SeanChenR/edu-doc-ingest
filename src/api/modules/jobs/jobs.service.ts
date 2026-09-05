import { Inject, Injectable } from '@nestjs/common';

import type { WorkspaceContext } from '@/api/common/auth/workspace-context';
import { type Db, withTenant } from '@/shared/db/client';
import { DB } from '@/shared/db/db.module';
import { JobsRepository } from '@/shared/db/repositories/jobs.repository';
import type { JobRow } from '@/shared/db/rows';
import { AppError } from '@/shared/errors/app-error';
import { ErrorCode } from '@/shared/errors/codes';

// docs/DESIGN.md §2.1 Query 路徑：直接查表。不存在與跨租戶都是同一個 404（D-09）。
@Injectable()
export class JobsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: JobsRepository,
  ) {}

  async getJob(ws: WorkspaceContext, jobId: string): Promise<JobRow> {
    const job = await withTenant(this.db, ws.workspaceId, (tx) =>
      this.jobs.findById(ws.workspaceId, tx, jobId),
    );
    if (job === null) throw new AppError(ErrorCode.NOT_FOUND);
    return job;
  }
}
