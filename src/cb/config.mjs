const defaults = Object.freeze({quote:'USDC', activeUsd:20, positionUsd:5, maxPositions:2,
  maxDailyLossUsd:2, maxDrawdownUsd:5, maxOrdersPerDay:200, pollSeconds:15,
  maxCandidates:20, minVolumeUsd:1000000, maxSpreadBps:30, slippageBps:30,
  paperAdverseBps:10, maxRoundTripCostPct:3, stopLossPct:3.5, takeProfitPct:6,
  trailingStopPct:1.5, maxHoldMinutes:15, cooldownMinutes:5,
  minMomentumPct:0.6, maxMomentumPct:8, minPullbackPct:0.1, maxPullbackPct:0.8,
  maxBookAgeSeconds:10, maxPendingSeconds:120});
export function settings(overrides = {}) {
  if (!overrides || Array.isArray(overrides) || typeof overrides !== 'object') throw new Error('INVALID_CONFIG');
  for (const k of Object.keys(overrides)) if (!(k in defaults)) throw new Error('UNKNOWN_CONFIG');
  const c = {...defaults, ...overrides};
  if (c.quote !== 'USDC') throw new Error('USDC_SPOT_ONLY');
  for (const [k,v] of Object.entries(c)) if(k !== 'quote' && (!Number.isFinite(v) || v <= 0)) throw new Error('INVALID_CONFIG');
  if(c.activeUsd>20 || c.positionUsd>5 || c.positionUsd>c.activeUsd || c.maxPositions>2 ||
    c.maxDailyLossUsd>2 || c.maxDrawdownUsd>5 || c.maxDailyLossUsd>c.activeUsd || c.maxDrawdownUsd>c.activeUsd ||
    c.maxOrdersPerDay>200 || c.pollSeconds<10 || c.maxCandidates>30 || c.slippageBps>100 ||
    c.maxSpreadBps>100 || c.maxRoundTripCostPct>=c.stopLossPct || c.stopLossPct>=100 ||
    c.trailingStopPct>=100 || c.minMomentumPct>=c.maxMomentumPct || c.minPullbackPct>=c.maxPullbackPct ||
    c.maxBookAgeSeconds>30 || !Number.isInteger(c.maxPositions) || !Number.isInteger(c.maxOrdersPerDay) || !Number.isInteger(c.maxCandidates)) throw new Error('CONFIG_EXCEEDS_TRIAL_LIMITS');
  return Object.freeze(c);
}
