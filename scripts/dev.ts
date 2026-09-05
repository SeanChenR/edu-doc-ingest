// Runs api and worker together with hot reload. Ctrl+C stops both.
// Usage: the `dev` script in package.json

import { spawn } from 'bun';

const procs = ['src/api/main.ts', 'src/worker/main.ts'].map((entry) =>
  spawn(['bun', '--bun', '--watch', entry], { stdio: ['inherit', 'inherit', 'inherit'] }),
);

const stop = (): void => {
  for (const p of procs) p.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const codes = await Promise.all(procs.map((p) => p.exited));
process.exit(codes.find((c) => c !== 0) ?? 0);
