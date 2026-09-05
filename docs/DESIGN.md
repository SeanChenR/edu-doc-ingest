# doc-ingest — 設計規格文件

> 多租戶教材匯入服務（Document Ingestion Service）
> AI 教育平台的共用地基之一：老師在自己的 workspace 上傳教材，服務非同步完成「文字抽取 → 建立向量 → 完成」，並提供狀態查詢與即時進度。本文件記錄我們做了什麼、為什麼這樣做。

---

## 0. 需求摘要

這個服務要滿足的行為與品質要求：

**功能**
- 建立文件處理任務：接受文件名稱、MIME type、大小與文字內容或 storage key，立即回 `202` 與 `document_id` / `job_id` / `status` / `request_id`，實際處理交給背景 worker。
- 背景處理至少經過 `extracting → embedding → ready` 三個階段，進度隨時可查。
- 任務狀態查詢（狀態、進度、重試次數、錯誤原因）與 SSE 即時進度串流（階段事件、進度、終止事件）。
- 文件 metadata 與處理結果查詢。
- `/health` 與 `/ready` 健康檢查；統一的錯誤格式讓呼叫端能依錯誤碼採取行動。

**可靠性**
- `Idempotency-Key`：同一個 workspace 重送相同請求不會建立第二個 document 或 job。
- 外部處理失敗最多自動重試 2 次；最終失敗保留可理解、不含機密的錯誤原因。
- worker 重試不可造成重複的不可逆副作用。

**資安與隔離**
- 使用者不能讀取、更新或訂閱其他 workspace 的 document 或 job；資源不存在或不屬於目前 workspace 時，回應不可洩漏其他租戶的存在。
- 限制可接受的檔案類型與大小；不接受任意本機路徑；不把文件內容寫進一般 application log。
- 資料庫層以 Row-Level Security 作為第二道隔離。

**工程**
- 模型服務、檔案儲存、queue 可用本機實作取代，但保留清楚的介面邊界，並說明正式環境的替換方案。
- 至少兩個 workspace 的 seed data，可驗證租戶隔離。
- 自動化測試與可重現的 curl script，涵蓋成功、輸入錯誤、租戶隔離、重試與冪等。

---

## 1. 技術選型

| 項目 | 選擇 | 說明 |
|---|---|---|
| Runtime | Bun（最新版） | 需要 ≥ 支援 `sql.listen` / `sql.notify` 的版本 |
| 框架 | NestJS | 與團隊技術棧一致；模組、DI、Guard、Interceptor 的心智模型與 Spring Boot 相近 |
| API 文件 | `@nestjs/swagger` | 掛在 `/docs`，OpenAPI JSON 在 `/docs-json` |
| 語言 | TypeScript（strict） | |
| 資料庫 | PostgreSQL 18 + pgvector + pgmq | 容器：`pgvector/pgvector:pg18-trixie`；pgmq 不裝擴充套件，由 migration 以 repo 內附的 `migrations/pgmq/pgmq.sql` 安裝（D-23）；本機：Homebrew `postgresql@18`，見 §1.4 |
| 資料庫存取 | 不用 ORM，Bun 內建 `SQL` 客戶端直接寫原生 SQL | 每張表一個 Repository 集中 SQL；每張表手寫一個 Row 介面；遷移用編號 `.sql` 檔 + 自寫 30 行執行腳本（見 §1.3） |
| Queue | pgmq | 純 SQL 函式，與業務寫入同交易 |
| 即時通知 | PostgreSQL LISTEN / NOTIFY | worker → API 的進度傳遞，API 用 Bun 內建 `sql.listen` |
| 驗證 | Zod（或 class-validator） | 二擇一，全專案統一；Zod 搭配 `nestjs-zod` 可自動產 Swagger schema |
| 日誌 | pino（`nestjs-pino`） | 結構化、支援 redaction |
| 測試 | `bun test` + supertest | e2e 測試打真實 PostgreSQL 容器 |
| 檔案儲存 | 本機資料夾 `./storage/`（gitignore） | 正式環境換 Cloud Storage |
| 解析器 | 介面 `ParserPort`；實作 `unpdf`（PDF）+ 直接解碼（text / markdown） | 純 TypeScript，Bun 可跑；正式環境若需圖片／表格抽取再評估 MarkItDown sidecar，本次只在 README 提 |
| Embedding | 介面 `EmbeddingPort`；只有 mock | sha256 → 1536 維確定性假向量並正規化；正式環境經 LiteLLM gateway 接 Vertex AI / OpenAI，本次不實作 |
| 容器工具 | Podman（`podman compose`），Docker 相容 | 見 §1.5 |
| Lint / Format | oxlint + oxfmt（oxc 系列） | 見 §1.6 |
| 快取 | 本次不做 | 見 §1.1 |
| 身分 | API key（一把 key = 一個 workspace 全權限） | 不做 RBAC，見 §7.1 |

### 1.1 關於快取的釐清

Bun「內建」的是 Redis **客戶端**（連線用），不是快取本身。也就是說 Bun 沒有自帶快取，要嘛連外部 Redis，要嘛在程式記憶體裡用 `Map` 自己做。

目前的讀取量很小，做快取沒有實質效益，反而多了「快取失效」這個 bug 來源。決定：**本次不做快取**，README 的延伸章節寫明正式環境對熱門 document metadata 加 Memorystore 讀取快取，並說明失效策略（job 進入終止狀態時清除）。

### 1.2 NestJS on Bun 的注意事項

- 需要 `reflect-metadata` 與 `emitDecoratorMetadata`，Bun 支援，但開工第一件事是跑一個最小 Nest app 確認 Swagger 與 DI 都正常。
- 啟動指令用 `bun --bun src/api/main.ts` / `bun --bun src/worker/main.ts`（不要走 `nest start` 的 Node 路徑）。
- 若遇到無法解決的相容問題，退路是 Bun 當套件管理器、Node 當 runtime，README 註明。

### 1.3 資料庫存取約定（不用 ORM）

