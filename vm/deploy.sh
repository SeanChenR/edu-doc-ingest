#!/usr/bin/env bash
# 在 VM 上部署或更新 doc-ingest：pull → build → up → migrate → seed → /ready。
# 每一步都是冪等的，重跑安全（migrate 記在 schema_migrations，seed 用 upsert）。
# 前置：podman + podman-compose（Debian 13：apt install podman podman-compose）、
#       `sudo loginctl enable-linger $USER`、rootless 綁 80/443 的 sysctl（見 vm/README.md）、vm/.env 已填。
# 用法：vm/deploy.sh            （第一次會 build image，約 1–2 分鐘）
#       vm/deploy.sh --no-build （只重啟、重跑 migrate/seed）
set -euo pipefail

cd "$(dirname "$0")/.."                      # repo 根目錄
ENV_FILE=vm/.env
[[ -f $ENV_FILE ]] || { echo "缺 $ENV_FILE：cp vm/.env.example $ENV_FILE 然後填密碼與 key"; exit 1; }
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

COMPOSE=(podman compose -f vm/docker-compose.yml -p doc-ingest)
step() { printf '\n== %s\n' "$1"; }

step "0. git pull"
git pull --ff-only

# Dockerfile 的 FROM 是 oven/bun:1（沒寫 registry）；先用完整名稱拉下來，
# rootless podman 之後就能用短名稱對到本機這份 image，不依賴 registries.conf 的 search list。
step "1. pull base images"
podman pull docker.io/oven/bun:1 docker.io/pgvector/pgvector:pg18-trixie docker.io/library/caddy:2

if [[ "${1:-}" != "--no-build" ]]; then
  step "2. build api / worker image"
  "${COMPOSE[@]}" build
fi

step "3. compose up"
"${COMPOSE[@]}" up -d

step "4. wait for db"
for _ in $(seq 1 30); do
  "${COMPOSE[@]}" exec db pg_isready -U postgres -d doc_ingest >/dev/null 2>&1 && break
  sleep 2
done
"${COMPOSE[@]}" exec db pg_isready -U postgres -d doc_ingest

# 在 api 的 image 裡跑，image 已含 scripts/ 與 migrations/；DATABASE_URL_ADMIN 等變數由 compose 檔給
step "5. migrate + seed（容器內）"
"${COMPOSE[@]}" run --rm --no-deps api bun run migrate
"${COMPOSE[@]}" run --rm --no-deps api bun run seed

step "6. /ready"
if [[ "$SITE_ADDRESS" == :* ]]; then
  URL="http://127.0.0.1${SITE_ADDRESS/:80/}/ready"          # :80 → http://127.0.0.1/ready
else
  URL="https://${SITE_ADDRESS}/ready"                        # Let's Encrypt 第一次要幾十秒，多試幾次
fi
for i in $(seq 1 12); do
  if curl -fsS --max-time 5 "$URL"; then echo; break; fi
  [[ $i -eq 12 ]] && { echo "ready 沒回 200：podman compose -f vm/docker-compose.yml -p doc-ingest logs caddy api" >&2; exit 1; }
  sleep 5
done

step "7. 狀態"
"${COMPOSE[@]}" ps
printf '\nDone. API: %s\n' "${URL%/ready}"
