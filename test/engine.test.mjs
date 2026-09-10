import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { config, USDC } from '../src/config.mjs';
import { Engine } from '../src/engine.mjs';

function setup() {
  const c = config(); const dir = mkdtempSync(join(tmpdir(), 'engine-'));
  const db = new Store(dir, c); let now = 4_000_000; let sellOut = '5000000'; let failExit = false;
  const market = { mint: 'token', symbol: 'TOKEN', price: 1.05, liquidity: 100000,
    volume5m: 10000, buys: 30, sells: 10, change5m: 5, createdAt: 0, at: now };
  const data = {
    async discover() { return [{ ...market, at: now }]; },
    async screen() { return { ok: true, decimals: 6 }; },
    async quote(inputMint, outputMint, amount) {
      if (inputMint !== USDC && failExit) throw new Error('NO_ROUTE');
      return { inputMint, outputMint, amount, out: inputMint === USDC ? '5000000' : sellOut,
        minOut: inputMint === USDC ? '4950000' : sellOut, at: now, source: 'fixture' };
    },
  };
  const s = db.read(); s.history.token = [{ at: now - 300000, price: 1 }, { at: now - 150000, price: 1.08 }]; db.save(s);
  return { c, db, data, engine: new Engine(db, c, data, { now: () => now, sleep: async ms => { now += ms; } }),
    advance: ms => { now += ms; }, setSell: n => { sellOut = n; }, fail: () => { failExit = true; },
    cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('paper fills deduct costs and adverse execution, then persist through engine restart', async () => {
  const x = setup(); try {
    await x.engine.tick(); const s = x.db.read();
    assert.equal(s.cash, 14_650_000); assert.equal(s.buys, 1);
    assert.equal(s.positions.token.amount, '4925250');
    assert.equal(s.positions.token.cost, 5_350_000);
    const e = new Engine(x.db, x.c, x.data); await e.tick();
    assert.equal(x.db.read().buys, 1);
    assert.equal(x.db.events().filter(e => e.type === 'buy')[0].mode, 'paper');
  } finally { x.cleanup(); }
});

test('a failed exit remains open, contributes zero conservative value and prevents new entries', async () => {
  const x = setup(); try {
    await x.engine.tick(); x.fail(); x.advance(60000); await x.engine.tick();
    const s = x.db.read(); assert.equal(s.positions.token.value, null);
    assert.equal(s.sells, 0); assert.equal(s.buys, 1);
    assert.equal(s.cash, 14_650_000);
  } finally { x.cleanup(); }
});

test('take profit records net proceeds and cooldown prevents immediate re-entry', async () => {
  const x = setup(); try {
    await x.engine.tick(); x.setSell('7000000'); x.advance(60000); await x.engine.tick();
    const s = x.db.read(); assert.equal(s.sells, 1); assert.equal(s.buys, 1);
    assert.equal(s.cash, 21_595_000); assert.equal(s.realized, 1_595_000);
    assert.equal(Object.keys(s.positions).length, 0);
    x.advance(60000); await x.engine.tick(); assert.equal(x.db.read().buys, 1);
  } finally { x.cleanup(); }
});

test('pause stops buys while flatten attempts existing exits', async () => {
  const x = setup(); try {
    x.db.command('pause'); await x.engine.tick(); assert.equal(x.db.read().buys, 0);
    x.db.command(null); await x.engine.tick(); assert.equal(x.db.read().buys, 1);
    x.db.command('flatten'); await x.engine.tick(); assert.equal(x.db.read().sells, 1);
    assert.equal(x.db.read().buys, 1);
  } finally { x.cleanup(); }
});

test('discovery outage still permits management of open positions', async () => {
  const x = setup(); try {
    await x.engine.tick(); x.setSell('7000000');
    x.data.discover = async () => { throw new Error('HTTP_503'); };
    await x.engine.tick(); assert.equal(x.db.read().sells, 1);
    assert.match(x.db.read().lastError, /HTTP_503/);
  } finally { x.cleanup(); }
});

test('a finalized live sale does not discard the next position mark when state is reloaded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-marks-')); const c = config({ maxDrawdownUsd: 4, stopLossPct: 99 });
  const db = new Store(dir, c, 'live');
  try {
    const s = db.read(); s.cash = 10_000_000;
    s.positions.a = { mint: 'a', amount: '5', cost: 5_000_000, value: 5_000_000, peakValue: 5_000_000, openedAt: 0 };
    s.positions.b = { mint: 'b', amount: '5', cost: 5_000_000, value: 5_000_000, peakValue: 5_000_000, openedAt: 4_000_000 };
    db.save(s);
    const data = { async quote(mint) { return { minOut: mint === 'a' ? '4020000' : '1020000', at: 4_000_000 }; }, async discover() { return []; } };
    const live = { async reconcile() {}, async verifyBalances() {}, async trade(state) { delete state.positions.a; state.cash = 14_000_000; db.save(state); } };
    await new Engine(db, c, data, { live, now: () => 4_000_000 }).tick();
    assert.equal(db.read().positions.b.value, 1_000_000);
    assert.equal(db.read().paused, 'drawdown_limit');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a pause arriving during the final quote prevents a paper purchase', async () => {
  const x = setup(); try {
    const original = x.data.quote; let calls = 0;
    x.data.quote = async (...args) => { const q = await original(...args); if (++calls === 4) x.db.command('pause'); return q; };
    await x.engine.tick(); assert.equal(x.db.read().buys, 0); assert.equal(x.db.read().cash, 20_000_000);
  } finally { x.cleanup(); }
});

test('entry costs cannot put a new position immediately beyond its stop-loss', async () => {
  const x = setup(); try {
    x.setSell('4800000'); await x.engine.tick();
    assert.equal(x.db.read().buys, 0); assert.equal(x.db.read().cash, 20_000_000);
  } finally { x.cleanup(); }
});

test('screening rate limits are visible as degraded health, not a healthy empty scan', async () => {
  const x = setup(); try {
    x.data.screen = async () => { throw new Error('HTTP_429'); };
    await x.engine.tick(); assert.equal(x.db.read().lastError, 'HTTP_429');
    assert.equal(x.db.read().buys, 0);
  } finally { x.cleanup(); }
});
