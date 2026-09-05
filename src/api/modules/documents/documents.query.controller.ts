import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CurrentWorkspace } from '@/api/common/auth/current-workspace.decorator';
import type { WorkspaceContext } from '@/api/common/auth/workspace-context';
import { ErrorResponseDto } from '@/api/common/filters/error-response.dto';
import {
  type DocumentResponse,
  DocumentResponseDto,
} from '@/api/modules/documents/documents.query.dto';
import { DocumentsService } from '@/api/modules/documents/documents.service';

// 查詢路徑沒有 :workspaceId（§5.3）：租戶範圍來自 API key，跨租戶與不存在同為 404（D-09）。
@ApiTags('documents')
@ApiBearerAuth()
@Controller('v1/documents')
export class DocumentsQueryController {
  constructor(private readonly documents: DocumentsService) {}

  @Get(':documentId')
  @ApiOperation({
    summary: 'Document metadata, latest job summary and result summary (docs/DESIGN.md §5.3)',
  })
  @ApiParam({ name: 'documentId', example: 'doc_01J...' })
  @ApiResponse({ status: 200, type: DocumentResponseDto })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'UNAUTHORIZED' })
  @ApiResponse({
    status: 404,
    type: ErrorResponseDto,
    description: 'NOT_FOUND (missing or another workspace)',
  })
  async get(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Param('documentId') documentId: string,
  ): Promise<DocumentResponse> {
    return this.documents.getDocument(ws, documentId);
  }
}
