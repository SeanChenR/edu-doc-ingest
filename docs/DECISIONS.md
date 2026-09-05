# 設計與技術決策紀錄

> 這份文件記錄 doc-ingest 從規劃到完成的每一個決定：**決定了什麼、還考慮過什麼、為什麼這樣選**。
> 條目隨開發過程持續增加，最後會濃縮成 README 的「設計思路」章節。
> 已定案的條目不改內容；決定變了就加新條目並標「取代 D-xx」，舊條目補一行「後續」指過去。
> 標「回填」的條目是在規劃階段（`docs/DESIGN.md`）就定案、於 2026-09-05 補上紀錄的。

## 已定案

### D-01 執行環境用 Bun，框架用 NestJS

- **決定**：Bun 當 runtime 與套件管理器，NestJS 當應用框架，Express adapter。
- **也考慮過**：純 `Bun.serve` 不用框架；Hono；Elysia。
- **為什麼**：Bun 是團隊既定的執行環境，而且內建 PostgreSQL 客戶端、測試工具、LISTEN/NOTIFY，能少裝很多東西。框架選 NestJS 是因為它的模組、依賴注入、Guard、Interceptor 跟 Spring Boot 與 Angular 是同一套心智模型，我上手最快；也跟團隊技術棧一致，之後不用再搬一次。純 Bun 對六條路由其實夠用，但 Guard／Filter／Swagger 這些要自己搭，省下的依賴會從程式碼補回來。

### D-02 不用 ORM，SQL 手寫，集中在 Repository

- **決定**：資料庫存取用 Bun 內建的 `SQL` 客戶端寫原生 SQL；每張表一個 Repository 檔，SQL 只出現在那裡；每張表手寫一個 Row 介面；遷移是編號的 `.sql` 檔加一支自寫的執行腳本。
- **也考慮過**：Drizzle（型別與 schema 同源）；TypeORM（NestJS 官方範例常用）。
- **為什麼**：這個服務有三塊本來就繞不開原生 SQL：pgmq 的函式呼叫、RLS 用的 `set_config`、LISTEN/NOTIFY。用了 ORM 還是要學兩套。六張表、二十來條查詢的規模，手寫 SQL 反而讓交易邊界、索引、RLS 這些設計一眼可見，而不是被抽象層藏起來。代價是改表要記得同步改 Row 介面，這個規模可以接受；之後真要補，Drizzle 是最容易疊上去的。

### D-03 佇列用 PostgreSQL 的 pgmq，不引入 Redis

- **決定**：背景工作的佇列用 pgmq 擴充套件，訊息只放 `job_id` 與 `workspace_id`；狀態、進度、錯誤原因另存自己的 `jobs` 表。
- **也考慮過**：Redis + BullMQ（正式環境常見組合）；自己用 `SELECT ... FOR UPDATE SKIP LOCKED` 在 `jobs` 表上實作佇列；程式記憶體裡的陣列。
- **為什麼**：pgmq 是純 SQL 函式，不多一個服務、不多一個容器，而且因為它就是 SQL，「建立 document、建立 job、送進佇列」可以放在同一個交易裡，要成功一起成功——Redis 佇列做不到這點。相較自己寫 `SKIP LOCKED`，pgmq 免費送可見性逾時（worker 領了工作中途當掉，訊息時間到自動回佇列）跟 `read_ct` 領取次數，正好對應重試上限。記憶體陣列一重啟就丟，不考慮。正式環境若 Cloud SQL 不支援這個擴充套件，pgmq 有純 SQL 安裝方式，或改 Cloud Tasks，介面不變。

### D-04 worker 到 api 的進度通知用 LISTEN/NOTIFY，通知只當叫醒鈴

- **決定**：worker 每次更新 job 狀態，在同一交易內 `INSERT job_events` 並 `NOTIFY`；api 用 `sql.listen` 收到後回資料庫讀那筆事件再推給瀏覽器。通知內容只帶 `job_id` 與 `event_id`，不帶狀態本身。
- **也考慮過**：api 定時輪詢 `job_events`；Redis pub/sub。
- **為什麼**：api 跟 worker 是兩個程式，中間必須有個共同的地方交換訊號；PostgreSQL 內建的 LISTEN/NOTIFY 讓延遲是毫秒級又不用多一個服務。通知只當叫醒鈴、內容以資料庫為準，是因為 NOTIFY 不保證送達也不保證順序，把狀態塞進通知會有掉訊息或亂序的風險。這個設計橫向擴展也不用改：多台 api、多台 worker 都聽同一個頻道。

