// compose healthcheck 用的小腳本：`bun vm/healthcheck.ts api` 或 `bun vm/healthcheck.ts worker`。
// 為什麼不直接在 compose 檔寫 `bun -e "..."`：podman-compose 會把 CMD 陣列拼成 shell 字串，
// 引號和括號會被吃掉（/bin/sh: Syntax error: "(" unexpected），檢查永遠失敗。
// 這個檔隨 `COPY . .` 進 image，路徑固定 /app/vm/healthcheck.ts。
const HEARTBEAT_MAX_AGE_MS = 30_000;

async function apiHealthy(): Promise<boolean> {
  // 用 127.0.0.1 不用 localhost：rootless 容器裡 localhost 可能先解析成 ::1
  const res = await fetch('http://127.0.0.1:3000/health').catch(() => null);
  return res?.ok ?? false;
}

async function workerHealthy(): Promise<boolean> {
  // 主迴圈每輪 touch 一次；30 秒沒更新就當它卡住
  const file = Bun.file(process.env['WORKER_HEARTBEAT_FILE'] ?? '/app/storage/.worker-heartbeat');
  if (!(await file.exists())) return false;
  return Date.now() - file.lastModified < HEARTBEAT_MAX_AGE_MS;
}

const kind = Bun.argv[2];
const ok = kind === 'api' ? await apiHealthy() : kind === 'worker' ? await workerHealthy() : false;
process.exit(ok ? 0 : 1);
