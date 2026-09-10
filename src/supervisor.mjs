import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { acquireLock } from './operations.mjs';

// Paper only. Live workers must be started explicitly and are never restarted here.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'runtime', 'paper'); mkdirSync(runtime, { recursive: true });
const lock = await acquireLock(join(runtime, 'supervisor'));
let stopping = false; let child;
process.once('SIGINT', () => { stopping = true; child?.kill(); });
process.once('SIGTERM', () => { stopping = true; child?.kill(); });
try {
  while (!stopping) {
    if (existsSync(join(runtime, 'ledger.sqlite'))) {
      const db = new DatabaseSync(join(runtime, 'ledger.sqlite'), { readOnly: true });
      const command = db.prepare('SELECT command FROM control WHERE id=1').get()?.command; db.close();
      if (command === 'stop') break;
    }
    const output = openSync(join(runtime, 'worker.log'), 'a');
    child = spawn(process.execPath, [join(root, 'src', 'cli.mjs'), 'run', '--mode', 'paper'],
      { cwd: root, windowsHide: true, stdio: ['ignore', output, output] });
    closeSync(output);
    const outcome = await new Promise(resolveExit => {
      child.once('error', () => resolveExit(1)); child.once('exit', code => resolveExit(code));
    });
    if (outcome === 0) break;
    await sleep(10000);
  }
} finally { await new Promise(resolveClose => lock.close(resolveClose)); }
