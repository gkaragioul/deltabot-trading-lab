import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, workerRunning, report } from '../src/operations.mjs';
import { config } from '../src/config.mjs';
import { initialState } from '../src/store.mjs';

test('only one worker can own a runtime and stopping releases ownership', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-test-'));
  try {
    const lock = await acquireLock(dir);
    assert.equal(await workerRunning(dir), true);
    await assert.rejects(acquireLock(dir), /WORKER_ALREADY_RUNNING/);
    await new Promise(resolve => lock.close(resolve));
    assert.equal(await workerRunning(dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stale position prices are labelled and excluded from conservative reported value', () => {
  const c = config(); const s = initialState(c); s.cash = 15_000_000;
  s.positions.a = { symbol: 'OLD', amount: '5', cost: 5_000_000, value: 9_000_000, valuedAt: 1 };
  const text = report(s, c, [], false, 1_000_000);
  assert.match(text, /Stale/); assert.match(text, /\$95\.00/);
  assert.doesNotMatch(text, /\$104\.00/);
});

test('report identifies simulated money and distinguishes quote failure from actual realized loss', () => {
  const c = config(); const s = initialState(c); s.cash = 14_650_000;
  s.positions.a = { symbol: 'COIN', mint: 'a', amount: '50', cost: 5_350_000, value: null };
  const text = report(s, c, [], false);
  assert.match(text, /SIMULATED/); assert.match(text, /\$94\.65/);
  assert.match(text, /\$0\.00/); assert.match(text, /unavailable/i);
  assert.match(text, /stopped/i);
});