- 查詢一律用 Bun 內建 `SQL` 的樣板字串，參數自動綁定，禁止字串拼接 SQL。
- `src/shared/db/repositories/` 每張表一個檔案，所有 SQL 只出現在這裡；Service 只呼叫 Repository 方法。
- `src/shared/db/rows.ts` 手寫各表的 Row 介面（`WorkspaceRow`、`DocumentRow`、`JobRow`…），查詢結果標成對應型別。
- 遷移：`migrations/NNN_name.sql` 依編號執行；`scripts/migrate.ts` 建立 `schema_migrations(version, applied_at)` 表，跳過已執行的版本，每個檔案包在一個交易內。
- 交易：`db.transaction(async (tx) => …)`；租戶交易一律經 `withTenant(workspaceId, fn)` 先 `SET LOCAL app.workspace_id`。
- pgmq 與 LISTEN/NOTIFY 都是原生 SQL 或 `sql.listen` / `sql.notify`，不需要任何額外套件。

### 1.4 本機開發：Homebrew PostgreSQL 18

pgmq 是純 SQL 的擴充套件（不需要 Rust / pgrx），但 Homebrew 與 `pgvector/pgvector` 官方映像都沒有內建。依 D-23，**不裝成擴充套件**，改由 migration 直接執行 pgmq 官方的 `pgmq.sql`（放在 repo 的 `migrations/pgmq/pgmq.sql`，檔頭註明來源版本），把函式灌進 `pgmq` schema。本機、compose 的 `db` 容器、CI 三邊走同一條路，不需要 `make install`，也不需要擴充套件權限（正式環境 Cloud SQL 亦適用）。

```bash
brew install postgresql@18 pgvector
brew services start postgresql@18
createdb doc_ingest
# 之後 bun run migrate：001 執行 CREATE EXTENSION vector、灌 pgmq.sql、pgmq.create('document_jobs')
```

migration 需要建擴充套件與角色，所以 `scripts/migrate.ts` 與 `scripts/seed.ts` 用 `DATABASE_URL_ADMIN`（本機即 Homebrew 的預設帳號）連線；api 與 worker 執行時分別用 `DATABASE_URL`（`app_user`）與 `DATABASE_URL_WORKER`（`worker_user`）。`app_user` / `worker_user` 的密碼由 migrate.ts 從 `APP_DB_PASSWORD` / `WORKER_DB_PASSWORD` 讀入，SQL 檔內不出現密碼。

建議的本機工作流：資料庫用 Homebrew（或只起 `db` 容器），`api` 與 `worker` 直接在宿主機 `bun --bun` 跑，熱重載快、除錯方便。compose 全套只在驗收與 CI 用。

### 1.5 Podman 注意事項

- `podman compose up` 直接讀同一份 `docker-compose.yml`。
- `depends_on.condition: service_healthy` 需較新版 podman-compose；為避免依賴它，`api` 與 `worker` 啟動時自行重試連線資料庫（指數退避、最多 30 秒），連不上才退出。
- 容器內連宿主機的資料庫用 `host.containers.internal`（Docker 為 `host.docker.internal`），`.env.example` 註明。
- 映像檔 build 指令用 `podman build --target api` / `--target worker`，與 Docker 相同。

### 1.6 Lint 與 Format（oxc）

- `oxlint`：`.oxlintrc.json` 啟用 `typescript`、`unicorn`、`oxc` 外掛，`correctness` 類別為 error，`suspicious` 為 warn；`no-unused-vars` 允許 `_` 前綴。開啟型別感知檢查（`oxlint --type-aware`，需安裝 `oxlint-tsgolint`），主要為了 `no-floating-promises` 抓 worker 裡漏 `await` 的 Promise。
- `oxfmt`：`.oxfmtrc.jsonc` 設 `singleQuote: true`、`printWidth: 100`、`trailingComma: "all"`；開啟 import 排序。
- `package.json` scripts：`lint`、`lint:fix`、`fmt`、`fmt:check`；CI 與 pre-commit（可選）跑 `fmt:check` + `lint`。
- 不裝 ESLint / Prettier。

---

## 2. 系統架構

```
┌──────────────┐    HTTP / SSE    ┌──────────────────┐
│  Client      │ ───────────────▶ │  api (NestJS)    │
│  (瀏覽器 /   │ ◀─────────────── │  image: api      │
│   其他服務)  │                  └────────┬─────────┘
└──────────────┘                           │ SQL / LISTEN
                                           ▼
                              ┌────────────────────────┐
                              │  PostgreSQL 18         │
                              │  + pgvector + pgmq     │
                              │  (jobs / documents /   │
                              │   chunks / events /    │
                              │   pgmq.q_document_jobs)│
                              └────────────┬───────────┘
                                           │ SQL / NOTIFY
                              ┌────────────▼───────────┐
                              │  worker (NestJS)       │
                              │  image: worker         │
                              │  ├ ParserPort (mock)   │
                              │  ├ EmbeddingPort(mock) │
                              │  └ StoragePort (local) │
                              └────────────────────────┘
```

三個容器：`api`、`worker`、`db`。`api` 與 `worker` 是**兩個獨立的映像檔**，各有自己的進入點與 Nest module，但在同一個 repo 共用 `src/shared/`（資料表型別、Repository、Port 介面、錯誤碼、設定）。用一個多階段 Dockerfile 的兩個 target 產出：

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

FROM base AS api
EXPOSE 3000
CMD ["bun", "--bun", "src/api/main.ts"]

