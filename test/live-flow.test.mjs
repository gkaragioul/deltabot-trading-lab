import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import { config, USDC, TOKEN_PROGRAM, ATA_PROGRAM } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { LiveBroker } from '../src/live.mjs';
import { exitReason } from '../src/strategy.mjs';

function fixture({ uncertain = false, failed = false, externalDeposit = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'live-flow-')); const c = config();
  const db = new Store(dir, c, 'live'); const signer = Keypair.fromSeed(new Uint8Array(32).fill(1));
  const wallet = signer.publicKey.toBase58(); const mint = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
  const address = mint => PublicKey.findProgramAddressSync([signer.publicKey.toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey(ATA_PROGRAM))[0].toBase58();
  const token = (mint, amount) => {
    const raw = Buffer.alloc(165); new PublicKey(mint).toBuffer().copy(raw, 0); signer.publicKey.toBuffer().copy(raw, 32);
    raw.writeBigUInt64LE(BigInt(amount), 64); raw[108] = 1;
    return { owner: TOKEN_PROGRAM, data: [raw.toString('base64'), 'base64'], lamports: 2039280, executable: false, rentEpoch: 0 };
  };
  let sent = false; let sends = 0;
  const beforeSol = 20_000_000; const afterSol = 19_990_000;
  const afterUsdc = failed ? '18000000' : externalDeposit ? '23000000' : '13000000';
  const accounts = after => [{ pubkey: address(USDC), account: token(USDC, after ? afterUsdc : '18000000') },
    ...(after && !failed ? [{ pubkey: address(mint), account: token(mint, '4980000') }] : [])];
  const message = new TransactionMessage({ payerKey: signer.publicKey,
    recentBlockhash: Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(mint), lamports: 1 })] }).compileToV0Message();
  const unsigned = Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
  const oldTime = Math.floor(Date.now() / 1000) - 7200;
  const tx = { blockTime: oldTime, transaction: { message: { accountKeys: [wallet] } }, meta: {
    err: failed ? { InstructionError: [0, 'Custom'] } : null, preBalances: [beforeSol], postBalances: [afterSol],
    preTokenBalances: [{ owner: wallet, mint: USDC, uiTokenAmount: { amount: '18000000' } }],
    postTokenBalances: [{ owner: wallet, mint: USDC, uiTokenAmount: { amount: failed ? '18000000' : '13000000' } },
      ...(!failed ? [{ owner: wallet, mint, uiTokenAmount: { amount: '4980000' } }] : [])] } };
  const s = db.read(); s.wallet = { address: wallet, sol: beforeSol, usdc: '18000000', solPrice: 100 }; db.save(s);
  const data = { apiKey: 'test-key-never-sent',
    async solPrice() { return 100; },
    async quote(inputMint, outputMint, amount) { return { inputMint, outputMint, amount, minOut: '4950000', at: Date.now() }; },
    async order(inputMint, outputMint, amount, taker) {
      assert.equal(taker, wallet);
      return { inputMint, outputMint, inAmount: amount, outAmount: '5000000', otherAmountThreshold: '4950000', requestId: 'request', transaction: unsigned };
    },
    async rpc(method, params) {
      if (method === 'getBalance') return { value: sent && !uncertain ? afterSol : beforeSol };
      if (method === 'getTokenAccountsByOwner') return { value: accounts(sent && !uncertain) };
      if (method === 'simulateTransaction') {
        assert.equal(params[1].sigVerify, false);
        const output = params[1].accounts.addresses.map(a => a === wallet
          ? { owner: '11111111111111111111111111111111', data: ['', 'base64'], lamports: afterSol }
          : a === address(USDC) ? token(USDC, '13000000') : token(mint, '4980000'));
        return { value: { err: null, accounts: output } };
      }
      if (method === 'getTransaction') return sent && !uncertain ? tx : null;
      throw new Error('UNEXPECTED_RPC');
    },
    async request(url, options) {
      assert.equal(url, 'https://api.jup.ag/swap/v2/execute');
      assert.ok(db.read().pending, 'transaction must be durable before submission');
      const body = JSON.parse(options.body); const signed = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, 'base64'));
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), signer.publicKey.toBuffer()]), format: 'der', type: 'spki' });
      assert.equal(verify(null, signed.message.serialize(), key, signed.signatures[0]), true);
      sends++; sent = true;
      if (uncertain) throw new Error('NETWORK_UNAVAILABLE');
      return { status: 'Success' }; // Reconciliation must still rely on chain data.
    } };
  return { db, c, mint, wallet, data, broker: new LiveBroker(db, c, data, signer), sends: () => sends, oldTime,
    cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('live flow signs, journals before sending, settles actual output and preserves execution time', async () => {
  const x = fixture(); try {
    await x.broker.trade(x.db.read(), { side: 'buy', mint: x.mint, amount: '5000000', symbol: 'TEST', decimals: 6 });
    const s = x.db.read(); assert.equal(x.sends(), 1); assert.equal(s.pending, null);
    assert.equal(s.positions[x.mint].amount, '4980000'); assert.equal(s.positions[x.mint].cost, 5001000);
    assert.equal(s.cash, 14999000); assert.equal(s.buys, 1);
    assert.equal(s.positions[x.mint].openedAt, x.oldTime * 1000);
    assert.equal(exitReason(s.positions[x.mint], 5001000, Date.now(), x.c), 'time_exit');
    await x.broker.reconcile(s); assert.equal(x.db.read().buys, 1);
  } finally { x.cleanup(); }
});

test('full ambiguous submission stays pending and cannot be sent a second time', async () => {
  const x = fixture({ uncertain: true }); try {
    await x.broker.trade(x.db.read(), { side: 'buy', mint: x.mint, amount: '5000000' });
    assert.ok(x.db.read().pending); assert.equal(x.sends(), 1);
    await assert.rejects(x.broker.trade(x.db.read(), { side: 'buy', mint: x.mint, amount: '5000000' }), /PENDING/);
    assert.equal(x.sends(), 1);
  } finally { x.cleanup(); }
});

test('failed transaction accounts the real network fee without claiming a purchase', async () => {
  const x = fixture({ failed: true }); try {
    await x.broker.trade(x.db.read(), { side: 'buy', mint: x.mint, amount: '5000000' });
    const s = x.db.read(); assert.equal(s.buys, 0); assert.equal(s.cash, 19999000);
    assert.equal(s.realized, -1000); assert.equal(s.pending, null);
    assert.equal(s.paused, 'transaction_failed_review_required');
  } finally { x.cleanup(); }
});

test('an external deposit during settlement is not silently treated as trading profit', async () => {
  const x = fixture({ externalDeposit: true }); try {
    await x.broker.trade(x.db.read(), { side: 'buy', mint: x.mint, amount: '5000000' });
    const s = x.db.read(); assert.equal(s.paused, 'wallet_balance_mismatch');
    assert.ok(s.pending); assert.equal(s.buys, 0);
  } finally { x.cleanup(); }
});

test('live purchase rechecks risk after updating cash valuation', async () => {
  const x = fixture(); try {
    const s = x.db.read(); s.peak = 29999500; x.db.save(s);
    x.data.solPrice = async () => 99;
    await assert.rejects(x.broker.trade(x.db.read(), { side: 'buy', mint: x.mint, amount: '5000000' }), /LIVE_RISK_LIMIT/);
    assert.equal(x.sends(), 0);
  } finally { x.cleanup(); }
});
