#!/usr/bin/env bash
# docs/DESIGN.md §11.3：一鍵重現主流程，每步印出狀態碼。
# 順序：建立文件 → curl -N 看 SSE → 查 job → 查 document → 另一租戶 key 查同一 document 得 404
#       → 重送同 Idempotency-Key 得相同回應 → 丟一份 [[FAIL_EMBED]] 看失敗流程 → 驗證錯誤與 401。
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
# 等 job 進入終止狀態
wait_job() {
  local id="$1" status
  for _ in $(seq 1 90); do
    status="$(curl -sS -H "Authorization: Bearer $KEY_A" "$API_URL/v1/jobs/$id" | bun -e "console.log(JSON.parse(await Bun.stdin.text()).status ?? '')")"
    [[ "$status" == "ready" || "$status" == "failed" ]] && return 0
    sleep 1
  done
  echo "timeout waiting for $id" >&2; return 1
}

step "0. health / ready"
call "$API_URL/health"
call "$API_URL/ready"

step "1. POST document (content_text, [[SLOW]] so the stream is visible) → 202"
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM" -H 'Content-Type: application/json' \
  -d '{"name":"[[SLOW]] unit-3.txt","mime_type":"text/plain","size_bytes":11,"content_text":"hello world","metadata":{"grade":5}}'
DOC_ID="$(json "$BODY" document_id)"
JOB_ID="$(json "$BODY" job_id)"
echo "document_id=$DOC_ID job_id=$JOB_ID"

step "2. SSE with curl -N: snapshot → stage_changed / progress → completed, then the server closes"
curl -sN --max-time "$SSE_MAX_SEC" -H "Authorization: Bearer $KEY_A" "$API_URL/v1/jobs/$JOB_ID/events" | tee /tmp/curl-demo-sse || true
wait_job "$JOB_ID"

step "3. GET job → ready, progress 100, retries_used 0"
call -H "Authorization: Bearer $KEY_A" "$API_URL/v1/jobs/$JOB_ID"

step "4. GET document → status ready, chunk_count, result.text_preview"
call -H "Authorization: Bearer $KEY_A" "$API_URL/v1/documents/$DOC_ID"

step "5. ws_beta key reading ws_alpha's document / job / events → 404, identical to a missing id"
call -H "Authorization: Bearer $KEY_B" "$API_URL/v1/documents/$DOC_ID"
call -H "Authorization: Bearer $KEY_B" "$API_URL/v1/jobs/$JOB_ID"
call -H "Authorization: Bearer $KEY_B" "$API_URL/v1/jobs/$JOB_ID/events"
call -H "Authorization: Bearer $KEY_A" "$API_URL/v1/documents/doc_does_not_exist"

step "6. Reconnect with Last-Event-ID (2nd event): snapshot + only the missed events, then close"
# 用第 2 步即時串流裡的第 2 個 id 當「上次收到的」，補發應從第 3 個開始
SECOND_ID="$(grep -E '^id: ' /tmp/curl-demo-sse | sed -n '2p' | cut -d' ' -f2 || true)"
curl -sN --max-time 5 -H "Authorization: Bearer $KEY_A" -H "Last-Event-ID: ${SECOND_ID:-0}" "$API_URL/v1/jobs/$JOB_ID/events" | grep -E '^(id|event):' || true

step "7. Same Idempotency-Key + same body → same ids, Idempotent-Replayed: true"
curl -sS -D - -o /tmp/curl-demo-body -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM" -H 'Content-Type: application/json' \
  -d '{"name":"[[SLOW]] unit-3.txt","mime_type":"text/plain","size_bytes":11,"content_text":"hello world","metadata":{"grade":5}}' \
  | grep -iE '^HTTP|^idempotent-replayed'
cat /tmp/curl-demo-body; echo

step "8. Same Idempotency-Key + different body → 409 IDEMPOTENCY_KEY_REUSED"
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM" -H 'Content-Type: application/json' \
  -d '{"name":"other.txt","mime_type":"text/plain","size_bytes":11,"content_text":"hello world"}'

step "9. [[FAIL_EMBED]] document: retry_scheduled twice, then failed (attempt 3, last_error set)"
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM-fail" -H 'Content-Type: application/json' \
  -d '{"name":"fail.txt","mime_type":"text/plain","size_bytes":22,"content_text":"[[FAIL_EMBED]] no luck."}'
FAIL_JOB="$(json "$BODY" job_id)"
curl -sN --max-time "$SSE_MAX_SEC" -H "Authorization: Bearer $KEY_A" "$API_URL/v1/jobs/$FAIL_JOB/events" | grep -E '^event:' || true
wait_job "$FAIL_JOB"
call -H "Authorization: Bearer $KEY_A" "$API_URL/v1/jobs/$FAIL_JOB"

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

step "11. No API key → 401"
call "$API_URL/v1/workspaces/ws_alpha/documents" -X POST -H 'Content-Type: application/json' -d '{}'

printf '\nDone.\n'
