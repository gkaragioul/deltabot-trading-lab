import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { config, SOL, USDC } from './config.mjs';
import { Store } from './store.mjs';
import { Providers, safeError } from './providers.mjs';
import { Engine } from './engine.mjs';
import { LiveBroker } from './live.mjs';
import { acquireLock, workerRunning, report } from './operations.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2); const command = args.shift() ?? 'status';
const options = {};
while (args.length) {
  const key = args.shift(); const value = args.shift();
  if (!['--mode', '--runtime', '--config', '--cycles'].includes(key) || !value) throw new Error('Invalid command options');
  options[key.slice(2)] = value;
}
const mode = options.mode ?? 'paper';
if (!['paper', 'live'].includes(mode)) throw new Error('Mode must be paper or live');
const runtime = resolve(options.runtime ?? join(root, 'runtime', mode));
const c = config(options.config ? JSON.parse(readFileSync(resolve(options.config), 'utf8')) : {});
const cycles = options.cycles === undefined ? Infinity : Number(options.cycles);
if (cycles !== Infinity && (!Number.isInteger(cycles) || cycles < 1)) throw new Error('Cycles must be a positive integer');
const data = new Providers(c);
let db; let lock;

function writeReport(running) {
  const s = db.read(); s.operatorCommand = db.getCommand();
  const text = report(s, c, db.events(), running);
  writeFileSync(join(runtime, 'STATUS.md'), text);
  return text;
}

async function main() {
  if (command === 'doctor') {
    const result = { mode, quoteProvider: data.source, checks: {}, liveConfigured: Boolean(process.env.JUPITER_API_KEY && process.env.SOLANA_RPC_URL && process.env.SOLANA_KEYPAIR_PATH && process.env.LIVE_TRADING === '1') };
    for (const [name, action] of Object.entries({
      discovery: async () => ({ candidates: (await data.discover()).length }),
      quote: async () => { const q = await data.quote(USDC, SOL, '5000000'); return { source: q.source, inputUSDC: '5', outputLamports: q.out }; },
      rpc: async () => ({ slot: await data.rpc('getSlot', [{ commitment: 'confirmed' }]) }),
      holderData: async () => ({ accounts: (await data.rpc('getTokenLargestAccounts', [USDC, { commitment: 'confirmed' }])).value.length }),
    })) {
      try { result.checks[name] = { ok: true, ...await action() }; }
      catch (e) { result.checks[name] = { ok: false, error: safeError(e) }; }
    }
    console.log(JSON.stringify(result, null, 2));
    if (Object.values(result.checks).some(x => !x.ok)) process.exitCode = 2;
    return;
  }
  if (!['run', 'status', 'pause', 'resume', 'flatten', 'stop', 'export'].includes(command)) throw new Error('Unknown command');
  if (command === 'run') {
    lock = await acquireLock(runtime); mkdirSync(runtime, { recursive: true });
  } else if (!existsSync(join(runtime, 'ledger.sqlite'))) throw new Error('Run the paper experiment first; no ledger exists');
  db = new Store(runtime, c, mode);
  if (command === 'status') { console.log(writeReport(await workerRunning(runtime))); return; }
  if (command === 'export') {
    const destination = join(runtime, 'events.jsonl');
    writeFileSync(destination, db.events(1_000_000).reverse().map(x => JSON.stringify(x)).join('\n') + '\n');
    console.log(destination); return;
  }
  if (command !== 'run') {
    if (command === 'resume' && (db.read().paused || db.read().pending)) throw new Error('Resolve ledger halt or pending transaction before resuming');
    db.command(command === 'resume' ? null : command); writeReport(await workerRunning(runtime));
    console.log(command === 'stop' ? 'Worker stop requested. Open positions will remain held; flatten first if you want exits.' : `Control set: ${command}`); return;
  }
  if (db.getCommand() === 'stop') { console.log('Stop request remains active. Use resume before starting.'); return; }
  let live = null;
  if (mode === 'live') { live = LiveBroker.fromEnvironment(db, c, data); await live.initialize(); }
  const engine = new Engine(db, c, data, { live }); let stopping = false;
  const abort = new AbortController();
  const stop = () => { stopping = true; abort.abort(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  writeFileSync(join(runtime, 'worker.json'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode, runtime }));
  console.log(`${mode.toUpperCase()} worker started; status: ${join(runtime, 'STATUS.md')}`);
  writeReport(true);
  for (let n = 0; n < cycles && !stopping; n++) {
    if (db.getCommand() === 'stop') break;
    try {
      const state = await engine.tick();
      console.log(JSON.stringify({ at: new Date().toISOString(), mode, scans: state.scans, buys: state.buys, sells: state.sells, positions: Object.keys(state.positions).length, error: state.lastError, pending: Boolean(state.pending) }));
    } catch (e) {
      const s = db.read(); s.lastError = safeError(e); s.lastTick = Date.now();
      db.save(s, [{ type: 'cycle_error', at: Date.now(), error: s.lastError }]);
      console.error(s.lastError);
      if (mode === 'live') { writeReport(false); process.exitCode = 2; break; }
    }
    writeReport(true);
    if (n + 1 < cycles && !stopping) await sleep(c.pollSeconds * 1000, undefined, { signal: abort.signal }).catch(() => {});
  }
  writeReport(false);
}

try { await main(); }
catch (e) { console.error(e.message); process.exitCode = 1; }
finally { db?.close(); if (lock) await new Promise(resolveClose => lock.close(resolveClose)); }
