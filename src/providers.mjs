import { PublicKey } from '@solana/web3.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { USDC, SOL, TOKEN_PROGRAM } from './config.mjs';

export function safeError(e) {
  // Never persist remote bodies, headers, signed payloads or credential-bearing URLs.
  const message = String(e?.message ?? 'UNKNOWN_ERROR');
  return /^[A-Z0-9_ :.-]{1,120}$/.test(message) ? message : 'PROVIDER_OR_EXECUTION_ERROR';
}

export function normalizeQuote(raw, inputMint, outputMint, amount, c, source, at) {
  const suppliedAmount = raw.inAmount ?? raw.inputAmount;
  const out = raw.outAmount ?? raw.outputAmount;
  const valid = n => typeof n === 'string' && /^[0-9]+$/.test(n) && BigInt(n) > 0n;
  if (raw.inputMint !== inputMint || raw.outputMint !== outputMint || suppliedAmount !== amount || !valid(out)) throw new Error('INVALID_QUOTE');
  const floor = BigInt(out) * BigInt(10000 - c.slippageBps) / 10000n;
  const minOut = raw.otherAmountThreshold ?? floor.toString();
  if (!valid(minOut) || BigInt(minOut) < floor || BigInt(minOut) > BigInt(out)) throw new Error('INVALID_QUOTE_THRESHOLD');
  return { inputMint, outputMint, amount, out, minOut, source, at };
}

export function normalizeMarkets(pairs, requested, now) {
  if (!Array.isArray(pairs)) throw new Error('INVALID_MARKET_RESPONSE');
  const byMint = new Map(); const wanted = new Set(requested);
  const num = value => value === null || value === undefined || value === '' ? NaN : Number(value);
  for (const p of pairs) {
    const mint = p?.baseToken?.address;
    if (p?.chainId !== 'solana' || !wanted.has(mint)) continue;
    const m = { mint, symbol: String(p.baseToken.symbol ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24),
      pair: p.pairAddress, price: num(p.priceUsd), liquidity: num(p.liquidity?.usd),
      volume5m: num(p.volume?.m5), buys: num(p.txns?.m5?.buys), sells: num(p.txns?.m5?.sells),
      change5m: num(p.priceChange?.m5), createdAt: num(p.pairCreatedAt), at: now };
    if (!byMint.has(mint) || m.liquidity > byMint.get(mint).liquidity) byMint.set(mint, m);
  }
  return [...byMint.values()];
}

export function tokenCheck(account, largest, c) {
  const reject = reason => ({ ok: false, reason });
  if (account?.owner !== TOKEN_PROGRAM) return reject('unsupported_token_program');
  const p = account?.data?.parsed;
  const info = p?.info;
  if (p?.type !== 'mint' || !info?.isInitialized || !Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 18 ||
      typeof info.supply !== 'string' || !/^[0-9]+$/.test(info.supply) || BigInt(info.supply) <= 0n) return reject('invalid_mint');
  if (info.mintAuthority !== null || info.freezeAuthority !== null) return reject('token_authority_enabled');
  if (!Array.isArray(largest) || !largest.length || largest.some(x => typeof x.amount !== 'string' || !/^[0-9]+$/.test(x.amount))) return reject('holder_data_unavailable');
  const max = largest.reduce((a, x) => BigInt(x.amount) > a ? BigInt(x.amount) : a, 0n);
  const shareBps = Number(max * 10000n / BigInt(info.supply));
  if (shareBps > c.maxLargestAccountPct * 100) return reject('largest_account_concentration');
  return { ok: true, decimals: info.decimals, largestAccountPct: shareBps / 100 };
}