### D-05 SSE 手寫串流，不用 `@Sse()` 裝飾器；事件表支援斷線補發

- **決定**：`GET /v1/jobs/:id/events` 直接操作原始回應物件寫 `text/event-stream`；`job_events.id` 是自動遞增流水號，當 SSE 的 `id:`；連線時若帶 `Last-Event-ID` 先補發漏掉的事件再接即時；每 15 秒送一行註解保活；job 進入終止狀態送終止事件後主動關閉。
- **也考慮過**：NestJS 的 `@Sse()` 回傳 RxJS Observable。
- **為什麼**：`@Sse()` 拿不到請求標頭、沒有「先送歷史再送即時」的順序控制，終止關閉跟保活兩個訊號源要合併成一條 Observable，RxJS 不熟寫起來很痛苦。手寫是三十行線性邏輯：補發、編號、終止、保活各一段。送到瀏覽器的東西兩種寫法完全一樣。

### D-06 api 與 worker 是兩個獨立映像檔，同一個 repo，用同一個 Dockerfile 的兩個 target 產出

- **決定**：`src/api/` 與 `src/worker/` 各有自己的進入點與根模組，共用的東西放 `src/shared/`；`Dockerfile` 多階段，`--target api` 與 `--target worker` 各建一個映像；compose 起三個容器：`api`、`worker`、`db`。
- **也考慮過**：一個映像檔靠 `ROLE` 環境變數決定跑哪個角色；拆成兩個 repo。
- **為什麼**：資料表定義、Port 介面、錯誤碼、設定載入這些兩邊都要用，拆兩個 repo 要嘛複製要嘛抽第三個套件，都是負擔。但兩個角色的相依套件、資源配置、擴縮方式都不同，正式環境在 Cloud Run 也是兩個服務——所以映像要分開。同一個 Dockerfile 兩個 target 剛好兩邊都顧到，之後 worker 要疊系統套件也不影響 api。

### D-07 本次不做快取

- **決定**：不引入 Redis 快取，也不在程式記憶體裡做讀取快取（Guard 對 API key 的 60 秒快取除外，那是 Guard 內部細節）。
- **也考慮過**：業務層 → 資料庫存取層 → Redis 快取 → 資料庫的 read-through 架構。
- **為什麼**：讀取量小，快取沒有實質效益，反而多了「快取失效」這個 bug 來源。順帶釐清：Bun 內建的是 Redis 的連線客戶端，不是快取本身，「Bun 原生就有快取」是誤解。正式環境對熱門 document metadata 加 Memorystore 讀取快取、job 進入終止狀態時清除，寫在 README 的延伸章節。

### D-08 身分模型：一把 API key 等於一個 workspace 的完整權限，不做 RBAC

- **決定**：請求帶 `Authorization: Bearer <key>`，Guard 查雜湊得到 workspace；金鑰只存 SHA-256、可撤銷；seed 兩個 workspace 各一把 key。不做角色與權限表。
- **也考慮過**：RBAC（角色表、`@Roles()` 裝飾器）；直接接 OIDC。
- **為什麼**：目前的需求只有租戶隔離，沒有任何一個行為會因為角色不同而不同——多一張表、多一組 Guard、多一批測試，換不到任何實際保護。正式環境的演進路徑很清楚：政府 SSO 登入後由 Identity Platform 簽 JWT，claims 帶 workspace 清單與角色，Guard 改驗簽，API key 留給服務間呼叫。

### D-09 跨租戶與不存在一律回 404，不回 403

- **決定**：資源不存在、或存在但屬於別的 workspace，回應的狀態碼與 body 逐位元相同：`404 NOT_FOUND`。
- **也考慮過**：跨租戶回 403 Forbidden（語意上更「正確」）。
- **為什麼**：403 等於告訴對方「這個編號存在，只是你不能看」，這本身就洩漏了其他租戶的資料存在。攻擊者拿 403 跟 404 的差異就能列舉出別人的資源。