FROM base AS worker
CMD ["bun", "--bun", "src/worker/main.ts"]
```

docker compose 中 `api` 服務 `build.target: api`，`worker` 服務 `build.target: worker`。這樣不需要 `ROLE` 環境變數；正式環境在 Cloud Run 上也是兩個獨立服務，各自擴縮。之後 worker 若需要額外系統套件，只需在 `worker` stage 加層，不影響 `api`。

### 2.1 CQRS 混合制

依團隊的 CQRS 混合制切分：

- **Command 路徑**（長任務）：建立文件 → 驗證 → 冪等檢查 → 單一交易寫入 `documents` + `jobs` + `idempotency_keys` + `pgmq.send` → 回 202 → 由 worker 非同步處理，進度走 SSE。
- **Query 路徑**（簡單讀取）：所有 GET 直接查表，不套 command / handler 儀式。
- **簡單實體**（例如 workspace 資訊）：同步 CRUD。

### 2.2 請求生命週期（api）

```
Request
 → RequestIdMiddleware      產生或沿用 X-Request-Id，掛到 AsyncLocalStorage
 → ApiKeyGuard              解析 Bearer token → workspace context
 → WorkspaceScopeGuard      路徑 :id 必須等於 token 的 workspace（不符回 404）
 → ValidationPipe           Zod schema 驗證 body / params / query
 → Controller → Service     業務邏輯
 → ResponseInterceptor      補上 request_id、X-Request-Id header
 → ExceptionFilter          任何錯誤轉成 §6 統一格式
