import net from 'node:net';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { dollars, usd } from './config.mjs';
import { risk } from './strategy.mjs';

function lockAddress(dir) {
  const name = 'deltabot-' + createHash('sha256').update(resolve(dir).toLowerCase()).digest('hex').slice(0, 32);
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `\0${name}`;
}
export function acquireLock(dir) {
  return new Promise((resolveLock, reject) => {
    const server = net.createServer(socket => socket.end());
    server.once('error', () => reject(new Error('WORKER_ALREADY_RUNNING_OR_LOCK_PORT_UNAVAILABLE')));
    server.listen(lockAddress(dir), () => resolveLock(server));
  });
}
export function workerRunning(dir) {
  return new Promise(resolveRunning => {
    const socket = net.connect(lockAddress(dir));
    let done = false;
    const finish = value => { if (!done) { done = true; socket.destroy(); resolveRunning(value); } };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}
export function report(s, c, events, running, now = Date.now()) {
  s = structuredClone(s);
  for (const p of Object.values(s.positions)) {
    if (p.value !== null && (!Number.isFinite(p.valuedAt) || now - p.valuedAt > Math.max(180000, c.pollSeconds * 3000))) {
      p.stale = true; p.value = null;
    }
  }
  const money = n => `$${dollars(n).toFixed(2)}`;
  const safe = value => String(value ?? '').replace(/[\r\n|`<>\[\]]/g, ' ').slice(0, 120);
  const check = risk(s, c); const reserve = usd(c.totalUsd) - (s.initialEquity ?? usd(c.activeUsd));
  const fresh = s.lastTick && now - s.lastTick <= Math.max(180000, c.pollSeconds * 3000);
  const status = !running ? 'Stopped' : !fresh ? 'Starting or stale — inspect worker log' : s.lastError ? 'Running — provider error' : 'Running';
  const lines = ['# Memecoin Lab', '',
    `**${s.mode === 'paper' ? 'PAPER MODE — SIMULATED MONEY, NOT EARNINGS' : 'LIVE MODE — REAL WALLET'}**`, '',
    `Updated: ${new Date(now).toISOString()}`, '',
    `Service: **${status}**. New entries: **${s.operatorCommand ?? check.reason ?? 'enabled when a candidate qualifies'}**.`, '',
    `Blockchain data connection: ${safe(s.rpcHost ?? 'not yet recorded')}.`, '',
    `Quote provider: ${safe(s.quoteProvider ?? 'not yet recorded')}${s.jupiterAccess ? ` (${safe(s.jupiterAccess)})` : ''}.`, '',
    '| Measure | Amount |', '| --- | ---: |',
    `| Total conservative value, including reserve | ${money(check.equity + reserve)} |`,
    `| Active account value | ${money(check.equity)} |`,
    `| Available cash${s.mode === 'live' ? ' including SOL fee reserve' : ''} | ${money(s.cash)} |`,
    `| Reserved outside trading | ${money(reserve)} |`,
    `| Closed-trade net profit/loss | ${money(s.realized)} |`,
    `| Active account change | ${money(check.equity - (s.initialEquity ?? usd(c.activeUsd)))} |`,
    `| Drawdown from peak | ${money(check.drawdown)} |`, '',
    `Scans: ${s.scans}. Purchases: ${s.buys}. Sales: ${s.sells}. Open positions: ${Object.keys(s.positions).length}.`, '',
    `Last cycle: ${s.lastTick ? new Date(s.lastTick).toISOString() : 'not completed'}.`,
    `Latest error: ${safe(s.lastError ?? 'none')}. Pending transaction: ${s.pending ? safe(s.pending.signature) : 'none'}.`, '',
    '## Open positions', '', '| Token | Cost | Estimated net exit value |', '| --- | ---: | ---: |'];
  for (const p of Object.values(s.positions)) lines.push(`| ${safe(p.symbol || p.mint)} | ${money(p.cost)} | ${p.stale ? 'Stale — valued at zero' : p.value == null ? 'Unavailable — valued at zero' : money(p.value)} |`);
  if (!Object.keys(s.positions).length) lines.push('| None | — | — |');
  lines.push('', '## Latest screening decisions', '', '| Token | Decision |', '| --- | --- |');
  for (const row of s.latestDecisions ?? []) lines.push(`| ${safe(row.symbol || row.mint)} | ${safe(row.reason)} |`);
  lines.push('', '## Recent events', '');
  for (const e of events.slice(0, 12)) lines.push(`- ${new Date(e.at).toISOString()} · ${safe(e.type)} · ${safe(e.reason ?? e.error ?? e.mint ?? '')}`);
  lines.push('', '## Interpretation', '',
    'Quotes are estimates, not completed fills. An unavailable exit is valued at zero and blocks entries; the position remains open.',
    'USDC amounts are treated as USD at parity. A depeg invalidates that valuation assumption.',
    `Paper costs: ${c.paperAdverseBps} bps adverse execution beyond quote minimum; $${c.paperBuyOverheadUsd.toFixed(2)} per entry and $${c.paperSellOverheadUsd.toFixed(2)} per exit for assumed network/account costs. Actual live costs differ.`,
    'Discovery uses recent DEX Screener profiles, which are a selective/promotional sample, not every token. Screening heuristics do not establish a profitable edge.',
    'Live closed-trade P&L includes wallet SOL debits valued at the recorded SOL price. Active account value also reflects SOL price changes.',
    'This report is a snapshot. Run the status command to verify that the worker is still running.', '', `Configuration: ${s.configHash}`, '');
  return lines.join('\n');
}
