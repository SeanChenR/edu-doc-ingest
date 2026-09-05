#!/usr/bin/env bash
# docs/DESIGN.md §11.3：一鍵重現主流程，每步印出狀態碼。
# 目前只到 slice 2 的範圍（建立文件、冪等重播、跨租戶 404）；SSE / job / document 查詢隨 slice 3、4 補上。
# 用法：API_URL=http://localhost:3000 API_KEY_ALPHA=... API_KEY_BETA=... scripts/curl-demo.sh
#（預設讀 .env 的 SEED_API_KEY_ALPHA / SEED_API_KEY_BETA）
set -euo pipefail

# 指令列給的 API_URL 優先，.env 只補沒設定的
PRESET_API="${API_URL:-}"
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi
API_URL="${PRESET_API:-${API_URL:-http://localhost:3000}}"
KEY_A="${API_KEY_ALPHA:-${SEED_API_KEY_ALPHA:?set API_KEY_ALPHA}}"
KEY_B="${API_KEY_BETA:-${SEED_API_KEY_BETA:?set API_KEY_BETA}}"
IDEM="demo-$(date +%s)"

step() { printf '\n== %s\n' "$1"; }
# 印狀態碼 + body；body 存到 $BODY 供下一步取值
call() {
  local out
  out="$(curl -sS -o /tmp/curl-demo-body -w '%{http_code}' "$@")"
  BODY="$(cat /tmp/curl-demo-body)"
  printf 'HTTP %s  %s\n' "$out" "$BODY"
}
json() { bun -e "const d=JSON.parse(process.argv[1]); console.log(d.$2 ?? '')" "$1"; }

step "0. health / ready"
call "$API_URL/health"
call "$API_URL/ready"

step "1. POST document (content_text) → 202"
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM" -H 'Content-Type: application/json' \
  -d '{"name":"unit-3.txt","mime_type":"text/plain","size_bytes":11,"content_text":"hello world","metadata":{"grade":5}}'
DOC_ID="$(json "$BODY" document_id)"
JOB_ID="$(json "$BODY" job_id)"
echo "document_id=$DOC_ID job_id=$JOB_ID"

step "2. Same Idempotency-Key + same body → same ids, Idempotent-Replayed: true"
curl -sS -D - -o /tmp/curl-demo-body -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM" -H 'Content-Type: application/json' \
  -d '{"name":"unit-3.txt","mime_type":"text/plain","size_bytes":11,"content_text":"hello world","metadata":{"grade":5}}' \
  | grep -iE '^HTTP|^idempotent-replayed'
cat /tmp/curl-demo-body; echo

step "3. Same Idempotency-Key + different body → 409 IDEMPOTENCY_KEY_REUSED"
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM" -H 'Content-Type: application/json' \
  -d '{"name":"other.txt","mime_type":"text/plain","size_bytes":11,"content_text":"hello world"}'

step "4. ws_beta key on ws_alpha path → 404 NOT_FOUND (never 403)"
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_B" -H "Idempotency-Key: $IDEM-b" -H 'Content-Type: application/json' \
  -d '{"name":"x.txt","mime_type":"text/plain","size_bytes":11,"content_text":"hello world"}'

step "5. Validation: wrong MIME → 415, missing Idempotency-Key → 400, bad storage_key → 400"
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM-mime" -H 'Content-Type: application/json' \
  -d '{"name":"x.png","mime_type":"image/png","size_bytes":11,"content_text":"hello world"}'
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H 'Content-Type: application/json' \
  -d '{"name":"x.txt","mime_type":"text/plain","size_bytes":11,"content_text":"hello world"}'
call -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY_A" -H "Idempotency-Key: $IDEM-key" -H 'Content-Type: application/json' \
  -d '{"name":"x.pdf","mime_type":"application/pdf","size_bytes":11,"storage_key":"ws_alpha/../etc/passwd"}'

step "6. No API key → 401"
call "$API_URL/v1/workspaces/ws_alpha/documents" -X POST -H 'Content-Type: application/json' -d '{}'

printf '\nDone. Next steps (slice 3/4): watch SSE with curl -N %s/v1/jobs/%s/events\n' "$API_URL" "$JOB_ID"