### D-10 租戶隔離做兩道：應用層強制帶 workspace 條件，資料庫層開 RLS

- **決定**：第一道，Repository 每個方法第一個參數都是 `workspaceId`，SQL 一律帶 `workspace_id = $1`，沒有不帶租戶的 `findById`。第二道，所有租戶表 `ENABLE` 且 `FORCE ROW LEVEL SECURITY`，policy 讀 `current_setting('app.workspace_id')`；api 端所有查詢包在 `withTenant()` 交易裡先 `set_config`。worker 用另一個帶 `BYPASSRLS` 的角色領佇列，但處理每件工作時仍用訊息裡的 `workspace_id` 包一層 `withTenant`。每張租戶表都冗餘一欄 `workspace_id`，包括能從父表推出來的 `document_chunks` 與 `job_events`。
- **也考慮過**：只做應用層，README 說明 RLS 的演進路徑。
- **為什麼**：應用層那道靠人記得寫 `WHERE`，哪天漏一條就破了；RLS 是資料庫自動補條件，程式碼有 bug 也擋得住。實作成本其實不高：一個交易包裝函式加每張表一條 policy。冗餘 `workspace_id` 是為了讓 policy 不用 join。測試裡放一條故意漏寫 `WHERE` 的查詢，證明第二道真的擋得住。

### D-11 冪等用獨立的 `idempotency_keys` 表，靠主鍵衝突當鎖

- **決定**：主鍵 `(workspace_id, key)`；建立文件時先 `INSERT ... ON CONFLICT DO NOTHING RETURNING`，搶到才真的建資源，最後把回應存回這一列；搶不到就比對 `request_hash`——相同回原本那份 202（加 `Idempotent-Replayed: true` 標頭），不同回 `409 IDEMPOTENCY_KEY_REUSED`。`Idempotency-Key` 為必填。
- **也考慮過**：把 `idempotency_key` 欄位直接放在 `jobs` 表上加唯一鍵；`Idempotency-Key` 設為選填。
- **為什麼**：獨立一張表是為了之後任何 POST（reprocess、retry）都能共用同一套機制，不用每張表各加一欄。用資料庫的主鍵衝突當鎖，十個一模一樣的請求同時打進來只有一個會贏，其他九個等第一筆 commit 後讀到完整回應，不用自己處理併發。設為必填是因為「沒帶就不保證」這條規則對呼叫端很難解釋，而且會讓測試矩陣多一個分支。

### D-12 建立任務是一個交易：document、job、冪等記錄、`pgmq.send` 要成功一起成功

- **決定**：`POST /documents` 的所有寫入放在同一個交易內，交易 commit 後才回 202。
- **也考慮過**：先寫資料庫再丟佇列（兩步）。
- **為什麼**：兩步的話會有「job 建了但沒排進佇列」的孤兒，或「排進佇列了但 job 不存在」的幽靈，兩種都要另外寫補償。pgmq 是 SQL 所以能跟業務寫入同交易，這是選它的主要理由之一（見 D-03）。

### D-13 重試：首次加最多兩次，靠 pgmq 的 `read_ct` 計數，階段做 checkpoint 保證可重跑

- **決定**：`max_attempts = 3`；worker 領到訊息時 `attempt = read_ct`；失敗且未達上限就把 job 狀態改回 `queued`、寫錯誤原因、用 `pgmq.set_vt` 設退避時間，訊息不歸檔、時間到自動可見；達上限才歸檔訊息並標 `failed`。階段冪等：抽取完成的文字存進 `documents.extracted_text`，重跑時已有就跳過；chunk 用 `(document_id, chunk_index)` 唯一鍵 upsert。錯誤訊息存入前經過 `sanitizeError()` 去掉金鑰樣式字串、絕對路徑、堆疊。
- **也考慮過**：自己在 `jobs` 表維護 `attempt` 欄位並由 worker 手動重新排隊。
- **為什麼**：`read_ct` 是 pgmq 自己記的，worker 當掉沒回報也會算進去，比自己維護更不會漏。checkpoint 是「重試不可造成重複的不可逆副作用」這條要求的具體落點：對外部 embedding 服務的付費呼叫不重複、chunk 不重複。錯誤原因要能讓人看懂又不能帶機密，所以過濾在寫入那一刻做，不是在讀出時做。