```

---

## 3. 專案結構

```
doc-ingest/
├── src/
│   ├── api/                       # api 映像的進入點與模組
│   │   ├── main.ts
│   │   ├── api.module.ts
│   │   ├── common/
│   │   │   ├── request-id/        # middleware + AsyncLocalStorage
│   │   │   ├── auth/              # ApiKeyGuard、WorkspaceScopeGuard、@CurrentWorkspace()
│   │   │   ├── filters/           # ExceptionFilter → §6 統一錯誤格式
│   │   │   └── interceptors/      # ResponseInterceptor 補 request_id
│   │   └── modules/
│   │       ├── workspaces/
│   │       ├── documents/         # controller、service、dto
│   │       ├── jobs/              # controller、service、sse.controller（手寫串流，不用 @Sse）
│   │       ├── health/
│   │       └── idempotency/
│   ├── worker/                    # worker 映像的進入點與模組
│   │   ├── main.ts
│   │   ├── worker.module.ts
│   │   ├── worker.service.ts      # 輪詢 pgmq、分派、優雅關閉
│   │   └── pipeline/              # extracting / embedding / finalize 三個 stage
│   └── shared/                    # 兩個映像共用
│       ├── config/                # env schema (Zod)、載入與驗證
│       ├── errors/                # AppError、ErrorCode enum、sanitizeError
│       ├── logging/               # pino 設定、redaction 規則
│       ├── db/
│       │   ├── client.ts          # Bun SQL client、transaction、withTenant()
│       │   ├── rows.ts            # 各表 Row 介面（手寫）
│       │   └── repositories/      # 每張表一檔，所有 SQL 集中於此
│       ├── ports/                 # 介面定義
│       │   ├── storage.port.ts
│       │   ├── parser.port.ts
│       │   ├── embedding.port.ts
│       │   ├── chunker.port.ts
│       │   └── queue.port.ts
│       └── adapters/              # 各介面的實作
│           ├── storage/local-fs.storage.ts
│           ├── parser/unpdf.parser.ts         # PDF 用 unpdf，text/markdown 直接解碼
│           ├── embedding/mock.embedding.ts
│           ├── chunker/fixed-window.chunker.ts
│           └── queue/pgmq.queue.ts
├── migrations/                    # 001_extensions.sql（vector、pgmq.sql、佇列）、002_tables.sql（六張表、RLS、角色）…
│   └── pgmq/pgmq.sql              # pgmq 官方 SQL，原樣放入（D-23）
├── test/
│   ├── e2e/                       # 對真實 DB 的 API 測試
│   └── unit/
├── scripts/
│   ├── migrate.ts                 # 依編號執行 migrations，記錄於 schema_migrations
│   ├── seed.ts
│   └── curl-demo.sh               # 一鍵重現主流程
├── storage/                       # 本機檔案儲存（gitignore）
├── docker-compose.yml
├── Dockerfile                     # 多階段：base → api / worker 兩個 target
├── .env.example
└── README.md
```

---

## 4. 資料表設計

所有 ID 使用帶前綴的字串（`ws_`、`doc_`、`job_`、`key_`），內部用 ULID 產生，方便在日誌與 URL 中辨識型別。時間欄位一律 `timestamptz`。

### 4.1 `workspaces`

| 欄位 | 型別 | 說明 |
|---|---|---|
| id | text PK | `ws_...` |
| name | text | |
| created_at | timestamptz | |

### 4.2 `api_keys`

| 欄位 | 型別 | 說明 |
|---|---|---|
| id | text PK | `key_...` |
| workspace_id | text FK → workspaces | |
| key_hash | text unique | SHA-256 of raw key；不存明文 |
| label | text | 例如 "seed-teacher-a" |
| created_at | timestamptz | |
| revoked_at | timestamptz null | 撤銷後不可用 |

### 4.3 `documents`

| 欄位 | 型別 | 說明 |
|---|---|---|
| id | text PK | `doc_...` |
| workspace_id | text FK | 租戶欄位 |
| name | text | 原始檔名 |
| mime_type | text | 白名單內 |
| size_bytes | integer | |
| storage_key | text | 指向 StoragePort 的 key，格式受限，見 §6.2 |
| status | text | `pending` / `processing` / `ready` / `failed`；由最新 job 同步 |
| latest_job_id | text null | 最近一次處理的 job |
| extracted_text | text null | 抽取完成後寫入（checkpoint） |
| page_count | integer null | |
| chunk_count | integer null | |
| deleted_at | timestamptz null | 軟刪除 |
| created_at / updated_at | timestamptz | |

索引：`(workspace_id, created_at desc)`、`(workspace_id, status)`。

### 4.4 `document_chunks`

| 欄位 | 型別 | 說明 |
|---|---|---|
| id | text PK | |
| document_id | text FK | |
| workspace_id | text | 租戶欄位（為 RLS 冗餘） |
| chunk_index | integer | |
| content | text | |
| token_count | integer | |
| embedding | vector(1536) | pgvector |
| created_at | timestamptz | |

唯一鍵：`(document_id, chunk_index)` — 重試時 upsert，保證不重複。
索引：`embedding` 暫不建（沒有查詢端點）；README 說明正式環境建 HNSW（cosine）。

### 4.5 `jobs`

| 欄位 | 型別 | 說明 |
|---|---|---|
| id | text PK | `job_...` |
| workspace_id | text FK | 租戶欄位 |
| document_id | text FK | |
| kind | text | 固定 `ingest`（預留欄位） |
| status | text | `queued` / `extracting` / `embedding` / `ready` / `failed` |
| progress | smallint | 0–100 |
| attempt | smallint | 目前執行到第幾次（1 起算） |
| max_attempts | smallint | 預設 3 = 首次 + 重試 2 次 |
| last_error_code | text null | 例如 `EMBEDDING_PROVIDER_ERROR` |
| last_error_message | text null | 已過濾、不含秘密 |
| queue_msg_id | bigint null | 對應 pgmq 的 msg_id |
| started_at / finished_at | timestamptz null | |
| created_at / updated_at | timestamptz | |

索引：`(workspace_id, created_at desc)`、`(document_id)`。

### 4.6 `job_events`

| 欄位 | 型別 | 說明 |
|---|---|---|
| id | bigserial PK | 即 SSE 的 event id，用於 `Last-Event-ID` |
| job_id | text FK | |
| workspace_id | text | 租戶欄位 |
| type | text | `stage_changed` / `progress` / `retry_scheduled` / `completed` / `failed` |
| stage | text null | |
| progress | smallint | |
| attempt | smallint | |
| message | text null | 人可讀的短訊息 |
| payload | jsonb null | 額外資料（例如 chunk_count） |
| created_at | timestamptz | |

索引：`(job_id, id)`。

### 4.7 `idempotency_keys`

| 欄位 | 型別 | 說明 |
|---|---|---|
| workspace_id | text | |
| key | text | client 送的 Idempotency-Key |
| request_hash | text | 對正規化後 body 的 SHA-256 |
| response_status | smallint | 原始回應狀態碼 |
| response_body | jsonb | 原始回應內容，重送時原樣回傳 |
| created_at | timestamptz | |
| expires_at | timestamptz | 建議 24 小時 |

主鍵：`(workspace_id, key)`。

### 4.8 pgmq 佇列

- 佇列名稱：`document_jobs`
- 訊息內容：`{"job_id": "job_...", "workspace_id": "ws_..."}`
- 可見性逾時：`WORKER_VISIBILITY_TIMEOUT_SEC`（預設 60）

### 4.9 Seed data

- `ws_alpha`（"Alpha 國中"）：api key `dk_alpha_...`；預先放一份 `ready` 狀態的文件與 chunks。
- `ws_beta`（"Beta 高中"）：api key `dk_beta_...`；預先放一份 `ready` 文件。
- 明文 key 只出現在 `seed.ts` 與 `.env.example`（標註僅供本機），資料庫只存雜湊。

---

## 5. API 設計

### 5.1 通用規則

- 版本前綴 `/v1`；Swagger UI 在 `/docs`。
- 身分：`Authorization: Bearer <api_key>`。缺少或無效 → 401 `UNAUTHORIZED`。
- 租戶邊界：路徑中的 `:workspaceId` 必須等於 token 對應的 workspace；不符 → **404 `NOT_FOUND`**（刻意不回 403，避免確認資源存在）。
- 每個回應都帶 `X-Request-Id` header，body 也帶 `request_id`。client 可自帶 `X-Request-Id`（限 UUID / ULID 格式，否則忽略並自產）。
- 時間格式 ISO 8601 UTC。
- Idempotency-Key 為 POST 必填（缺少 → 400 `IDEMPOTENCY_KEY_REQUIRED`）。

### 5.2 範圍

本次實作 4 支業務端點 + 2 支健康檢查。曾規劃的擴充端點（列表、chunks、cancel、retry、reprocess、multipart 上傳、向量搜尋）列於 README 的「後續延伸」章節，暫不實作。

### 5.3 Documents

| Method | Path | 用途 |
|---|---|---|
| POST | `/v1/workspaces/:workspaceId/documents` | JSON 建立文件處理任務 |
| GET | `/v1/documents/:documentId` | metadata + 最新 job 摘要 + 處理結果摘要 |

#### POST `/v1/workspaces/:workspaceId/documents`

Request body（`content_text` 與 `storage_key` 二擇一，兩者皆有或皆無 → 400）：

```json
{
  "name": "unit-3-fractions.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 48213,
  "content_text": "……純文字內容……",
  "storage_key": "ws_alpha/2026/09/unit-3.pdf",
  "metadata": { "grade": 5, "subject": "math" }
}
```

Response `202 Accepted`：

```json
{
  "document_id": "doc_01J...",
  "job_id": "job_01J...",
  "status": "queued",
  "request_id": "req_01J..."
}
```

同 Idempotency-Key 重送 → 回同一份 202 body（不建新資源）；同 key 但 body 不同 → 409 `IDEMPOTENCY_KEY_REUSED`。

#### GET `/v1/documents/:documentId`

```json
{
  "id": "doc_01J...",
  "workspace_id": "ws_alpha",
  "name": "unit-3-fractions.pdf",
  "mime_type": "application/pdf",
  "size_bytes": 48213,
  "status": "ready",
  "page_count": 12,
  "chunk_count": 37,
  "metadata": { "grade": 5, "subject": "math" },
  "latest_job": {
    "id": "job_01J...",
    "status": "ready",
    "progress": 100,
    "attempt": 1,
    "finished_at": "2026-09-04T08:12:31Z"
  },
  "result": {
    "text_preview": "第三單元 分數……（前 500 字）",
    "embedding_model": "mock-1536",
    "embedding_dimensions": 1536
  },
  "created_at": "2026-09-04T08:12:01Z",
  "updated_at": "2026-09-04T08:12:31Z",
  "request_id": "req_..."
}
```

`result` 在非 `ready` 狀態為 `null`。

### 5.4 Jobs

| Method | Path | 用途 |
|---|---|---|
| GET | `/v1/jobs/:jobId` | 狀態、進度、attempt、錯誤 |
| GET | `/v1/jobs/:jobId/events` | SSE 串流；支援 `Last-Event-ID` |

#### GET `/v1/jobs/:jobId`

```json
{
  "id": "job_01J...",
  "workspace_id": "ws_alpha",
  "document_id": "doc_01J...",
  "kind": "ingest",
  "status": "embedding",
  "progress": 55,
  "attempt": 2,
  "max_attempts": 3,
  "retries_used": 1,
  "last_error": {
    "code": "EMBEDDING_PROVIDER_ERROR",
    "message": "Embedding provider returned 503 on attempt 1."
  },
  "started_at": "2026-09-04T08:12:02Z",
  "finished_at": null,
  "created_at": "2026-09-04T08:12:01Z",
  "updated_at": "2026-09-04T08:12:20Z",
  "request_id": "req_..."
}
```

`last_error` 無錯誤時為 `null`。`retries_used = attempt - 1`。

#### GET `/v1/jobs/:jobId/events`（SSE）

- Header：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`X-Accel-Buffering: no`。
- 連線後立即送一則 `snapshot` 事件（目前狀態），再依序推送新事件。
- 若帶 `Last-Event-ID`，先補發 `job_events.id > Last-Event-ID` 的歷史事件，再接即時。
- 每 15 秒送一行註解 `: ping` 保活。
- job 進入 `ready` / `failed` 時送對應終止事件後關閉連線。
- 若 job 連線時已是終止狀態：送 `snapshot` + 終止事件後立即關閉。
- 租戶不符 → 一般 404 JSON 回應，不會建立串流。

事件格式：

```
id: 42
event: stage_changed
data: {"job_id":"job_01J...","stage":"embedding","progress":50,"attempt":1,"at":"2026-09-04T08:12:10Z"}

