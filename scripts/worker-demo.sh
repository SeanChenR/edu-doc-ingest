#!/usr/bin/env bash
# slice 3 的 worker 示範：建立五種文件，等 worker 處理完，印出 jobs / documents / chunks / events / 佇列。
# GET 端點要到 slice 4 才有，所以狀態用 psql 直接看資料庫。
# 前置：api 與 worker 在跑（另一個終端機 `bun run dev`），.env 有 DATABASE_URL_ADMIN。
# 用法：scripts/worker-demo.sh
# 對 podman compose 的 stack 跑時，api 在容器裡、資料在容器 db（port 5433），要覆寫連線：
#   DATABASE_URL_ADMIN=postgres://postgres:postgres@localhost:5433/doc_ingest scripts/worker-demo.sh
set -euo pipefail

# 指令列給的變數優先，.env 只補沒設定的
PRESET_DB="${DATABASE_URL_ADMIN:-}"; PRESET_API="${API_URL:-}"
if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi
API_URL="${PRESET_API:-${API_URL:-http://localhost:3000}}"
KEY="${API_KEY_ALPHA:-${SEED_API_KEY_ALPHA:?set API_KEY_ALPHA}}"
DB="${PRESET_DB:-${DATABASE_URL_ADMIN:?set DATABASE_URL_ADMIN}}"
RUN="demo-$(date +%s)"
JOB_IDS=()

step() { printf '\n== %s\n' "$1"; }
sql() { psql "$DB" -Atc "$1"; }

# POST 一份文件，印狀態碼與 job_id，記下 job_id 供後面查詢
post() {
  local label="$1" body="$2" out code
  out="$(curl -sS -o /tmp/worker-demo-body -w '%{http_code}' -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
    -H "Authorization: Bearer $KEY" -H "Idempotency-Key: $RUN-$label" -H 'Content-Type: application/json' -d "$body")"
  code="$out"
  local job_id
  job_id="$(bun -e "const d=JSON.parse(process.argv[1]); console.log(d.job_id ?? '')" "$(cat /tmp/worker-demo-body)")"
  printf '%-10s HTTP %s  job_id=%s\n' "$label" "$code" "$job_id"
  [[ -n "$job_id" ]] && JOB_IDS+=("$job_id")
}

# 等所有 job 進入終止狀態（ready / failed），上限 90 秒（重試退避 2 秒 + 5 秒，加人為延遲）
wait_terminal() {
  local ids csv n
  ids=$(printf "'%s'," "${JOB_IDS[@]}"); csv="${ids%,}"
  for _ in $(seq 1 90); do
    n="$(sql "select count(*) from jobs where id in ($csv) and status not in ('ready','failed')")"
    [[ "$n" == "0" ]] && return 0
    sleep 1
  done
  echo "timeout: some jobs are still running" >&2
  return 1
}

step "0. health / ready"
curl -sS -w ' [%{http_code}]\n' "$API_URL/ready"

step "1. POST five documents (text, PDF via storage_key, retry-once, always-fail, missing file)"
post text    '{"name":"demo.txt","mime_type":"text/plain","size_bytes":53,"content_text":"第一段落。\n\n第二段落 hello world. abcdefghij"}'
post pdf     '{"name":"unit-3-fractions.pdf","mime_type":"application/pdf","size_bytes":877,"storage_key":"ws_alpha/samples/unit-3-fractions.pdf"}'
post once    '{"name":"once.txt","mime_type":"text/plain","size_bytes":31,"content_text":"[[FAIL_EMBED_ONCE]] retry me ok"}'
post always  '{"name":"always.txt","mime_type":"text/plain","size_bytes":26,"content_text":"[[FAIL_EMBED]] never works"}'
post missing '{"name":"ghost.pdf","mime_type":"application/pdf","size_bytes":10,"storage_key":"ws_alpha/samples/does-not-exist.pdf"}'

step "2. waiting for the worker (watch the other terminal)"
wait_terminal
IDS=$(printf "'%s'," "${JOB_IDS[@]}"); IDS="${IDS%,}"

step "3. jobs  (expect: text/pdf ready@1, once ready@2, always failed@3 EMBEDDING_PROVIDER_ERROR, missing failed@3 STORAGE_READ_FAILED)"
sql "select d.name, j.status, j.progress, j.attempt, coalesce(j.last_error_code,'-'), coalesce(j.last_error_message,'-')
     from jobs j join documents d on d.id = j.document_id where j.id in ($IDS) order by j.created_at" | column -t -s '|'

step "4. documents  (expect: pdf page_count 2; ready ones have chunk_count)"
sql "select d.name, d.status, coalesce(d.page_count::text,'-'), coalesce(d.chunk_count::text,'-'), coalesce(length(d.extracted_text)::text,'-') as text_len
     from documents d join jobs j on j.document_id = d.id where j.id in ($IDS) order by d.created_at" | column -t -s '|'

step "5. chunks  (1536-dim vectors)"
sql "select d.name, c.chunk_index, c.token_count, vector_dims(c.embedding)
     from document_chunks c join documents d on d.id = c.document_id join jobs j on j.document_id = d.id
     where j.id in ($IDS) order by d.created_at, c.chunk_index" | column -t -s '|'

step "6. job_events for the retry-once job  (expect retry_scheduled, then 'extraction checkpoint reused' on attempt 2)"
ONCE_ID="${JOB_IDS[2]}"
sql "select id, type, coalesce(stage,'-'), progress, attempt, coalesce(message,'-') from job_events where job_id = '$ONCE_ID' order by id" | column -t -s '|'

step "7. queue  (expect q = 0, archive += 5)"
sql "select 'q_document_jobs', count(*) from pgmq.q_document_jobs union all select 'a_document_jobs', count(*) from pgmq.a_document_jobs" | column -t -s '|'

printf '\nDone. Slice 4 adds GET /v1/jobs/:id, GET /v1/documents/:id and SSE at /v1/jobs/:id/events.\n'