### D-14 失敗注入用文件內容裡的標記，判斷放在 pipeline 層

- **決定**：`[[FAIL_EXTRACT]]`、`[[FAIL_EMBED_ONCE]]`、`[[FAIL_EMBED]]`、`[[SLOW]]` 四個標記；由 pipeline 在呼叫 Parser／Embedding 前檢查，決定丟錯或延遲；只在 `FAILURE_INJECTION=true` 時生效。
- **也考慮過**：把標記判斷寫在 mock adapter 裡；用環境變數全域開關「下一次一定失敗」。
- **為什麼**：重試與最終失敗的測試需要可重現的失敗，而且要能「失敗一次然後成功」來證明重試路徑真的走通。標記在內容裡讓每個測試案例自己控制自己的失敗，不會互相干擾；判斷放 pipeline 層是因為 parser 是真的 `unpdf`（見 D-15），不該為測試改它。

### D-15 解析器用 TypeScript 原生的 `unpdf`；embedding 只有 mock

- **決定**：PDF 用 `unpdf` 抽文字與頁數，純文字與 Markdown 直接解碼；embedding 用 SHA-256 產生 1536 維確定性假向量並正規化，不接任何真實模型。
- **也考慮過**：MarkItDown（Python）當解析器，用 sidecar 容器 HTTP 呼叫；embedding 做成可切換 OpenAI `text-embedding-3-small`。
- **為什麼**：MarkItDown 是 Python 套件，Bun 專案接它就是多一個語言、多一個容器，本次不值得。`unpdf` 純 JS、Bun 能跑、抽字是真的，讓 PDF 流程有實際內容可驗證。embedding 保持 mock 是讓 `bun test` 不需要任何金鑰或網路、不花錢，任何人拉下來都能跑；介面邊界留著，正式環境經 LiteLLM gateway 接 Vertex AI 或 OpenAI 只換一個 adapter。

### D-16 範圍：四支業務端點加兩支健康檢查，其餘延後

- **決定**：`POST /v1/workspaces/:id/documents`、`GET /v1/jobs/:id`、`GET /v1/jobs/:id/events`、`GET /v1/documents/:id`、`/health`、`/ready`。
- **也考慮過**：第一版規劃多了十二支（文件與工作列表、chunks 查詢、cancel、retry、reprocess、multipart 上傳、向量搜尋、事件歷史）。
- **為什麼**：多一支端點就多一組 DTO、Swagger、錯誤碼、租戶隔離測試、冪等測試。與其十六支做到六成，不如六支做到能上線：交易一致性、RLS、SSE 補發、重試冪等這些才是這個服務的重點。延後的清單留在 README。

### D-17 驗證用 Zod，透過 `nestjs-zod` 同時產 Swagger

- **決定**：請求與回應 schema 都用 Zod 定義，`createZodDto` 接進 NestJS 的 ValidationPipe 與 Swagger；輸入限制（MIME 白名單、大小上限、`storage_key` 格式、`content_text` 與 `storage_key` 二擇一）寫在 schema 本身。
- **也考慮過**：`class-validator` + `class-transformer`（NestJS 官方文件的預設）。
- **為什麼**：一份 schema 同時給驗證、TypeScript 型別、OpenAPI 文件，三者不會漂移。`class-validator` 要靠裝飾器堆在 class 上，型別跟驗證是兩份東西，XOR 這種跨欄位規則寫起來也繞。

### D-18 Lint 與 Format 用 oxlint 與 oxfmt，開型別感知檢查

- **決定**：不裝 ESLint 與 Prettier；oxlint 啟用 `typescript`、`unicorn`、`oxc` 外掛並開 `--type-aware`；oxfmt 用 Prettier 相容設定，`printWidth: 100`。
- **也考慮過**：ESLint + Prettier（最普及）；Biome。
- **為什麼**：oxc 系列速度快、設定少，NestJS 的裝飾器它認得。開型別感知主要是為了 `no-floating-promises`——這個專案 async 到處都是，worker 裡漏一個 `await` 會變成靜默失敗，很難找。

### D-19 容器用 Podman，資料庫連線由應用程式自行重試

