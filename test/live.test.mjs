import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { config, USDC, SOL } from '../src/config.mjs';
import { assertLiveConfig, chainDeltas, validateSimulation, encode58, LiveBroker, checkFeeReserve } from '../src/live.mjs';
import { Store } from '../src/store.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('live execution requires all deliberate activation and connection settings', () => {
  for (const env of [{}, { LIVE_TRADING: '1' }, { LIVE_TRADING: '1', JUPITER_API_KEY: 'key', SOLANA_KEYPAIR_PATH: 'local' }]) {
    assert.throws(() => assertLiveConfig(env, config()));
  }
  assert.doesNotThrow(() => assertLiveConfig({ LIVE_TRADING: '1', JUPITER_API_KEY: 'key', SOLANA_KEYPAIR_PATH: 'local', SOLANA_RPC_URL: 'https://rpc.example' }, config()));
  assert.throws(() => assertLiveConfig({ LIVE_TRADING: '1', JUPITER_API_KEY: 'key', SOLANA_KEYPAIR_PATH: 'local', SOLANA_RPC_URL: 'https://rpc.example' }, config({ activeUsd: 100 })));
});

test('fee reserve is protected on buys but an affordable exit can use the remaining reserve', () => {
  assert.throws(() => checkFeeReserve('buy', 5000000, -2000000, config()), /RESERVE/);
  assert.doesNotThrow(() => checkFeeReserve('sell', 2000000, -5000, config()));
  assert.throws(() => checkFeeReserve('sell', 1000, -5000, config()), /RESERVE/);
});

test('chain accounting uses owner-specific raw deltas, not another account or quote', () => {
  const tx = { transaction: { message: { accountKeys: ['wallet', 'other'] } }, meta: {
    err: null, preBalances: [10000000, 0], postBalances: [9990000, 0],
    preTokenBalances: [{ owner: 'wallet', mint: USDC, uiTokenAmount: { amount: '10000000' } }],
    postTokenBalances: [{ owner: 'wallet', mint: USDC, uiTokenAmount: { amount: '5000000' } },
      { owner: 'wallet', mint: SOL, uiTokenAmount: { amount: '777777' } },
      { owner: 'other', mint: SOL, uiTokenAmount: { amount: '999999999' } }] } };
  const d = chainDeltas(tx, 'wallet', USDC, SOL);
  assert.equal(d.input, -5000000n); assert.equal(d.output, 777777n); assert.equal(d.sol, -10000);
  assert.throws(() => chainDeltas({ ...tx, meta: { ...tx.meta, err: { code: 1 } } }, 'wallet', USDC, SOL));
});

test('preflight rejects excessive input, insufficient output and excessive SOL debit', () => {
  const intent = { amount: '5000000', minOut: '1000' };
  const good = { input: -5000000n, output: 1000n, sol: -5000 };
  assert.doesNotThrow(() => validateSimulation(good, intent, config()));
  for (const delta of [{ ...good, input: -6000000n }, { ...good, output: 999n }, { ...good, sol: -4000000 }]) {
    assert.throws(() => validateSimulation(delta, intent, config()));
  }
});

test('base58 signatures preserve leading zero bytes', () => {
  assert.equal(encode58(Uint8Array.from([0, 0, 1])), '112');
  assert.equal(encode58(Uint8Array.from([1])), '2');
});

test('ambiguous broadcast remains pending across broker recreation and is never resubmitted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-test-')); const c = config(); const db = new Store(dir, c, 'live');
  try {
    const s = db.read(); s.pending = { signature: 'signature', intent: { side: 'buy', mint: SOL, amount: '5000000' }, createdAt: Date.now() }; db.save(s);
    let submissions = 0;
    const data = { async rpc(method) { if (method === 'getTransaction') return null; throw new Error('UNEXPECTED_RPC'); },
      async request() { submissions++; throw new Error('NETWORK_UNAVAILABLE'); } };
    const broker = new LiveBroker(db, c, data, Keypair.generate());
    await broker.reconcile(db.read());
    assert.ok(db.read().pending);
    await assert.rejects(broker.trade(db.read(), { side: 'buy', mint: SOL, amount: '5000000' }), /PENDING/);
    assert.equal(submissions, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
