import { createHash } from 'node:crypto';

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL = 'So11111111111111111111111111111111111111112';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const usd = n => Math.round(n * 1_000_000);
export const dollars = n => n / 1_000_000;
export const defaults = Object.freeze({
  totalUsd: 100, activeUsd: 20, positionUsd: 5, maxPositions: 2,
  maxDrawdownUsd: 10, slippageBps: 100, maxRoundTripLossPct: 12,
  paperAdverseBps: 50, paperBuyOverheadUsd: 0.35, paperSellOverheadUsd: 0.02,
  minLiquidityUsd: 50000, minVolume5mUsd: 5000, minAgeMinutes: 30,
  minBuySellRatio: 1.5, minChange5mPct: 2, maxChange5mPct: 30,
  minPullbackPct: 1, maxPullbackPct: 8, minObservationSeconds: 120,
  stopLossPct: 10, takeProfitPct: 25, trailingStopPct: 12,
  maxHoldMinutes: 60, cooldownMinutes: 60, maxLargestAccountPct: 35,
  maxQuoteAgeSeconds: 15, fillDelaySeconds: 3, pollSeconds: 60,
  maxCandidates: 20, maxSolDebit: 0.003, minSolBalance: 0.005,
  watchMints: [],
});

export function config(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Invalid configuration');
  for (const key of Object.keys(overrides)) if (!(key in defaults)) throw new Error(`Unknown configuration: ${key}`);
  const c = { ...defaults, ...overrides };
  for (const [key, value] of Object.entries(c)) {
    if (key === 'watchMints') {
      if (!Array.isArray(value) || value.length > 30 || value.some(x => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x))) throw new Error('Invalid watchMints');
    } else if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid configuration: ${key}`);
  }
  if (c.totalUsd > 100 || c.activeUsd > 20 || c.activeUsd > c.totalUsd || c.positionUsd > 5 ||
      c.positionUsd + c.paperBuyOverheadUsd > c.activeUsd || c.maxPositions > 2 ||
      !Number.isInteger(c.maxPositions) || c.maxDrawdownUsd > 10 || c.maxDrawdownUsd > c.activeUsd ||
      c.slippageBps > 300 || !Number.isInteger(c.slippageBps) || c.paperAdverseBps > 1000 ||
      c.maxRoundTripLossPct > 20 || c.maxLargestAccountPct > 100 || c.pollSeconds < 10 ||
      c.maxQuoteAgeSeconds > 60 || c.maxCandidates > 30 || !Number.isInteger(c.maxCandidates) ||
      c.maxSolDebit > 0.003 || c.minChange5mPct >= c.maxChange5mPct ||
      c.minPullbackPct >= c.maxPullbackPct || c.stopLossPct >= 100 || c.trailingStopPct >= 100) {
    throw new Error('Configuration exceeds experiment limits');
  }
  return Object.freeze(c);
}

export function configHash(c) {
  return createHash('sha256').update(JSON.stringify(Object.keys(c).sort().map(k => [k, c[k]]))).digest('hex');
}
