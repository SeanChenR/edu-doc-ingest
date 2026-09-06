# doc-ingest

多租戶教材匯入服務：老師用自己的 API key 把教材 `POST` 進 workspace，服務立刻回 `202`，背景 worker 完成「文字抽取 → 建立向量 → 完成」，過程中可以查狀態、也可以用 SSE 即時看進度。

設計規格是 `docs/DESIGN.md`，每個決定與理由在 `docs/DECISIONS.md`（D-01 ～ D-26）；本文只摘要。

![doc-ingest 系統架構](docs/diagrams/architecture.png)

三個容器：`api`、`worker`、`db`。api 與 worker 是同一個 repo、同一份 `Dockerfile` 的兩個 target，共用 `src/shared/`。api → worker 靠 pgmq（純 SQL 佇列，與業務寫入同交易）；worker → api 靠 PostgreSQL `LISTEN/NOTIFY`（通知只當叫醒鈴，內容以資料表為準）。

## 1. 快速啟動

需求：Bun ≥ 1.4、PostgreSQL 18 + pgvector（本機 Homebrew 或容器）、Podman 或 Docker（可選）。

### 本機（Homebrew PostgreSQL）

```bash
brew install postgresql@18 pgvector && brew services start postgresql@18
createdb doc_ingest
bun install
cp .env.example .env            # 本機預設值已可直接用
bun run migrate                 # 建角色、pgvector、pgmq、六張表、RLS
bun run seed                    # 兩個 workspace、兩把 API key、各一份 ready 的範例 PDF
bun run dev                     # api（:3000）與 worker 一起起來，含熱重載
```

pgmq 不需要另外安裝：`migrations/pgmq/pgmq.sql` 已內附，由 `bun run migrate` 灌進去（D-23）。

### 容器（podman compose）

```bash
./scripts/compose-demo.sh       # 起 db / api / worker、對容器 db migrate + seed、POST 一份文件、等 worker 做到 ready
podman compose down             # 關掉（volume 保留）
```

`docker compose` 也能讀同一份 `docker-compose.yml`；容器 db 對外是 port **5433**，避免跟本機的 5432 打架。macOS 上若 `podman compose` 卡在鑰匙圈視窗，先用 `podman build --target api`、`--target worker` 與 `podman pull` 準備好映像，再 `podman compose up -d --no-build`。

### 檢查

```bash
bun test                        # 83 個 e2e + unit，打 .env 指定的資料庫，每個測試前清空租戶表
bun run lint && bun run fmt:check && bun run typecheck
```

## 2. 認證與 seed key

一把 API key = 一個 workspace 的完整權限（D-08）。請求帶 `Authorization: Bearer <key>`；資料庫只存 SHA-256，`revoked_at` 設了就失效。

| workspace | 名稱 | 本機 seed key（`.env.example`，僅供本機） |
|---|---|---|
| `ws_alpha` | Alpha 國中 | `dk_alpha_local_only` |
| `ws_beta` | Beta 高中 | `dk_beta_local_only` |

用另一個 workspace 的 key 讀資源，回應與「不存在」**逐位元相同**：`404 NOT_FOUND`，刻意不回 403（D-09）。

## 3. API 摘要

Swagger UI：http://localhost:3000/docs ，OpenAPI JSON：`/docs-json`。所有回應都帶 `X-Request-Id` 標頭與 `request_id` 欄位。

| Method | Path | 說明 |
|---|---|---|
| POST | `/v1/workspaces/:workspaceId/documents` | 建立文件處理任務，回 `202`；`Idempotency-Key` 必填 |
| GET | `/v1/documents/:documentId` | metadata + 最新 job 摘要 + 處理結果摘要（`text_preview`、embedding 模型） |
| GET | `/v1/jobs/:jobId` | 狀態、進度、attempt、`retries_used`、`last_error` |
| GET | `/v1/jobs/:jobId/events` | SSE：`snapshot` → 補發（帶 `Last-Event-ID`）→ 即時；終止後關閉 |
| GET | `/health`、`/ready` | liveness；readiness 檢查 DB 與 pgmq 佇列 |

```bash
# 建立文件（純文字直接貼；PDF 用 storage_key 指向 ./storage/ 下的檔案）
curl -s -X POST http://localhost:3000/v1/workspaces/ws_alpha/documents \
  -H 'Authorization: Bearer dk_alpha_local_only' -H 'Idempotency-Key: demo-1' \
  -H 'Content-Type: application/json' \
  -d '{"name":"unit-3.txt","mime_type":"text/plain","size_bytes":11,"content_text":"hello world","metadata":{"grade":5}}'
# → {"document_id":"doc_…","job_id":"job_…","status":"queued","request_id":"req_…"}

# 即時進度（伺服器在 completed / failed 後主動關閉）
curl -N -H 'Authorization: Bearer dk_alpha_local_only' http://localhost:3000/v1/jobs/<job_id>/events

# 查 job / 查 document
curl -s -H 'Authorization: Bearer dk_alpha_local_only' http://localhost:3000/v1/jobs/<job_id>
curl -s -H 'Authorization: Bearer dk_alpha_local_only' http://localhost:3000/v1/documents/<document_id>
```