- **決定**：compose 檔維持標準格式，`podman compose` 執行；api 與 worker 啟動時自己指數退避等資料庫最多 30 秒，不依賴 `depends_on.condition: service_healthy`。
- **也考慮過**：只支援 Docker；靠 compose 的 healthcheck 條件保證啟動順序。
- **為什麼**：`service_healthy` 在較舊的 podman-compose 上不支援，而且容器編排本來就不該假設順序——正式環境 Cloud Run 也沒有這種保證。應用程式自己等，兩邊都對。

### D-20 本機開發資料庫用 Homebrew 的 PostgreSQL 18，pgmq 自行編譯；compose 的 `db` 容器保留

- **決定**：本機 `brew install postgresql@18 pgvector`，pgmq 從原始碼 `make install`（純 SQL 擴充套件，不需要 Rust）；api 與 worker 在宿主機直接 `bun --bun` 跑；compose 全套只在驗收與 CI 用。
- **也考慮過**：本機也全走容器。
- **為什麼**：宿主機跑熱重載快、除錯方便。但 compose 的 `db` 一定要留，別人拉下來要能一鍵起。pgmq 若 `make install` 失敗，`psql -f sql/pgmq.sql` 直接灌函式是退路，這條退路同時是正式環境 Cloud SQL 若不支援擴充套件時的方案。
- **後續**：pgmq 安裝方式與 db 映像由 D-23 取代（退路變主路）；Homebrew PG 與宿主機跑 api / worker 的部分不變。

### D-21 檔案存本機資料夾，`storage_key` 格式白名單，原始內容不進資料庫也不進日誌

- **決定**：`StoragePort` 本次實作為 `./storage/` 下的檔案；`storage_key` 只接受 `^[a-z0-9_]+(/[A-Za-z0-9._-]+)+$` 且第一段必須等於目前 `workspace_id`，解析成實體路徑後再確認仍在 `STORAGE_ROOT` 之下；資料庫只放 metadata 與抽取後的文字；pino redaction 遮掉 `content_text`、`extracted_text`、`Authorization` 與任何鍵名含 `key`／`token`／`secret` 的欄位。
- **也考慮過**：把原始檔內容當 bytea 存進資料庫；`storage_key` 接受任意字串交給 adapter 處理。
- **為什麼**：白名單加 workspace 前綴同時擋掉路徑穿越與跨租戶讀檔，是「不得接受任意本機路徑」的具體實作。內容不進資料庫是為了正式環境換 Cloud Storage 時資料層不用動。日誌遮罩在 logger 設定層做，不靠每個呼叫點記得。

### D-22 ID 用帶前綴的 ULID；`job_events.id` 是唯一的自動遞增

- **決定**：`ws_`、`doc_`、`job_`、`key_` 前綴 + ULID，應用程式產生；`job_events.id` 用 `bigserial`。
- **也考慮過**：全部 UUID；全部自動遞增整數。
- **為什麼**：前綴讓日誌與 URL 裡一眼看出是哪種資源，ULID 可排序又能在交易開始前就產生（不用等 INSERT 回傳）。`job_events` 例外是因為 SSE 的 `Last-Event-ID` 需要一個嚴格遞增的數字來表達「我收到第幾號了」，ULID 做不到這件事。

### D-23 pgmq 一律以 SQL 檔安裝，不裝擴充套件；db 映像用 `pgvector/pgvector:pg18-trixie`（取代 D-20 的 pgmq 段落）

- **決定**：pgmq 官方的 `pgmq.sql` 原樣放進 repo（`migrations/pgmq/pgmq.sql`，檔頭註明來源版本），`001_extensions.sql` 執行 `CREATE EXTENSION vector` 後由 `scripts/migrate.ts` 灌這份檔，再 `pgmq.create('document_jobs')`。compose 的 `db` 用 `pgvector/pgvector:pg18-trixie`。migrate / seed 用 `DATABASE_URL_ADMIN` 連線；`app_user` / `worker_user` 的密碼由 migrate.ts 從 env 讀入，不寫進 SQL 檔。
- **也考慮過**：本機 `make install` 成擴充套件、容器用 `ghcr.io/pgmq/pg18-pgmq`（D-20 與 DESIGN §1 原案）；自建 Dockerfile 在 pgvector 映像上疊 pgmq。
- **為什麼**：2026-09-05 實測 Homebrew PostgreSQL 18 沒有 pgmq，`pgvector/pgvector` 官方映像也沒有，原案要在兩個環境各做一次不同的安裝，還得自建映像。pgmq 本來就是純 SQL 函式，灌 SQL 檔跟 `CREATE EXTENSION` 得到的東西一模一樣，只差 `pg_extension` 那筆登記；一條路走本機、容器、CI 三邊，正式環境 Cloud SQL 不支援擴充套件時也不用改。代價是升級 pgmq 要手動換檔，這個規模可以接受。密碼不進 SQL 檔是因為 migration 會進版控。

