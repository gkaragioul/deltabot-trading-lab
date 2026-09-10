import test from 'node:test';
import assert from 'node:assert/strict';
import { config, USDC, SOL, TOKEN_PROGRAM } from '../src/config.mjs';
import { normalizeQuote, normalizeMarkets, tokenCheck, Providers } from '../src/providers.mjs';

test('quotes cannot silently change the requested trade or contain invalid amounts', () => {
  const q = { inputMint: USDC, outputMint: SOL, inputAmount: '5000000', outputAmount: '10000000', otherAmountThreshold: '9900000' };
  assert.equal(normalizeQuote(q, USDC, SOL, '5000000', config(), 'raydium', 1).minOut, '9900000');
  for (const change of [{ inputAmount: '6000000' }, { outputAmount: '0' },
    { outputMint: USDC }, { otherAmountThreshold: '1' }, { outputAmount: 'NaN' }]) {
    assert.throws(() => normalizeQuote({ ...q, ...change }, USDC, SOL, '5000000', config(), 'raydium', 1));
  }
});

test('market normalization selects one liquid pool per mint and rejects quote-side mismatches', () => {
  const p = { chainId: 'solana', baseToken: { address: SOL, symbol: 'SOL' }, pairAddress: 'p',
    priceUsd: '150', liquidity: { usd: 100000 }, volume: { m5: 123 },
    txns: { m5: { buys: 10, sells: 5 } }, priceChange: { m5: 4 }, pairCreatedAt: 1 };
  const rows = normalizeMarkets([p, { ...p, pairAddress: 'q', liquidity: { usd: 200000 } }, { ...p, chainId: 'ethereum' }], [SOL], 100);
  assert.equal(rows.length, 1); assert.equal(rows[0].pair, 'q');
  assert.equal(normalizeMarkets([p], [USDC], 100).length, 0);
});

test('token checks fail closed on authority, unsupported owner, incomplete or concentrated supply', () => {
  const info = { owner: TOKEN_PROGRAM, data: { parsed: { type: 'mint', info: {
    decimals: 6, supply: '1000000', mintAuthority: null, freezeAuthority: null, isInitialized: true } } } };
  assert.equal(tokenCheck(info, [{ amount: '100000' }], config()).ok, true);
  assert.equal(tokenCheck(info, [{ amount: '900000' }], config()).ok, false);
  assert.equal(tokenCheck({ ...info, owner: 'unsupported' }, [], config()).ok, false);
  const frozen = structuredClone(info); frozen.data.parsed.info.freezeAuthority = SOL;
  assert.equal(tokenCheck(frozen, [{ amount: '1000' }], config()).ok, false);
  assert.equal(tokenCheck(info, [], config()).ok, false);
});

test('provider distinguishes API failure from an empty successful result', async () => {
  const p = new Providers(config(), { fetchFn: async () => new Response('{}', { status: 429 }) });
  await assert.rejects(p.quote(USDC, SOL, '5000000'), /HTTP_429/);
  const q = new Providers(config(), { fetchFn: async () => new Response(JSON.stringify({ success: false, msg: 'no route' })) });
  await assert.rejects(q.quote(USDC, SOL, '5000000'), /NO_ROUTE/);
});