一鍵重現整條流程（含冪等重播、409、跨租戶 404、失敗與重試）：`./scripts/curl-demo.sh`。Postman 使用者匯入 `postman/` 的 collection 與 environment，用 Collection Runner 由上往下跑即可。

錯誤一律是 `{ "error": { "code", "message", "request_id", "details?" } }`，`code` 見 `docs/DESIGN.md` §6.3（`VALIDATION_ERROR`、`IDEMPOTENCY_KEY_REQUIRED`、`CONTENT_SOURCE_INVALID`、`INVALID_STORAGE_KEY`、`UNAUTHORIZED`、`NOT_FOUND`、`IDEMPOTENCY_KEY_REUSED`、`DOCUMENT_TOO_LARGE`、`UNSUPPORTED_MEDIA_TYPE`、`SIZE_MISMATCH`、`INTERNAL_ERROR`、`NOT_READY`）。

測試用的失敗注入（`FAILURE_INJECTION=true` 時）：在 `content_text` 或檔名放 `[[FAIL_EXTRACT]]`、`[[FAIL_EMBED_ONCE]]`、`[[FAIL_EMBED]]`、`[[SLOW]]`。

## 4. 架構決策（摘要，完整版見 `docs/DECISIONS.md`）

一份文件從 `POST` 到 `completed` 的完整路徑（每支箭頭都是一個交易；NOTIFY 只當叫醒鈴）：

![一份文件的生命週期](docs/diagrams/document-lifecycle.png)

- **CQRS 混合制**（§2.1）：`POST` 是命令路徑，所有 `GET` 直接查表，不套 handler 儀式。
- **pgmq 與交易一致性**（D-03、D-12）：建立文件時 `documents`、`jobs`、`idempotency_keys`、`pgmq.send` 在**同一個交易**，不會有「job 建了但沒排隊」的孤兒。訊息只放 `{job_id, workspace_id}`，狀態永遠在 `jobs` 表。
- **LISTEN/NOTIFY 只當叫醒鈴**（D-04）：worker 每次改狀態在同交易 `INSERT job_events` + `NOTIFY`；api 收到後回表讀那一列再推 SSE。NOTIFY 不保證送達與順序，所以內容以表為準。多台 api 都 LISTEN 同一頻道即可橫向擴展。
- **手寫 SSE，不用 `@Sse()`**（D-05）：`job_events.id` 是 bigserial，就是 SSE 的 `id:`；`Last-Event-ID` 補發從那裡查。
- **404 而非 403**（D-09）：403 等於告訴對方「這個 id 存在」。
- **冪等表靠主鍵衝突當鎖**（D-11）：`(workspace_id, key)` 主鍵，`INSERT … ON CONFLICT DO NOTHING RETURNING` 搶到才建資源；10 個一模一樣的併發請求只會有一個贏。
- **Checkpoint 冪等**（D-13）：抽取結果存 `documents.extracted_text`，chunk 用 `(document_id, chunk_index)` upsert；重試不重抽、不重算、不重複付費。attempt 直接用 pgmq 的 `read_ct`。
- **worker 續租約與逾時**（§9.1）：處理中每 `VT/2` 秒 `set_vt` 續租約，只有 worker 真的死掉訊息才回佇列；單次 attempt 超過 `JOB_TIMEOUT_MS` 視為失敗走重試。
- **content_text 也走 StoragePort**（D-25）：貼上的文字先寫成檔案，之後與 PDF 完全同一條路徑；`extracted_text` 永遠是 worker 的產物。
- **不用 ORM**（D-02）、**Zod + nestjs-zod**（D-17）、**oxlint + oxfmt**（D-18）、**兩個映像一個 Dockerfile**（D-06）、**不做快取**（D-07）、**不做 RBAC**（D-08）。

## 5. 資安設計

