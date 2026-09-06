#!/usr/bin/env bash
# docs/DESIGN.md §11.3：一鍵重現主流程，每步印出 HTTP 狀態碼與 body。
#
# 這支腳本是「用 curl 把 README §5 的四個端點與 §9 的資安規則全部走一遍」，
# 每一步上面的註解說明【做什麼】與【為什麼要驗這個】。順序刻意安排成一份文件的生命週期：
#   0 health → 1 建立 → 2 看 SSE → 3 查 job → 4 查 document → 5 跨租戶 404 → 6 SSE 補發
#   → 7 冪等重播 → 8 冪等衝突 409 → 9 失敗與重試 → 10 各種驗證錯誤 → 11 沒帶 key 401
#
# 前置：api 與 worker 都在跑（本機 `bun run dev`，或 podman compose）。
# 用法：API_URL=http://localhost:3000 API_KEY_ALPHA=... API_KEY_BETA=... scripts/curl-demo.sh
#（預設讀 .env 的 SEED_API_KEY_ALPHA / SEED_API_KEY_BETA；指令列給的變數優先）
set -euo pipefail

PRESET_API="${API_URL:-}"
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi
API_URL="${PRESET_API:-${API_URL:-http://localhost:3000}}"
KEY_A="${API_KEY_ALPHA:-${SEED_API_KEY_ALPHA:?set API_KEY_ALPHA}}"
KEY_B="${API_KEY_BETA:-${SEED_API_KEY_BETA:?set API_KEY_BETA}}"
# 每次執行用新的 Idempotency-Key，重跑腳本才不會被上一輪的冪等列擋住（第 7、8 步會刻意重用它）
IDEM="demo-$(date +%s)"
SSE_MAX_SEC="${SSE_MAX_SEC:-30}"

step() { printf '\n== %s\n' "$1"; }
# 印狀態碼 + body；body 存到 $BODY 供下一步取值
call() {
  local code
  code="$(curl -sS -o /tmp/curl-demo-body -w '%{http_code}' "$@")"
  BODY="$(cat /tmp/curl-demo-body)"
  printf 'HTTP %s  %s\n' "$code" "$BODY"
}
json() { bun -e "const d=JSON.parse(process.argv[1]); console.log(d.$2 ?? '')" "$1"; }
# 輪詢 GET job 直到 ready / failed（SSE 用 --max-time 截斷後，確保後面查到的是終止狀態）
wait_job() {
  local id="$1" status
  for _ in $(seq 1 90); do
    status="$(curl -sS -H "Authorization: Bearer $KEY_A" "$API_URL/v1/jobs/$id" | bun -e "console.log(JSON.parse(await Bun.stdin.text()).status ?? '')")"
    [[ "$status" == "ready" || "$status" == "failed" ]] && return 0
    sleep 1
  done
  echo "timeout waiting for $id" >&2; return 1
}

# ---------------------------------------------------------------------------
# 0. /health 與 /ready
# 做什麼：兩個不需要 API key 的健康檢查。
# 為什麼：/health 只代表 process 活著；/ready 會真的查 DB 與 pgmq 佇列存不存在。
#         先確認 /ready 是 200，後面任何失敗才不會是「DB 沒起來」這種環境問題。
step "0. health / ready"
call "$API_URL/health"
call "$API_URL/ready"

# ---------------------------------------------------------------------------
# 1. POST 建立文件 → 202
# 做什麼：用 ws_alpha 的 key、帶 Idempotency-Key，貼一段 content_text 建立文件。
# 為什麼：這是唯一的命令端點。回 202（不是 200/201）代表「收下了、還沒處理完」；
#         body 的 document_id / job_id / status: queued / request_id 就是規格要求的四個欄位。
#         檔名放 [[SLOW]] 是失敗注入標記之一，讓每個階段慢一點，第 2 步的 SSE 才看得到過程。
step "1. POST document (content_text, [[SLOW]] so the stream is visible) → 202"
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM" -H 'Content-Type: application/json' \
  -d '{"name":"[[SLOW]] unit-3.txt","mime_type":"text/plain","size_bytes":11,"content_text":"hello world","metadata":{"grade":5}}'
DOC_ID="$(json "$BODY" document_id)"
JOB_ID="$(json "$BODY" job_id)"
echo "document_id=$DOC_ID job_id=$JOB_ID"

