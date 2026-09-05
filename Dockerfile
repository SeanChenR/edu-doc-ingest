# docs/DESIGN.md §2, D-06: one Dockerfile, two targets.
#   podman build --target api    -t doc-ingest-api .
#   podman build --target worker -t doc-ingest-worker .
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