- **租戶隔離兩道防線**（D-10）：第一道，每個 repository 方法第一參數都是 `workspaceId`，SQL 一律帶 `workspace_id`；第二道，`documents`、`document_chunks`、`jobs`、`job_events`、`idempotency_keys` 全部 `ENABLE` + `FORCE ROW LEVEL SECURITY`，api 的每個查詢都在 `withTenant()` 交易內先 `set_config('app.workspace_id')`。api 用 `app_user`（受 RLS 限制）；worker 用 `worker_user`（`BYPASSRLS` 才能跨租戶領佇列），但處理每件工作仍包 `withTenant`。測試裡有一條故意不帶 `WHERE` 的查詢，證明第二道真的擋住。
- **輸入限制**（§6.4）：MIME 白名單、`size_bytes` ≤ 10 MB 且與內容差異 ≤ 5 %、`metadata` 序列化 ≤ 4 KB、`name` 去路徑分隔符、body parser 層就擋大小。
- **`storage_key` 白名單**（D-21）：`^[a-z0-9_]+(/[A-Za-z0-9._-]+)+$`，不接受 `.` / `..` 段落，第一段必須等於呼叫者的 workspace；解析成實體路徑後再確認仍在 `STORAGE_ROOT` 之下。原始檔案不進資料庫。
- **日誌遮罩**（§7.4）：pino 在 logger 層遮 `authorization`、`content_text`、`extracted_text` 與 key/token/secret 類欄位；request 內每行 log 自動帶 `request_id`。錯誤訊息進 `jobs.last_error_message` 前經 `sanitizeError()` 去堆疊、金鑰樣式字串、URL query、絕對路徑。
- **錯誤不洩漏**：未預期例外對外固定 "Unexpected error."，`/ready` 失敗只回固定訊息，細節進 log。
- 兩輪 `security-audit`（§6–§8、worker 與 SSE）的發現都已修正；報告見專案外的 `~/security-audit-skill/edu-doc-ingest/`。

## 6. 已知限制

- **API key 撤銷延遲**：guard 快取 60 秒，撤銷的 key 在每台 api 上最多再活 60 秒。
- **沒有 rate limit**：同一把 key 可以無上限地 POST 10 MB 文件或開 SSE 連線；正式環境放到 `@nestjs/throttler`（以 workspace 為 key）或前面的 LB。
- **孤兒檔**：`content_text` 先寫檔再開交易，交易失敗時 best-effort 刪檔；刪不掉的檔不會被任何 document 指到（D-25）。正式環境用 Cloud Storage lifecycle rule 清。
- **LISTEN 重連未驗證**：api 的 `sql.listen` 在 DB 重啟後會不會自動重訂閱尚未實機測試；若不會，SSE 會靜音直到 api 重啟，`/ready` 仍回 200。
- **冪等列不清理**：`idempotency_keys.expires_at` 有寫，但沒有定時清除。
- **`FAILURE_INJECTION` 正式環境必須為 `false`**，否則租戶可用標記讓自己的 job 失敗（只影響自己的資料）。compose 預設開，因為它是驗收環境。
- **Embedding 是 mock**：sha256 產生的確定性向量，沒有語意；`document_chunks.embedding` 也還沒建索引（沒有查詢端點）。

## 7. 正式環境延伸

- **儲存**：`StoragePort` 換 Cloud Storage；上傳改 signed URL 直傳，API 只驗證與登記。
- **Embedding**：`EmbeddingPort` 換成經 LiteLLM gateway 接 Vertex AI / OpenAI `text-embedding-3-small`，加限流與成本紀錄；`document_chunks.embedding` 建 HNSW（cosine）索引。
- **快取**：熱門 document metadata 加 Memorystore 讀取快取，job 進入終止狀態時清除（D-07）。
- **身分**：政府 SSO（OIDC）→ Identity Platform 簽 JWT，claims 帶 workspace 清單與角色（owner / teacher / viewer），Guard 改驗簽 + `@Roles()`；API key 留給服務間呼叫（§7.1）。
- **Rate limit**：`@nestjs/throttler` 以 workspace 為 key。
- **Observability**：OpenTelemetry trace 串 `request_id`，pino → Cloud Logging（`LOG_PRETTY=false` 即原生 JSON）。
- **水平擴展**：多台 api 都 `LISTEN job_events` 即可；多台 worker 靠 pgmq 的可見性逾時與續租約互不重複。
- **佇列**：Cloud SQL 若不支援 pgmq 擴充套件，目前的 SQL 檔安裝方式（D-23）直接可用；或換 Cloud Tasks，`QueuePort` 介面不變。
- **Chunk 策略**：目前固定字元視窗（D-26），接真模型後改依標題 / 段落結構切分只換 `ChunkerPort` 的實作。

## 8. 後續延伸的端點（本次刻意不做，D-16）

文件與工作列表、chunks 查詢、cancel、retry、reprocess、multipart 上傳、向量搜尋、事件歷史查詢。

## 9. 專案結構與環境變數

```
src/api/        api 映像：common/（request id、auth、filter、interceptor）、modules/（health、documents、jobs、idempotency）
src/worker/     worker 映像：主迴圈、JobTransitions（所有狀態變更）、pipeline/（三階段與失敗注入）
src/shared/     兩邊共用：config、errors、logging、db（client、rows、repositories）、ports、adapters
migrations/     001 擴充套件 + pgmq + 佇列；002 六張表、RLS、權限；pgmq/pgmq.sql 原樣內附
scripts/        migrate、seed、dev、curl-demo、worker-demo、compose-demo
test/e2e、test/unit、postman/
docs/diagrams/  兩張圖的原始檔（.html，可用 diagram-design 重畫）、.svg、README 用的 .png
```

環境變數全部在 `.env.example`，含說明；規格對照 `docs/DESIGN.md` §13。