export class Providers {
  constructor(c, { fetchFn = fetch, apiKey = process.env.JUPITER_API_KEY,
    keyless = process.env.JUPITER_KEYLESS === '1', sleepFn = sleep,
    rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com', now = Date.now } = {}) {
    this.c = c; this.fetch = fetchFn; this.apiKey = apiKey; this.rpcUrl = rpcUrl; this.now = now;
    this.source = apiKey || keyless ? 'jupiter' : 'raydium';
    this.sleep = sleepFn; this.orderQueue = Promise.resolve(); this.nextOrderAt = 0;
  }
  async request(url, options = {}) {
    let response;
    try { response = await this.fetch(url, { ...options, signal: AbortSignal.timeout(12000), redirect: 'error' }); }
    catch { throw new Error('NETWORK_UNAVAILABLE'); }
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const body = await response.text();
    if (body.length > 4_000_000) throw new Error('RESPONSE_TOO_LARGE');
    try { return JSON.parse(body); } catch { throw new Error('INVALID_JSON'); }
  }
  async rpc(method, params) {
    const body = await this.request(this.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (body.error || !('result' in body)) throw new Error('RPC_ERROR');
    return body.result;
  }
  async discover(extraMints = []) {
    const profile = await this.request('https://api.dexscreener.com/token-profiles/latest/v1');
    if (!Array.isArray(profile)) throw new Error('INVALID_DISCOVERY_RESPONSE');
    const mints = [...new Set([...extraMints, ...this.c.watchMints,
      ...profile.filter(p => p.chainId === 'solana').map(p => p.tokenAddress)])]
      .filter(m => m !== SOL && m !== USDC && typeof m === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m))
      .slice(0, this.c.maxCandidates);
    if (!mints.length) return [];
    const pairs = await this.request(`https://api.dexscreener.com/tokens/v1/solana/${mints.join(',')}`);
    return normalizeMarkets(pairs, mints, this.now());
  }
  async quote(inputMint, outputMint, amount) {
    if (!/^[1-9][0-9]*$/.test(amount)) throw new Error('INVALID_AMOUNT');
    if (this.source === 'jupiter') {
      const raw = await this.order(inputMint, outputMint, amount);
      return normalizeQuote(raw, inputMint, outputMint, amount, this.c, 'jupiter', this.now());
    }
    const params = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: String(this.c.slippageBps), txVersion: 'V0' });
    const body = await this.request(`https://transaction-v1.raydium.io/compute/swap-base-in?${params}`);
    if (body.success !== true || !body.data) throw new Error('NO_ROUTE');
    return normalizeQuote(body.data, inputMint, outputMint, amount, this.c, 'raydium', this.now());
  }
  async order(inputMint, outputMint, amount, taker) {
    if (this.source !== 'jupiter') throw new Error('JUPITER_CONNECTION_REQUIRED');
    const params = new URLSearchParams({ inputMint, outputMint, amount, slippageBps: String(this.c.slippageBps) });
    if (taker) params.set('taker', taker);
    // Serialize starts below the keyless 30 requests/60-second sliding window.
    // Failed requests consume a slot too; no retry or silent provider fallback.
    const pending = this.orderQueue.then(async () => {
      const wait = Math.max(0, this.nextOrderAt - this.now());
      if (wait) await this.sleep(wait);
      this.nextOrderAt = this.now() + (this.apiKey ? 1100 : 2100);
      return this.request(`https://api.jup.ag/swap/v2/order?${params}`, {
        headers: this.apiKey ? { 'x-api-key': this.apiKey } : {} });
    });
    this.orderQueue = pending.then(() => {}, () => {});
    const raw = await pending;
    if (raw.errorCode || !raw.outAmount) throw new Error('NO_ROUTE');
    return raw;
  }
  async screen(mint) {
    new PublicKey(mint);
    const account = await this.rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const largest = await this.rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
    return tokenCheck(account?.value, largest?.value, this.c);
  }
  async solPrice() {
    const pairs = await this.request(`https://api.dexscreener.com/tokens/v1/solana/${SOL}`);
    const markets = normalizeMarkets(pairs, [SOL], this.now()).filter(m => m.liquidity >= 1_000_000 && m.price > 0);
    if (!markets.length) throw new Error('SOL_PRICE_UNAVAILABLE');
    return markets[0].price;
  }
}