# ---------------------------------------------------------------------------
# 2. SSE 即時進度
# 做什麼：curl -N 掛在 /v1/jobs/:id/events 上，把整條串流印出來並存檔（第 6 步要用裡面的 id）。
# 為什麼：驗證事件順序：snapshot（沒有 id，連線當下的現況）→ stage_changed / progress（帶 id）
#         → completed，然後伺服器主動關閉連線，curl 自己結束，不需要 Ctrl-C。
#         --max-time 只是保險，正常情況下 completed 之前就會關。
step "2. SSE with curl -N: snapshot → stage_changed / progress → completed, then the server closes"
curl -sN --max-time "$SSE_MAX_SEC" -H "Authorization: Bearer $KEY_A" "$API_URL/v1/jobs/$JOB_ID/events" | tee /tmp/curl-demo-sse || true
wait_job "$JOB_ID"

# ---------------------------------------------------------------------------
# 3. GET job
# 做什麼：查同一個 job 的最終狀態。
# 為什麼：這是「不用 SSE 也能查進度」的路徑。要看的欄位：status: ready、progress: 100、
#         attempt: 1、retries_used: 0、last_error: null、started_at / finished_at 都有值。
step "3. GET job → ready, progress 100, retries_used 0"
call -H "Authorization: Bearer $KEY_A" "$API_URL/v1/jobs/$JOB_ID"

# ---------------------------------------------------------------------------
# 4. GET document
# 做什麼：查文件本身。
# 為什麼：文件與 job 是兩個資源：document 有 metadata（第 1 步給的 grade: 5 原樣回來）、
#         chunk_count、latest_job 摘要，以及只有 ready 才會出現的 result（text_preview、
#         embedding_model、embedding_dimensions）。這就是規格說的「metadata 與 mock 處理結果」。
step "4. GET document → status ready, chunk_count, result.text_preview"
call -H "Authorization: Bearer $KEY_A" "$API_URL/v1/documents/$DOC_ID"

# ---------------------------------------------------------------------------
# 5. 跨租戶讀取 → 404
# 做什麼：換 ws_beta 的 key 讀剛才 ws_alpha 的 document / job / events，再用 alpha 的 key 讀一個不存在的 id。
# 為什麼：四個回應要一模一樣（都是 404 NOT_FOUND，body 只差 request_id）。刻意不回 403，
#         因為 403 等於告訴對方「這個 id 存在，只是不是你的」（D-09）。
#         events 也要驗，因為 SSE 端點是 raw Response，容易漏掉 guard。
step "5. ws_beta key reading ws_alpha's document / job / events → 404, identical to a missing id"
call -H "Authorization: Bearer $KEY_B" "$API_URL/v1/documents/$DOC_ID"
call -H "Authorization: Bearer $KEY_B" "$API_URL/v1/jobs/$JOB_ID"
call -H "Authorization: Bearer $KEY_B" "$API_URL/v1/jobs/$JOB_ID/events"
call -H "Authorization: Bearer $KEY_A" "$API_URL/v1/documents/doc_does_not_exist"

# ---------------------------------------------------------------------------
# 6. 帶 Last-Event-ID 重連
# 做什麼：從第 2 步存下的串流抓第 2 個事件的 id，當作「客戶端上次收到的」再連一次。
# 為什麼：驗證斷線補發：先 snapshot，然後只補第 3 個之後的事件（不重複、不漏），
#         job 已經終止所以補完就關。這是 SSE 能在 LB / 網路抖動下可靠的關鍵（D-05）。
step "6. Reconnect with Last-Event-ID (2nd event): snapshot + only the missed events, then close"
SECOND_ID="$(grep -E '^id: ' /tmp/curl-demo-sse | sed -n '2p' | cut -d' ' -f2 || true)"
curl -sN --max-time 5 -H "Authorization: Bearer $KEY_A" -H "Last-Event-ID: ${SECOND_ID:-0}" "$API_URL/v1/jobs/$JOB_ID/events" | grep -E '^(id|event):' || true

# ---------------------------------------------------------------------------
# 7. 同 Idempotency-Key + 同 body 重送 → 202 重播
# 做什麼：把第 1 步的請求原封不動再送一次（同 key、同 body）。
# 為什麼：客戶端 timeout 後重送是常態。要得到「同樣的 202、同樣的 document_id / job_id」，
#         並多一個標頭 Idempotent-Replayed: true；DB 不會多出第二份文件或第二個 job（§8）。
step "7. Same Idempotency-Key + same body → same ids, Idempotent-Replayed: true"
curl -sS -D - -o /tmp/curl-demo-body -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM" -H 'Content-Type: application/json' \
  -d '{"name":"[[SLOW]] unit-3.txt","mime_type":"text/plain","size_bytes":11,"content_text":"hello world","metadata":{"grade":5}}' \
  | grep -iE '^HTTP|^idempotent-replayed'
