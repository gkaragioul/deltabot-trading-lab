import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { USDC, TOKEN_PROGRAM, ATA_PROGRAM, usd } from './config.mjs';
import { normalizeQuote, safeError } from './providers.mjs';
import { risk } from './strategy.mjs';

export function assertLiveConfig(env, c) {
  if (env.LIVE_TRADING !== '1' || (!env.JUPITER_API_KEY && env.JUPITER_KEYLESS !== '1') || !env.SOLANA_KEYPAIR_PATH || !env.SOLANA_RPC_URL) {
    throw new Error('LIVE_REQUIRES_ACTIVATION_JUPITER_RPC_AND_DEDICATED_KEYPAIR');
  }
  if (c.activeUsd > 20) throw new Error('LIVE_TRIAL_LIMIT_IS_20_USD');
  const rpc = new URL(env.SOLANA_RPC_URL);
  if (rpc.protocol !== 'https:') throw new Error('LIVE_RPC_REQUIRES_HTTPS');
}

export function encode58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`); let out = '';
  while (n > 0n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

export function chainDeltas(tx, wallet, inputMint, outputMint) {
  if (!tx?.meta || tx.meta.err) throw new Error('CHAIN_TRANSACTION_FAILED');
  const keys = tx.transaction.message.accountKeys.map(x => typeof x === 'string' ? x : x.pubkey);
  const index = keys.indexOf(wallet);
  if (index < 0) throw new Error('WALLET_NOT_IN_TRANSACTION');
  const sum = (rows, mint) => (rows ?? []).filter(r => r.owner === wallet && r.mint === mint)
    .reduce((n, r) => n + BigInt(r.uiTokenAmount.amount), 0n);
  return { input: sum(tx.meta.postTokenBalances, inputMint) - sum(tx.meta.preTokenBalances, inputMint),
    output: sum(tx.meta.postTokenBalances, outputMint) - sum(tx.meta.preTokenBalances, outputMint),
    sol: tx.meta.postBalances[index] - tx.meta.preBalances[index] };
}

export function validateSimulation(delta, intent, c) {
  if (delta.input !== -BigInt(intent.amount) || delta.output < BigInt(intent.minOut) ||
      !Number.isSafeInteger(delta.sol) || delta.sol < -Math.floor(c.maxSolDebit * 1e9)) throw new Error('PREFLIGHT_BALANCE_LIMIT');
}

export function checkFeeReserve(side, beforeSol, deltaSol, c) {
  const afterSol = beforeSol + deltaSol;
  if (!Number.isSafeInteger(afterSol) || afterSol < 0 || (side === 'buy' && afterSol < Math.ceil(c.minSolBalance * 1e9))) throw new Error('SOL_FEE_RESERVE_TOO_LOW');
}

function ata(owner, mint) {
  return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(TOKEN_PROGRAM).toBuffer(),
    new PublicKey(mint).toBuffer()], new PublicKey(ATA_PROGRAM))[0].toBase58();
}

function rawToken(account, wallet) {
  if (!account) return null;
  if (account.owner !== TOKEN_PROGRAM) throw new Error('UNEXPECTED_TOKEN_ACCOUNT_OWNER');
  const raw = Buffer.from(account.data[0], 'base64');
  if (raw.length !== 165 || new PublicKey(raw.subarray(32, 64)).toBase58() !== wallet ||
      raw.readUInt32LE(72) !== 0 || raw.readUInt32LE(129) !== 0 || raw[108] !== 1) throw new Error('UNEXPECTED_TOKEN_ACCOUNT_CONTROL');
  return { mint: new PublicKey(raw.subarray(0, 32)).toBase58(), amount: raw.readBigUInt64LE(64) };
}

export class LiveBroker {
  constructor(store, c, data, signer) {
    this.store = store; this.c = c; this.data = data; this.signer = signer;
    this.address = signer.publicKey.toBase58();
  }
  static fromEnvironment(store, c, data, env = process.env) {
    assertLiveConfig(env, c);
    const bytes = JSON.parse(readFileSync(env.SOLANA_KEYPAIR_PATH, 'utf8'));
    if (!Array.isArray(bytes) || bytes.length !== 64 || bytes.some(x => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error('INVALID_KEYPAIR_FILE');
    return new LiveBroker(store, c, data, Keypair.fromSecretKey(Uint8Array.from(bytes)));
  }
  async snapshot(minContextSlot) {
    const context = { commitment: 'finalized', ...(minContextSlot ? { minContextSlot } : {}) };
    const balance = await this.data.rpc('getBalance', [this.address, context]);
    const tokens = await this.data.rpc('getTokenAccountsByOwner', [this.address, { programId: TOKEN_PROGRAM }, { encoding: 'base64', ...context }]);
    if (!Number.isSafeInteger(balance?.value) || !Array.isArray(tokens?.value)) throw new Error('INVALID_WALLET_RESPONSE');
    const accounts = tokens.value.map(x => ({ address: x.pubkey, ...rawToken(x.account, this.address), raw: x.account }));
    const total = mint => accounts.filter(a => a.mint === mint).reduce((n, a) => n + a.amount, 0n);
    const usdc = total(USDC);
    if (usdc > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WALLET_BALANCE_OVERFLOW');
    return { sol: balance.value, usdc: usdc.toString(), accounts };
  }
  async initialize() {
    const s = this.store.read();
    if (s.wallet) {
      if (s.wallet.address !== this.address) throw new Error('RUNTIME_WALLET_MISMATCH');
      await this.reconcile(s);
      if (!this.store.read().pending) await this.verifyBalances(this.store.read());
      return;
    }
    const snapshot = await this.snapshot(); const solPrice = await this.data.solPrice();
    const other = await this.data.rpc('getTokenAccountsByOwner', [this.address,
      { programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }, { encoding: 'jsonParsed', commitment: 'finalized' }]);
    if (!Array.isArray(other?.value) || other.value.some(x => x.account?.data?.parsed?.info?.tokenAmount?.amount !== '0') ||
      snapshot.accounts.some(a => a.mint !== USDC && a.amount > 0n)) throw new Error('USE_A_DEDICATED_WALLET_WITH_ONLY_USDC_AND_SOL');
    const usdcAccount = snapshot.accounts.filter(a => a.mint === USDC && a.amount > 0n);
    if (usdcAccount.length !== 1 || usdcAccount[0].address !== ata(this.address, USDC)) throw new Error('CANONICAL_USDC_ACCOUNT_REQUIRED');
    const equity = Number(snapshot.usdc) + usd(snapshot.sol / 1e9 * solPrice);
    if (equity > usd(this.c.activeUsd) || Number(snapshot.usdc) < usd(this.c.positionUsd) || snapshot.sol < this.c.minSolBalance * 1e9) throw new Error('WALLET_OUTSIDE_TRIAL_FUNDING_LIMITS');
    s.wallet = { address: this.address, sol: snapshot.sol, usdc: snapshot.usdc, solPrice };
    s.cash = equity; s.initialEquity = equity; s.peak = equity;
    this.store.save(s, [{ type: 'live_initialized', at: Date.now(), wallet: this.address, equity }]);
  }
  async verifyBalances(s) {
    if (s.pending) return;
    const b = await this.snapshot();
    const actual = {};
    for (const a of b.accounts.filter(a => a.mint !== USDC && a.amount > 0n)) actual[a.mint] = (BigInt(actual[a.mint] ?? '0') + a.amount).toString();
    const expected = Object.fromEntries(Object.values(s.positions).map(p => [p.mint, p.amount]));
    const all = new Set([...Object.keys(actual), ...Object.keys(expected)]);
    if (!s.wallet || b.sol !== s.wallet.sol || b.usdc !== s.wallet.usdc || [...all].some(m => actual[m] !== expected[m])) {
      s.paused = 'wallet_balance_mismatch'; this.store.save(s, [{ type: 'balance_mismatch', at: Date.now() }]);
      throw new Error('WALLET_BALANCE_MISMATCH');
    }
    const solPrice = await this.data.solPrice(); s.wallet.solPrice = solPrice;
    s.cash = Number(b.usdc) + usd(b.sol / 1e9 * solPrice); this.store.save(s);
  }
  async simulate(transaction, intent, snapshot) {
    const inputAddress = ata(this.address, intent.inputMint); const outputAddress = ata(this.address, intent.outputMint);
    const addresses = [...new Set([this.address, inputAddress, outputAddress, ...snapshot.accounts.map(a => a.address)])];
    if (addresses.length > 20) throw new Error('TOO_MANY_WALLET_ACCOUNTS');
    const simulation = await this.data.rpc('simulateTransaction', [transaction, { encoding: 'base64',
      sigVerify: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses } }]);
    if (simulation?.value?.err || !Array.isArray(simulation?.value?.accounts) || simulation.value.accounts.length !== addresses.length) throw new Error('SIMULATION_FAILED');
    const post = simulation.value.accounts;
    if (post[0]?.owner !== '11111111111111111111111111111111' || post[0]?.data?.[0] !== '') throw new Error('WALLET_ACCOUNT_CHANGED');
    const after = new Map();
    for (let i = 1; i < addresses.length; i++) after.set(addresses[i], rawToken(post[i], this.address));
    const beforeAmount = mint => snapshot.accounts.filter(a => a.mint === mint).reduce((n, a) => n + a.amount, 0n);
    const afterAmount = mint => [...after.values()].filter(a => a?.mint === mint).reduce((n, a) => n + a.amount, 0n);
    const delta = { input: afterAmount(intent.inputMint) - beforeAmount(intent.inputMint),
      output: afterAmount(intent.outputMint) - beforeAmount(intent.outputMint), sol: post[0].lamports - snapshot.sol };
    validateSimulation(delta, intent, this.c);
    checkFeeReserve(intent.side, snapshot.sol, delta.sol, this.c);
    for (const a of snapshot.accounts) {
      if (a.mint !== intent.inputMint && a.mint !== intent.outputMint && after.get(a.address)?.amount !== a.amount) throw new Error('UNRELATED_BALANCE_CHANGE');
    }
    return delta;
  }
  async trade(s, request) {
    if (s.pending || this.store.read().pending) throw new Error('PENDING_TRANSACTION');
    if (!s.wallet || s.wallet.address !== this.address) throw new Error('WALLET_NOT_INITIALIZED');
    if (request.side !== 'buy' && request.side !== 'sell') throw new Error('INVALID_SIDE');
    const side = request.side;
    if (side === 'buy' && (risk(s, this.c).halt || Object.keys(s.positions).length >= this.c.maxPositions || s.positions[request.mint] ||
        BigInt(request.amount) !== BigInt(usd(this.c.positionUsd)) || s.cooldown[request.mint] > Date.now())) throw new Error('LIVE_RISK_LIMIT');
    if (side === 'sell' && s.positions[request.mint]?.amount !== request.amount) throw new Error('LIVE_POSITION_MISMATCH');
    await this.verifyBalances(s); s = this.store.read();
    if (side === 'buy' && risk(s, this.c).halt) throw new Error('LIVE_RISK_LIMIT');
    const snapshot = await this.snapshot();
    if (side === 'buy' && snapshot.sol < this.c.minSolBalance * 1e9) throw new Error('SOL_FEE_RESERVE_TOO_LOW');
    const inputMint = side === 'buy' ? USDC : request.mint;
    const outputMint = side === 'buy' ? request.mint : USDC;
    const raw = await this.data.order(inputMint, outputMint, request.amount, this.address);
    const quote = normalizeQuote(raw, inputMint, outputMint, request.amount, this.c, 'jupiter', Date.now());
    if (!raw.transaction || !raw.requestId) throw new Error('UNSIGNED_ORDER_UNAVAILABLE');
    const transaction = VersionedTransaction.deserialize(Buffer.from(raw.transaction, 'base64'));
    if (transaction.message.staticAccountKeys[0]?.toBase58() !== this.address || transaction.message.header.numRequiredSignatures !== 1) throw new Error('UNSUPPORTED_TRANSACTION_SIGNERS');
    const intent = { ...request, inputMint, outputMint, minOut: quote.minOut };
    let reverse;
    if (side === 'buy') {
      reverse = await this.data.quote(outputMint, inputMint, quote.minOut);
      if (Date.now() - reverse.at > this.c.maxQuoteAgeSeconds * 1000 ||
          Number(reverse.minOut) < Number(request.amount) * (1 - this.c.maxRoundTripLossPct / 100)) throw new Error('ROUND_TRIP_COST_TOO_HIGH');
    }
    const simulated = await this.simulate(raw.transaction, intent, snapshot);
    if (side === 'buy') {
      const cost = Number(request.amount) + usd(-simulated.sol / 1e9 * s.wallet.solPrice);
      const net = Number(reverse.minOut) - usd(this.c.paperSellOverheadUsd);
      if (Date.now() - reverse.at > this.c.maxQuoteAgeSeconds * 1000 ||
          net <= cost * (1 - Math.min(this.c.maxRoundTripLossPct, this.c.stopLossPct) / 100)) throw new Error('ROUND_TRIP_COST_TOO_HIGH');
    }
    if (Date.now() - quote.at > this.c.maxQuoteAgeSeconds * 1000) throw new Error('STALE_QUOTE');
    if (side === 'buy' && this.store.getCommand()) throw new Error('OPERATOR_PAUSED');
    transaction.sign([this.signer]);
    const signature = encode58(transaction.signatures[0]);
    s.pending = { signature, intent, createdAt: Date.now(), solPrice: s.wallet.solPrice };
    // This commit occurs BEFORE the sole broadcast attempt. A crash cannot create a replacement order.
    this.store.save(s, [{ type: 'transaction_prepared', at: Date.now(), signature, side, mint: request.mint }]);
    try {
      await this.data.request('https://api.jup.ag/swap/v2/execute', { method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.data.apiKey ? { 'x-api-key': this.data.apiKey } : {}) },
        body: JSON.stringify({ signedTransaction: Buffer.from(transaction.serialize()).toString('base64'), requestId: raw.requestId }) });
    } catch (e) {
      this.store.save(s, [{ type: 'submission_uncertain', at: Date.now(), signature, error: safeError(e) }]);
    }
    await this.reconcile(s);
  }
  async reconcile(s) {
    if (!s.pending) return;
    const p = s.pending;
    const tx = await this.data.rpc('getTransaction', [p.signature, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
    if (!tx) return; // Unknown/expired is not proof of failure. Keep the entry lock for manual investigation.
    const failed = Boolean(tx.meta?.err);
    const d = chainDeltas(failed ? { ...tx, meta: { ...tx.meta, err: null } } : tx, this.address, p.intent.inputMint, p.intent.outputMint);
    try {
      if (failed) {
        if (d.input !== 0n || d.output !== 0n || d.sol > 0 || d.sol < -this.c.maxSolDebit * 1e9) throw new Error('UNEXPECTED_FAILURE_DELTA');
      } else validateSimulation(d, p.intent, this.c);
    }
    catch { s.paused = 'unexpected_chain_delta'; this.store.save(s); return; }
    const costOfSol = usd(-d.sol / 1e9 * p.solPrice);
    const b = await this.snapshot(tx.slot);
    const expectedUsdc = BigInt(s.wallet.usdc) + (p.intent.inputMint === USDC ? d.input : d.output);
    const expectedTokens = Object.fromEntries(Object.values(s.positions).map(x => [x.mint, BigInt(x.amount)]));
    expectedTokens[p.intent.mint] = (expectedTokens[p.intent.mint] ?? 0n) + (p.intent.side === 'buy' ? d.output : d.input);
    const actualTokens = {};
    for (const a of b.accounts.filter(x => x.mint !== USDC)) actualTokens[a.mint] = (actualTokens[a.mint] ?? 0n) + a.amount;
    const mints = new Set([...Object.keys(expectedTokens), ...Object.keys(actualTokens)]);
    if (b.sol !== s.wallet.sol + d.sol || BigInt(b.usdc) !== expectedUsdc ||
        [...mints].some(m => (expectedTokens[m] ?? 0n) !== (actualTokens[m] ?? 0n))) {
      s.paused = 'wallet_balance_mismatch'; this.store.save(s, [{ type: 'settlement_balance_mismatch', at: Date.now(), signature: p.signature }]); return;
    }
    if (failed) {
      s.cash = Number(b.usdc) + usd(b.sol / 1e9 * p.solPrice);
      s.wallet = { ...s.wallet, sol: b.sol, usdc: b.usdc };
      s.realized -= costOfSol; s.paused = 'transaction_failed_review_required'; s.pending = null;
      this.store.save(s, [{ type: 'transaction_failed', at: Date.now(), signature: p.signature, feeCost: costOfSol }]); return;
    }
    if (p.intent.side === 'buy') {
      const cost = Number(-d.input) + costOfSol;
      s.positions[p.intent.mint] = { mint: p.intent.mint, symbol: p.intent.symbol, decimals: p.intent.decimals,
        amount: d.output.toString(), cost, value: null, peakValue: 0,
        openedAt: Number.isFinite(tx.blockTime) && tx.blockTime > 0 ? Math.min(Date.now(), tx.blockTime * 1000) : p.createdAt,
        valuedAt: null };
      s.buys++;
    } else {
      const position = s.positions[p.intent.mint];
      if (!position) { s.paused = 'missing_position_for_settlement'; this.store.save(s); return; }
      const proceeds = Number(d.output) - costOfSol;
      s.realized += proceeds - position.cost; s.sells++;
      delete s.positions[p.intent.mint]; s.cooldown[p.intent.mint] = Date.now() + this.c.cooldownMinutes * 60000;
    }
    s.cash = Number(b.usdc) + usd(b.sol / 1e9 * p.solPrice);
    s.wallet = { ...s.wallet, sol: b.sol, usdc: b.usdc }; s.pending = null;
    this.store.save(s, [{ type: p.intent.side, at: Date.now(), mode: 'live', signature: p.signature, mint: p.intent.mint,
      input: (-d.input).toString(), output: d.output.toString(), solLamports: d.sol, reason: p.intent.reason ?? 'momentum_pullback' }]);
  }
}