id: 43
event: progress
data: {"job_id":"job_01J...","stage":"embedding","progress":75,"attempt":1,"at":"..."}

id: 44
event: completed
data: {"job_id":"job_01J...","status":"ready","progress":100,"chunk_count":37,"at":"..."}
```

事件型別：`snapshot`、`stage_changed`、`progress`、`retry_scheduled`、`completed`、`failed`。

### 5.5 Health

| Method | Path | 用途 |
|---|---|---|
| GET | `/health` | liveness：process 活著就 200 `{ "status": "ok" }` |
| GET | `/ready` | readiness：檢查 DB 連線與 pgmq 佇列存在；失敗 503 `NOT_READY` |

Health 端點不需要身分驗證。

---

## 6. 回應格式規範

### 6.1 成功回應

- 單一資源：資源欄位攤平在最上層，末尾附 `request_id`。
- 202：回最小必要欄位（見 §5.3 範例），不回完整資源。

### 6.2 錯誤回應

所有錯誤（含框架層 404、驗證失敗、未捕捉例外）皆由 `AppExceptionFilter` 統一轉成：

```json
{
  "error": {
    "code": "DOCUMENT_TOO_LARGE",
    "message": "Document exceeds the allowed size of 10 MB.",
    "request_id": "req_01J...",
    "details": [
      { "field": "size_bytes", "issue": "must be <= 10485760" }
    ]
  }
}
```

`details` 僅在驗證錯誤時出現。`message` 面向開發者、英文、單句、不含堆疊、不含任何機密。

### 6.3 錯誤碼一覽

| HTTP | code | 觸發條件 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | schema 驗證失敗（附 details） |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | POST 缺少 Idempotency-Key |
| 400 | `CONTENT_SOURCE_INVALID` | `content_text` / `storage_key` 皆有或皆無 |
| 400 | `INVALID_STORAGE_KEY` | 含 `..`、開頭 `/`、反斜線、非允許字元，或不在自己的 workspace 前綴下 |
| 401 | `UNAUTHORIZED` | 缺少、格式錯誤、已撤銷或不存在的 API key |
| 404 | `NOT_FOUND` | 資源不存在 **或** 不屬於目前 workspace（兩者訊息完全相同） |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 同 key、不同 request_hash |
| 413 | `DOCUMENT_TOO_LARGE` | `size_bytes` 或實際內容超過上限 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | MIME 不在白名單 |
| 422 | `SIZE_MISMATCH` | 宣告的 `size_bytes` 與實際內容長度差異超過容忍值 |
| 500 | `INTERNAL_ERROR` | 未預期例外；訊息固定為 "Unexpected error."，細節只進 log |
| 503 | `NOT_READY` | `/ready` 檢查失敗 |

Worker 端的錯誤碼（寫入 `jobs.last_error_code`，不對應 HTTP）：
`EXTRACTION_FAILED`、`EMBEDDING_PROVIDER_ERROR`、`STORAGE_READ_FAILED`、`MAX_ATTEMPTS_EXCEEDED`。

### 6.4 輸入限制

| 項目 | 規則 |
|---|---|
| `name` | 1–255 字元；去除路徑分隔符 |
| `mime_type` | 白名單：`application/pdf`、`text/plain`、`text/markdown` |
| `size_bytes` | 1 ≤ n ≤ `MAX_DOCUMENT_BYTES`（預設 10 MB） |
| `content_text` | 長度 ≤ `MAX_DOCUMENT_BYTES`；與 `size_bytes` 差異 > 5% → `SIZE_MISMATCH` |
| PDF 內容 | 由 `storage_key` 指向 `./storage/` 下預先放好的檔案（seed 會放兩份範例 PDF）；讀取前以 magic bytes `%PDF-` 二次驗證 |
| `storage_key` | 正規式 `^[a-z0-9_]+(/[A-Za-z0-9._-]+)+$`，且第一段必須等於目前 `workspace_id` |
| `metadata` | 可選 JSON object，序列化後 ≤ 4 KB |
| `Idempotency-Key` | 1–128 字元 ASCII |

---

## 7. 資安與租戶隔離

### 7.1 身分模型與解析（不做 RBAC）

身分模型：**一把 API key = 一個 workspace 的完整權限**。目前的需求只有租戶隔離，沒有角色概念，因此不實作 RBAC；金鑰只存雜湊、可撤銷。

`ApiKeyGuard`：取 Bearer token → SHA-256 → 查 `api_keys.key_hash` 且 `revoked_at IS NULL` → 把 `{ workspaceId, apiKeyId }` 放進 request context。查詢結果快取於記憶體 60 秒（這是唯一的快取，屬於 guard 內部細節）。

`WorkspaceScopeGuard`：路徑含 `:workspaceId` 的端點，比對其與 context 的 workspaceId，不符回 404。

正式環境演進（README 說明，不實作）：政府 SSO（OIDC）登入後由 Identity Platform 簽發 JWT，claims 含使用者所屬的 workspace 清單與角色（owner / teacher / viewer）；Guard 改為驗簽 + 讀 claims，路由以 `@Roles()` 裝飾器限制，API key 保留給服務間呼叫。

### 7.2 應用層隔離（第一道）

- 所有 repository 方法都以 `workspaceId` 為必要參數，SQL 一律帶 `WHERE workspace_id = $1`。
- 不存在與跨租戶都回同一個 404，回應 body 逐位元相同。
- SSE 訂閱前先做同樣的查詢；通過才建立串流。

### 7.3 Row-Level Security（第二道，本次實作）

- 應用程式用非 superuser 角色 `app_user` 連線。
- 對 `documents`、`document_chunks`、`jobs`、`job_events`、`idempotency_keys` 開 RLS：
  ```sql
  ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
  ALTER TABLE documents FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON documents
    USING (workspace_id = current_setting('app.workspace_id', true));
  ```
- `DbModule.withTenant(workspaceId, fn)`：開交易 → `SET LOCAL app.workspace_id = $1` → 執行 `fn` → commit。所有 api 端的查詢都透過它。
- worker 用另一個角色 `worker_user`，具 `BYPASSRLS`（需要跨租戶處理佇列），但每次處理都以訊息中的 `workspace_id` 再包一層 `withTenant`，避免程式 bug 寫錯租戶。
- 測試中放一個「故意省略 WHERE workspace_id」的查詢，證明 RLS 仍擋住。



### 7.4 敏感資料與日誌

- pino redaction：`req.headers.authorization`、`body.content_text`、任何鍵名含 `key`、`token`、`secret` 的欄位。
- 日誌只記 `document_id`、`mime_type`、`size_bytes`、`content_length`，永遠不記內容或 `text_preview`。
- 錯誤訊息進 `jobs.last_error_message` 前經過 `sanitizeError()`：去除 URL query string、API key 樣式字串（`sk-…`、`Bearer …`）、檔案系統絕對路徑、堆疊。
- `.env` 不進版控；`.env.example` 只有佔位值。
- `storage_key` 解析為實體路徑時用 `path.resolve` 後確認仍在 `STORAGE_ROOT` 之下。

### 7.5 其他

- Helmet 預設 header。
- Body 大小上限與 `MAX_DOCUMENT_BYTES` 對齊，在 body parser 層就擋。
- 速率限制：本次不做，README 提 `@nestjs/throttler` 以 workspace 為 key。

---

## 8. 冪等（Idempotency-Key）

流程（在同一個交易內）：

1. 計算 `request_hash = sha256(canonical_json(body))`（欄位排序、去除 `metadata` 以外的空白）。
2. `INSERT INTO idempotency_keys (workspace_id, key, request_hash, ...) ON CONFLICT DO NOTHING RETURNING *`。
3. 有插入成功 → 是新請求，繼續建立 documents / jobs / `pgmq.send`，最後 `UPDATE idempotency_keys SET response_status, response_body`。
4. 沒插入成功 → 查既有列：
   - `request_hash` 相同 → 回存好的 `response_status` + `response_body`（加 header `Idempotent-Replayed: true`）。
   - 不同 → 409 `IDEMPOTENCY_KEY_REUSED`。
   - 併發時：主鍵衝突會讓後到者等前一筆交易 commit，因此讀到的 `response_body` 已完整。
5. 過期列清理：本次不做，README 提 worker 定時清除。

---

## 9. Worker 與處理流程

### 9.1 主迴圈

```
loop:
  msgs = pgmq.read('document_jobs', vt = VISIBILITY_TIMEOUT, qty = CONCURRENCY)
  if empty: sleep(POLL_INTERVAL_MS); continue
  for each msg (並行，上限 CONCURRENCY):
      handle(msg)