cat /tmp/curl-demo-body; echo

# ---------------------------------------------------------------------------
# 8. 同 Idempotency-Key + 不同 body → 409
# 做什麼：同一把 key 但內容換掉。
# 為什麼：這不是重送，是 bug 或惡意重用。回 409 IDEMPOTENCY_KEY_REUSED，而不是默默回舊資源，
#         客戶端才知道自己的 key 管理有問題。body 比對用正規化 JSON 的 hash，欄位順序不影響。
step "8. Same Idempotency-Key + different body → 409 IDEMPOTENCY_KEY_REUSED"
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM" -H 'Content-Type: application/json' \
  -d '{"name":"other.txt","mime_type":"text/plain","size_bytes":11,"content_text":"hello world"}'

# ---------------------------------------------------------------------------
# 9. 失敗與重試
# 做什麼：建一份 content_text 含 [[FAIL_EMBED]] 的文件（embedding 階段每次都失敗），看 SSE 的事件名，
#         再查最終的 job。
# 為什麼：規格要求「最多自動重試 2 次、最終失敗要留下可理解且不含秘密的錯誤原因」。
#         SSE 會看到 retry_scheduled × 2 然後 failed；GET job 會是 status: failed、attempt: 3、
#         retries_used: 2、last_error: { code: EMBEDDING_PROVIDER_ERROR, message: 不含堆疊 / 路徑 }。
#         抽取階段只跑一次（checkpoint 在 documents.extracted_text），重試不重抽（D-13）。
step "9. [[FAIL_EMBED]] document: retry_scheduled twice, then failed (attempt 3, last_error set)"
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM-fail" -H 'Content-Type: application/json' \
  -d '{"name":"fail.txt","mime_type":"text/plain","size_bytes":22,"content_text":"[[FAIL_EMBED]] no luck."}'
FAIL_JOB="$(json "$BODY" job_id)"
curl -sN --max-time "$SSE_MAX_SEC" -H "Authorization: Bearer $KEY_A" "$API_URL/v1/jobs/$FAIL_JOB/events" | grep -E '^event:' || true
wait_job "$FAIL_JOB"
call -H "Authorization: Bearer $KEY_A" "$API_URL/v1/jobs/$FAIL_JOB"

# ---------------------------------------------------------------------------
# 10. 輸入驗證：每種錯誤有自己的 code
# 做什麼：四個故意錯的請求：MIME 不在白名單、沒帶 Idempotency-Key、storage_key 帶 ..、
#         用 ws_beta 的 key 打 ws_alpha 的路徑。
# 為什麼：規格要求「限制檔案類型與大小、不接受任意本機路徑、錯誤格式一致」。
#         預期依序 415 UNSUPPORTED_MEDIA_TYPE、400 IDEMPOTENCY_KEY_REQUIRED、
#         400 INVALID_STORAGE_KEY、404 NOT_FOUND（路徑的 workspace 跟 key 不符也當不存在）。
#         每個 body 都是同一個 { error: { code, message, request_id } } 形狀，客戶端只看 code 就能處理。
step "10. Validation: wrong MIME → 415, missing Idempotency-Key → 400, bad storage_key → 400, ws_beta key on ws_alpha path → 404"
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM-mime" -H 'Content-Type: application/json' \
  -d '{"name":"x.png","mime_type":"image/png","size_bytes":11,"content_text":"hello world"}'
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H 'Content-Type: application/json' \
  -d '{"name":"x.txt","mime_type":"text/plain","size_bytes":11,"content_text":"hello world"}'
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM-key" -H 'Content-Type: application/json' \
  -d '{"name":"x.pdf","mime_type":"application/pdf","size_bytes":11,"storage_key":"ws_alpha/../etc/passwd"}'
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_B" -H "Idempotency-Key: $IDEM-b" -H 'Content-Type: application/json' \
  -d '{"name":"x.txt","mime_type":"text/plain","size_bytes":11,"content_text":"hello world"}'

# ---------------------------------------------------------------------------
# 11. 沒帶 API key → 401
# 做什麼：完全不帶 Authorization 打 POST。
# 為什麼：ApiKeyGuard 是全域的，除了 /health、/ready 之外任何路由都要先過它；
#         401 UNAUTHORIZED 要在驗證 body 之前就回（所以這裡 body 是空的 {} 也不會拿到 400）。
step "11. No API key → 401"
call "$API_URL/v1/workspaces/ws_alpha/documents" -X POST -H 'Content-Type: application/json' -d '{}'

printf '\nDone.\n'