### D-24 回應格式：成功回應攤平、失敗回應包 `error`，不用統一信封

- **決定**：維持 DESIGN §6.1 / §6.2。成功時資源欄位直接放在最上層、末尾附 `request_id`；失敗時整個 body 只有 `{ "error": { code, message, request_id, details? } }`。兩者共同的不變式：`request_id` 永遠存在；`error` 這個 key 只在失敗時出現；成敗以 HTTP 狀態碼判斷。`ResponseInterceptor` 負責前者、`AppExceptionFilter` 負責後者，兩者都在第 2 步（§14）實作，任何端點都不得繞過。
- **也考慮過**：統一信封 `{ "success": bool, "data": …, "error": …, "request_id": … }`，成功與失敗形狀完全相同。
- **為什麼**：`success` 與 HTTP 狀態碼是同一件事講兩次，呼叫端本來就得看狀態碼；統一信封讓每個 GET 多一層 `data`，Swagger 的 schema 也得多包一層才對得上。攤平的成功回應就是資源本身，文件與型別一對一。失敗包在 `error` 底下是為了讓呼叫端用一個固定路徑取 `code` 決定要重試、修輸入還是放棄。這是 Stripe、GitHub 等公開 API 的慣例，對接的人不用學新規則。

### D-25 `content_text` 由 API 先寫進 StoragePort，之後與 `storage_key` 走完全相同的路徑

- **決定**：POST 帶 `content_text` 時，API 在交易開始前先用 ULID 產生 `document_id`（D-22），決定 `storage_key = ${workspace_id}/inline/${document_id}.txt`（`text/markdown` 用 `.md`），呼叫 `StoragePort.put()` 寫入，再開交易寫 `documents`／`jobs`／`idempotency_keys`／`pgmq.send`。client 不能對 `content_text` 指定 `storage_key`。worker 的 extracting 階段一律從 StoragePort 讀、依 `mime_type` 解析，不知道也不需要知道文件是貼進來的還是上傳的。`extracted_text` 永遠是 worker 的產物，API 不寫它。`storage_key` 維持 NOT NULL。
  順序與失敗處理：
  1. 交易外先查 `idempotency_keys`：已有且 `request_hash` 相同 → 直接回存好的回應，不碰 StoragePort；不同 → 409。
  2. `StoragePort.put()`。
  3. 單一交易：`INSERT INTO idempotency_keys ... ON CONFLICT DO NOTHING` 搶 key（§8 的原子性與併發等待不變）→ 寫 documents／jobs → `pgmq.send` → 更新冪等列的回應。
  4. 交易失敗（含極少數併發下步驟 3 搶不到 key）：best-effort `StoragePort.delete()`；刪不掉記一行 warn 帶 `storage_key`。留下的孤兒檔不被任何 document 指到、不影響正確性，README「已知限制」寫一句，正式環境用 Cloud Storage lifecycle rule 清。
- **也考慮過**：API 直接把 `content_text` 寫進 `documents.extracted_text`、`storage_key` 改為可 null，worker 看 checkpoint 已有就跳過抽取。
- **為什麼**：只有一條處理路徑。另一案讓 extracting 有兩種語意——「已抽取」跟「不需要抽取」共用同一個欄位——checkpoint 判斷變模糊，`[[FAIL_EXTRACT]]` 對純文字也會失效。它也違反 §4 與 D-21「原始內容不進資料庫，資料庫只放 metadata 與抽取後的文字」。維持 NOT NULL 就不用改表。正式環境貼上的文字同樣落 Cloud Storage 一份當原始來源，之後 reprocess 才有東西可重跑。

## 待決

- Chunk 切割策略與 overlap 大小（實作 worker 時定）。