```

- `POLL_INTERVAL_MS` 預設 500，`CONCURRENCY` 預設 2。
- 收到 SIGTERM：停止領新訊息，等進行中的 job 完成（上限 30 秒）後退出；未完成的訊息會在 vt 到期後自動回到佇列。

### 9.2 `handle(msg)`

```
job = load job (withTenant(msg.workspace_id))
if job.status in terminal: pgmq.archive(msg); return          # 重複投遞保護

attempt = msg.read_ct                                          # pgmq 記錄的領取次數
update jobs set attempt = attempt, status = 'extracting', started_at = coalesce(started_at, now())
emit event 'stage_changed' (extracting, 10)

try:
    stage_extract(job)        # 冪等，見 9.3
    stage_embed(job)          # 冪等
    stage_finalize(job)
    pgmq.archive(msg)
    emit 'completed'
catch (err):
    handle_failure(job, msg, err)   # 見 9.4
```

每次狀態變更都做三件事，且在同一交易內：`UPDATE jobs`、`INSERT job_events`、`NOTIFY job_events, '{"job_id":..., "event_id":...}'`。API 端收到通知後**回資料庫讀該 event 列**再推 SSE，通知本身只當叫醒鈴。

### 9.3 三個階段與冪等設計

| 階段 | 進度 | 做什麼 | 冪等保證 |
|---|---|---|---|
| `extracting` | 10 → 40 | 從 StoragePort 讀檔（或直接用 `content_text`），呼叫 ParserPort 取得純文字與 page_count，寫入 `documents.extracted_text` | 若 `extracted_text` 已存在則跳過整段（checkpoint） |
| `embedding` | 40 → 90 | 切 chunk（策略待實作時決定，先預留 `ChunkerPort`），逐批呼叫 EmbeddingPort，upsert `document_chunks`；每批完成推一次 `progress` | `(document_id, chunk_index)` 唯一鍵 upsert；重試從已存在的 chunk 之後接續，不重算 |
| `ready` | 100 | 更新 `documents.status/chunk_count`、`jobs.status = ready`、`finished_at` | 只寫狀態 |

「不可逆副作用」在本專案就是：對外部 embedding 服務的付費呼叫、寫入 chunk。前者靠 checkpoint 避免重複計費，後者靠唯一鍵。

每階段加入 `STAGE_DELAY_MS`（預設 800）的人為延遲，讓 SSE 能看得到進度；正式環境設 0。

### 9.4 失敗與重試

```
handle_failure(job, msg, err):
    code, message = classify(err)           # 對應 §6.3 的 worker 錯誤碼；message 經 sanitizeError
    if msg.read_ct < job.max_attempts:
        update jobs set status='queued', last_error_code, last_error_message
        emit 'retry_scheduled' (attempt = read_ct, next_in = backoff)
        pgmq.set_vt(msg, backoff_seconds(read_ct))     # 1 次 → 2 秒，2 次 → 5 秒；不 archive，時間到自動可見
    else:
        update jobs set status='failed', finished_at, last_error_*
        update documents set status='failed'
        pgmq.archive(msg)                              # 留在 pgmq.a_document_jobs 供稽核
        emit 'failed'
