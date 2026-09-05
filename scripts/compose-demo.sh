#!/usr/bin/env bash
# 用 podman compose 起三個容器（db / api / worker），對容器 db 做 migrate + seed，POST 一份文件，
# 等 worker 容器把它做到 ready。每步印結果。結束時不會關掉容器；要關：podman compose down
# 前置：podman machine 已啟動；port 3000 沒被本機的 api 占用（先停 `bun run dev`）。
# 用法：scripts/compose-demo.sh          （第一次會 build 映像，之後加 --no-build 可略過）
set -euo pipefail

ADMIN_URL="postgres://postgres:postgres@localhost:5433/doc_ingest"
API_URL="http://localhost:3000"
KEY="dk_alpha_local_only"

step() { printf '\n== %s\n' "$1"; }
sql() { psql "$ADMIN_URL" -Atc "$1"; }

step "0. podman machine"
podman machine list --format '{{.Name}} running={{.Running}}'
podman info --format 'podman {{.Version.Version}}' >/dev/null || { echo "podman machine 沒在跑：podman machine start"; exit 1; }

# api 容器已經在跑時 port 3000 是 podman 自己占的，那是正常的
API_UP="$(podman ps --filter name=edu-doc-ingest-api-1 --filter status=running --format '{{.Names}}')"
if [[ -z "$API_UP" ]] && lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port 3000 已被占用（大概是 bun run dev），先停掉再跑"; exit 1
fi

step "1. compose up（首次會 build；鑰匙圈視窗按允許）"
podman compose up -d ${1:-}

step "2. 等 db 就緒"
for _ in $(seq 1 30); do
  podman exec edu-doc-ingest-db-1 pg_isready -U postgres -d doc_ingest >/dev/null 2>&1 && break
  sleep 2
done
sql "select version()" | cut -c1-40

step "3. migrate + seed 對容器 db（5433）"
DATABASE_URL_ADMIN="$ADMIN_URL" bun run migrate
DATABASE_URL_ADMIN="$ADMIN_URL" bun run seed
# seed 把範例 PDF 寫在宿主機的 ./storage；容器用的是 volume，另外放一份進去
podman exec edu-doc-ingest-api-1 mkdir -p /app/storage/ws_alpha/samples /app/storage/ws_beta/samples
podman cp scripts/fixtures/unit-3-fractions.pdf edu-doc-ingest-api-1:/app/storage/ws_alpha/samples/unit-3-fractions.pdf
podman cp scripts/fixtures/unit-3-fractions.pdf edu-doc-ingest-api-1:/app/storage/ws_beta/samples/unit-3-fractions.pdf

step "4. 等 api 容器就緒"
for _ in $(seq 1 30); do curl -sf -o /dev/null "$API_URL/health" && break; sleep 1; done
curl -s -w ' [%{http_code}]\n' "$API_URL/ready"

step "5. POST 一份文件"
BODY='{"name":"compose.txt","mime_type":"text/plain","size_bytes":25,"content_text":"hello from podman compose"}'
RES="$(curl -s -X POST "$API_URL/v1/workspaces/ws_alpha/documents" \
  -H "Authorization: Bearer $KEY" -H "Idempotency-Key: compose-$(date +%s)" \
  -H 'Content-Type: application/json' -d "$BODY")"
echo "$RES"
JOB_ID="$(bun -e "console.log(JSON.parse(process.argv[1]).job_id ?? '')" "$RES")"
[[ -n "$JOB_ID" ]] || { echo "POST 失敗"; exit 1; }

step "6. 等 worker 容器處理（最多 60 秒）"
for _ in $(seq 1 60); do
  STATUS="$(sql "select status from jobs where id = '$JOB_ID'")"
  [[ "$STATUS" == "ready" || "$STATUS" == "failed" ]] && break
  sleep 1
done
sql "select d.name, j.status, j.progress, j.attempt, d.chunk_count, d.storage_key from jobs j join documents d on d.id = j.document_id where j.id = '$JOB_ID'" | column -t -s '|'
sql "select 'q_document_jobs', count(*) from pgmq.q_document_jobs union all select 'a_document_jobs', count(*) from pgmq.a_document_jobs" | column -t -s '|'

step "7. 容器狀態（三個都應該 healthy）"
podman ps --format '{{.Names}}  {{.Status}}'

step "8. worker 容器的關鍵 log"
podman logs edu-doc-ingest-worker-1 2>&1 | grep -E '"msg":"(worker started|extracted|job ready)"' \
  | sed -E 's/.*"context":"([^"]+)".*"msg":"([^"]+)".*/\1: \2/' | tail -5

printf '\nDone. 容器還在跑：podman compose down 關掉（volume 保留）；podman compose down -v 連資料一起清。\n'
