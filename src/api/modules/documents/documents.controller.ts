import { Body, Controller, Headers, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { CurrentWorkspace } from '@/api/common/auth/current-workspace.decorator';
import type { WorkspaceContext } from '@/api/common/auth/workspace-context';
import { WorkspaceScopeGuard } from '@/api/common/auth/workspace-scope.guard';
import { ErrorResponseDto } from '@/api/common/filters/error-response.dto';
import { CreateDocumentAcceptedDto, CreateDocumentDto } from '@/api/modules/documents/documents.dto';
import { DocumentsService } from '@/api/modules/documents/documents.service';

@ApiTags('documents')
@ApiBearerAuth()
@Controller('v1/workspaces/:workspaceId/documents')
@UseGuards(WorkspaceScopeGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Create a document processing job (docs/DESIGN.md §5.3)' })
  @ApiParam({ name: 'workspaceId', example: 'ws_alpha' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '1-128 ASCII characters' })
  @ApiResponse({ status: 202, type: CreateDocumentAcceptedDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'VALIDATION_ERROR | IDEMPOTENCY_KEY_REQUIRED | CONTENT_SOURCE_INVALID | INVALID_STORAGE_KEY' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'UNAUTHORIZED' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'NOT_FOUND (workspace mismatch)' })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: 'IDEMPOTENCY_KEY_REUSED' })
  @ApiResponse({ status: 413, type: ErrorResponseDto, description: 'DOCUMENT_TOO_LARGE' })
  @ApiResponse({ status: 415, type: ErrorResponseDto, description: 'UNSUPPORTED_MEDIA_TYPE' })
  @ApiResponse({ status: 422, type: ErrorResponseDto, description: 'SIZE_MISMATCH' })
  async create(
    @CurrentWorkspace() ws: WorkspaceContext,
    @Body() dto: CreateDocumentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Record<string, unknown>> {
    const result = await this.documents.create(ws, dto, idempotencyKey);
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }
}
