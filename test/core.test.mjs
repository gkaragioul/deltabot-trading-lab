import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, configHash } from '../src/config.mjs';
import { Store, initialState } from '../src/store.mjs';
import { assess, exitReason, risk, observe } from '../src/strategy.mjs';

test('invalid risk settings cannot bypass the bankroll and position limits', () => {
  for (const overrides of [{ positionUsd: NaN }, { positionUsd: -1 }, { positionUsd: 21 },
    { activeUsd: 101 }, { activeUsd: 100 }, { maxDrawdownUsd: 11 }, { maxPositions: 0 }, { slippageBps: 10001 }, { madeUp: 3 }]) {
    assert.throws(() => config(overrides));
  }
  assert.equal(configHash(config()), configHash(config({ positionUsd: 5 })));
});

test('live drawdown uses the actual initial deposit, including the SOL cash reserve', () => {
  const s = initialState(config(), 'live'); s.initialEquity = 12_000_000; s.peak = 12_000_000; s.cash = 3_000_000;
  assert.equal(risk(s, config()).halt, false);
  s.cash = 2_000_000; assert.equal(risk(s, config()).halt, true);
});

test('ledger commits events and state together and survives reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memecoin-test-'));
  try {
    let db = new Store(dir, config());
    const state = db.read(); state.cash = 14_650_000;
    state.positions.mint = { amount: '9999999999999999999', cost: 5_350_000 };
    db.save(state, [{ type: 'buy', amount: '9999999999999999999' }]); db.close();
    db = new Store(dir, config());
    assert.equal(db.read().cash, 14_650_000);
    assert.equal(db.read().positions.mint.amount, '9999999999999999999');
    assert.equal(db.events(10)[0].type, 'buy'); db.close();
    assert.throws(() => new Store(dir, config({ stopLossPct: 12 })), /configuration/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('risk uses open liquidation values and stops at the drawdown boundary', () => {
  const c = config(); const s = initialState(c);
  s.cash = 10_000_000; s.positions.a = { value: 0, cost: 5_000_000 };
  s.positions.b = { value: 0, cost: 5_000_000 };
  assert.equal(risk(s, c).halt, true);
  assert.equal(risk(s, c).equity, 10_000_000);
  s.positions = {}; s.cash = 20_000_000; s.peak = 31_000_000;
  assert.equal(risk(s, c).halt, true);
});

test('missing exit valuations block entries and value the position at zero', () => {
  const s = initialState(config()); s.positions.a = { value: null, cost: 5_000_000 };
  assert.equal(risk(s, config()).halt, true);
});

const market = { mint: 'a', price: 1.05, liquidity: 100000, volume5m: 10000,
  buys: 30, sells: 10, change5m: 5, createdAt: 0, at: 4_000_000 };
test('a pullback requires real observation history and rejects bad market data', () => {
  const c = config(); const history = [{ at: 3_700_000, price: 1 },
    { at: 3_850_000, price: 1.08 }, { at: 4_000_000, price: 1.05 }];
  assert.equal(assess(market, history, c).eligible, true);
  assert.equal(assess(market, [], c).eligible, false);
  assert.equal(assess({ ...market, liquidity: NaN }, history, c).eligible, false);
  assert.equal(assess({ ...market, buys: 0, sells: 0 }, history, c).eligible, false);
  assert.equal(assess({ ...market, createdAt: 5_000_000 }, history, c).eligible, false);
});

test('observations are time-bounded and duplicate timestamps cannot manufacture history', () => {
  const s = initialState(config());
  observe(s, { ...market, at: 1 }); observe(s, { ...market, at: 1 });
  assert.equal(s.history.a.length, 1);
  observe(s, { ...market, at: 4_000_000 });
  assert.equal(s.history.a.length, 1);
});

test('exit decisions include costs, a trailing stop and maximum holding time', () => {
  const c = config(); const p = { cost: 5_350_000, peakValue: 7_000_000, openedAt: 1000 };
  assert.equal(exitReason(p, 4_000_000, 2000, c), 'stop_loss');
  assert.equal(exitReason(p, 7_000_000, 2000, c), 'take_profit');
  assert.equal(exitReason(p, 6_000_000, 2000, c), 'trailing_stop');
  assert.equal(exitReason({ ...p, peakValue: 5_350_000 }, 5_350_000, 4_000_000, c), 'time_exit');
});
