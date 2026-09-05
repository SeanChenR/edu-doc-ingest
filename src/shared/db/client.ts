import { SQL, type TransactionSQL } from 'bun';

export type Db = SQL;
export type Tx = TransactionSQL;

export function createDb(url: string): Db {
  return new SQL(url, { max: 10 });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// docs/DESIGN.md §1.5: exponential backoff, give up after maxWaitSec.
export async function connectWithRetry(
  db: Db,
  maxWaitSec: number,
  log: (msg: string) => void = () => {},
): Promise<void> {
  const deadline = Date.now() + maxWaitSec * 1000;
  let delayMs = 500;
  for (;;) {
    try {
      await db`select 1`;
      return;
    } catch (err) {
      if (Date.now() + delayMs > deadline) {
        throw new Error(`Database not reachable after ${maxWaitSec}s: ${errorMessage(err)}`, {
          cause: err,
        });
      }
      log(`database not ready, retrying in ${delayMs}ms`);
      await Bun.sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 5000);
    }
  }
}

// docs/DESIGN.md §7.3: every tenant query runs inside this. `set_config(..., true)` is
// transaction-local, so the setting disappears at commit/rollback.
export function withTenant<T>(db: Db, workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  });
}