```

`max_attempts = 3` 即「首次 + 最多自動重試 2 次」。

### 9.5 失敗注入（測試用）

pipeline 層在呼叫 Parser / Embedding 前檢查文件內容或檔名中的標記，決定是否丟出模擬錯誤，讓 retry 測試可重現（標記判斷不放在 adapter 裡，parser 本身是真的 `unpdf`）：

| 標記（出現在 `content_text` 或檔名） | 行為 |
|---|---|
| `[[FAIL_EXTRACT]]` | extracting 永遠失敗 |
| `[[FAIL_EMBED_ONCE]]` | embedding 第一次失敗、第二次成功（驗證重試成功路徑） |
| `[[FAIL_EMBED]]` | embedding 永遠失敗（驗證最終 failed 與 attempt = 3） |
| `[[SLOW]]` | 每階段延遲 3 秒（驗證 SSE 觀感） |

僅在 `FAILURE_INJECTION=true` 時生效（測試與本機預設開、正式環境關）。

---

## 10. Port / Adapter 邊界與正式環境替換

| Port | 方法 | 本次實作 | 正式環境 |
|---|---|---|---|
| `StoragePort` | `put(key, bytes, mime)`、`get(key)`、`exists(key)`、`delete(key)` | `LocalFsStorage`（`./storage/<key>`，路徑越界檢查） | Cloud Storage；上傳改用 signed URL 直傳，API 只驗證與登記 |
| `ParserPort` | `parse(bytes, mime) → { text, pageCount }` | `UnpdfParser`：PDF 走 `unpdf` 抽文字與頁數；text / markdown 直接 UTF-8 解碼 | 圖片、表格較多的教材另評估 MarkItDown sidecar 或多模態 LLM 抽取 |
| `EmbeddingPort` | `embed(texts[]) → number[][]`、`dimensions`、`modelName` | `MockEmbedding`（sha256 → 1536 維確定性向量，正規化） | 經 LiteLLM gateway 接 Vertex AI / OpenAI `text-embedding-3-small`，加限流與成本紀錄 |
| `QueuePort` | `enqueue(job)`、`read(n, vt)`、`ack(msgId)`、`nack(msgId, delay)` | `PgmqQueue` | 同 pgmq（Cloud SQL 若不支援擴充套件則用純 SQL 安裝），或 Cloud Tasks |
| `ChunkerPort` | `chunk(text) → { index, content, tokenCount }[]` | 先做固定長度 + overlap 的簡單版 | 依標題 / 段落結構切分（待實作時決定） |

本次每個 Port 只有一個實作，透過 Nest 的 provider 綁定；`bun test` 不需要任何外部金鑰或網路。

---

## 11. 測試矩陣

### 11.1 e2e（`test/e2e/*.e2e.test.ts`，對 docker 內真實 PostgreSQL）

| 情境 | 檢查點 |
|---|---|
| 成功流程（文字） | POST content_text 202 → 輪詢 GET job 直到 ready → GET document 有 chunk_count |
| 成功流程（PDF） | POST storage_key 指向 seed PDF → ready → `page_count` 正確、`text_preview` 含 PDF 內文字 |
| SSE 完整流程 | 連線後收到 snapshot、stage_changed ×2、progress ≥1、completed，然後連線關閉 |
| SSE 斷線重連 | 帶 `Last-Event-ID` 重連能補到漏掉的事件，且不重複 |
| 驗證錯誤 | 缺欄位 400、錯 MIME 415、超大小 413、`..` storage_key 400、缺 Idempotency-Key 400、size 不符 422；每一個都檢查 error 格式與 request_id |
| 租戶隔離 | ws_beta 的 key 讀 ws_alpha 的 document / job / events 全部 404，且 body 與「真的不存在」時完全相同 |
| 租戶隔離（路徑） | ws_alpha 的 key 對 `/v1/workspaces/ws_beta/documents` POST → 404 |
| RLS | 直接用 `app_user` 執行不帶 WHERE 的 SELECT，只看得到 `SET LOCAL` 的租戶 |
| 冪等 | 同 key 同 body 兩次 → 同 document_id，DB 各表只有一列；同 key 不同 body → 409；10 個併發相同請求 → 只有一列 |
| 重試成功 | `[[FAIL_EMBED_ONCE]]` → 最終 ready、attempt = 2、事件含 retry_scheduled、chunks 無重複 |
| 重試耗盡 | `[[FAIL_EMBED]]` → failed、attempt = 3、last_error 不含 stack / 路徑 / key 字樣、pgmq 歸檔表有一筆 |
| Checkpoint | `[[FAIL_EMBED_ONCE]]` 時 parser 只被呼叫一次（spy） |
| Health | `/health` 200；DB 停掉時 `/ready` 503 |
| 日誌 | 抓 pino 輸出，斷言 `content_text` 內容與 api key 未出現 |

### 11.2 Unit

`sanitizeError`、`canonical_json` / `request_hash`、storage_key 驗證、chunker、mock embedding 的確定性、unpdf parser 對範例 PDF 的輸出。

### 11.3 `scripts/curl-demo.sh`

依序：建立文件 → 用 `curl -N` 看 SSE → 查 job → 查 document → 用另一租戶 key 查同一 document 得 404 → 重送同 Idempotency-Key 得相同回應 → 丟一份 `[[FAIL_EMBED]]` 看失敗流程。每步印出狀態碼。

---

## 12. 交付物清單

- `README.md`：
  1. 一句話介紹與架構圖
  2. 快速啟動（`docker compose up`、`bun run migrate`、`bun run seed`、`bun run dev`、`bun test`）
  3. 認證與 seed key
  4. API 摘要 + Swagger 連結 + curl 範例
  5. 架構決策（CQRS 混合制、pgmq 與交易一致性、LISTEN/NOTIFY、404 而非 403、idempotency 表、checkpoint 冪等）
  6. 資安設計（隔離兩道防線、redaction、storage_key 限制）
  7. 已知限制
  8. 正式環境延伸：Cloud Storage signed URL 直傳、LiteLLM gateway 接真實 embedding、Memorystore 快取、OIDC（Identity Platform）+ RBAC 取代 API key、速率限制、observability（OpenTelemetry trace 串 request_id、pino → Cloud Logging）、水平擴展下的 SSE（多台 api 都 LISTEN 同一頻道即可）
  9. 後續延伸的端點：文件／工作列表、chunks 查詢、cancel、retry、reprocess、multipart 上傳、向量搜尋
- `docker-compose.yml`：`db`（`pgvector/pgvector:pg18-trixie`，pgmq 由 migration 安裝）、`api`（`target: api`）、`worker`（`target: worker`）；`api` 與 `worker` 加 healthcheck；`depends_on` 只保證啟動順序，實際等待由應用程式自行重試（Podman 相容，見 §1.5）
- `Dockerfile`：多階段，`oven/bun` 基底
- `.env.example`：見 §13
- `.oxlintrc.json`、`.oxfmtrc.jsonc`
- `migrations/*.sql` + `scripts/migrate.ts`（含 `CREATE EXTENSION vector; CREATE EXTENSION pgmq; SELECT pgmq.create('document_jobs'); RLS policies`）
- `scripts/curl-demo.sh`、Postman collection（可選）
- 線上 demo（Render / Fly.io，可選）

---

## 13. 環境變數（`.env.example`）

```
PORT=3000                         # 僅 api 使用
DATABASE_URL=postgres://app_user:app_pass@localhost:5432/doc_ingest          # 容器內連宿主機改 host.containers.internal
DATABASE_URL_WORKER=postgres://worker_user:worker_pass@localhost:5432/doc_ingest
DATABASE_URL_ADMIN=postgres://localhost:5432/doc_ingest                      # 只給 migrate / seed；本機用 Homebrew 預設帳號
APP_DB_PASSWORD=app_pass                                                     # migrate.ts 建 app_user 用
WORKER_DB_PASSWORD=worker_pass                                               # migrate.ts 建 worker_user 用
DB_CONNECT_RETRY_SEC=30            # 啟動時等待資料庫的上限
LOG_LEVEL=info

MAX_DOCUMENT_BYTES=10485760
ALLOWED_MIME_TYPES=application/pdf,text/plain,text/markdown
IDEMPOTENCY_TTL_HOURS=24

STORAGE_ROOT=./storage
EMBEDDING_DIMENSIONS=1536
STAGE_DELAY_MS=800                # 每階段人為延遲，讓 SSE 看得到進度；正式環境設 0
FAILURE_INJECTION=true            # 啟用 [[FAIL_*]] 標記；正式環境設 false

WORKER_CONCURRENCY=2
WORKER_POLL_INTERVAL_MS=500
WORKER_VISIBILITY_TIMEOUT_SEC=60
WORKER_MAX_ATTEMPTS=3

SSE_PING_INTERVAL_MS=15000

# 本機 seed 用，正式環境不存在
SEED_API_KEY_ALPHA=dk_alpha_local_only
SEED_API_KEY_BETA=dk_beta_local_only
```

---

## 14. 實作順序

1. **骨架**：Nest on Bun 最小可跑、Swagger、oxlint / oxfmt 設定、Homebrew PG 裝好 pgvector + pgmq、compose 的 `db` 也能起（兩個 target 都能 build）、Bun SQL 連線、`migrate.ts` 跑完 pgvector / pgmq / 建表。
2. **命令路徑**：request id、guard、錯誤格式、Zod 驗證、POST documents（含 idempotency + pgmq.send 同交易）。
3. **Worker**：主迴圈、三階段（unpdf 抽取、mock embedding）、checkpoint、失敗與重試、事件與 NOTIFY、失敗注入、RLS 遷移。
4. **查詢與 SSE**：GET job、GET document、SSE（含 Last-Event-ID）、health / ready。
5. **測試與腳本**：§11 情境 + curl-demo。
6. **README**。
7. 之後：補 unit test、線上 demo。

---

## 15. 待決事項（實作時再定）

- Chunk 切割策略與 overlap 大小。
- Zod vs class-validator 最終選擇（傾向 Zod + `nestjs-zod`，理由：同一份 schema 同時給驗證、型別、Swagger）。
