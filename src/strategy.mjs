import { usd } from './config.mjs';

export function observe(s, m) {
  const history = (s.history[m.mint] ?? []).filter(x => x.at > m.at - 30 * 60_000 && x.at !== m.at);
  if (Number.isFinite(m.price) && m.price > 0) history.push({ at: m.at, price: m.price });
  s.history[m.mint] = history.slice(-60);
  for (const [mint, rows] of Object.entries(s.history)) if (!rows.length || rows.at(-1).at < m.at - 3_600_000) delete s.history[mint];
}

export function assess(m, h, c) {
  const reject = reason => ({ eligible: false, reason });
  for (const key of ['price', 'liquidity', 'volume5m', 'buys', 'sells', 'change5m', 'createdAt', 'at']) {
    if (!Number.isFinite(m[key])) return reject('incomplete_market_data');
  }
  if (m.price <= 0 || m.createdAt > m.at || m.buys < 0 || m.sells < 0) return reject('invalid_market_data');
  if (m.at - m.createdAt < c.minAgeMinutes * 60_000) return reject('too_new');
  if (m.liquidity < c.minLiquidityUsd) return reject('low_liquidity');
  if (m.volume5m < c.minVolume5mUsd) return reject('low_volume');
  if (m.buys / Math.max(1, m.sells) < c.minBuySellRatio) return reject('weak_buy_pressure');
  if (m.change5m < c.minChange5mPct || m.change5m > c.maxChange5mPct) return reject('momentum_outside_range');
  if (h.length < 3 || m.at - h[0].at < c.minObservationSeconds * 1000) return reject('collecting_history');
  const peak = Math.max(...h.map(x => x.price));
  const pullback = (1 - m.price / peak) * 100;
  if (m.price <= h[0].price || pullback < c.minPullbackPct || pullback > c.maxPullbackPct) return reject('waiting_for_pullback');
  return { eligible: true, reason: 'momentum_pullback', pullback };
}

export function risk(s, c) {
  const positions = Object.values(s.positions);
  const equity = s.cash + positions.reduce((sum, p) => sum + (p.value ?? 0), 0);
  const drawdown = Math.max(0, Math.max(s.initialEquity ?? usd(c.activeUsd), s.peak) - equity);
  const uncertain = positions.some(p => p.value === null || p.value === undefined);
  return { equity, drawdown, halt: drawdown >= usd(c.maxDrawdownUsd) || uncertain || Boolean(s.paused) || Boolean(s.pending),
    reason: s.paused ?? (s.pending ? 'pending_transaction' : uncertain ? 'exit_quote_unavailable' : drawdown >= usd(c.maxDrawdownUsd) ? 'drawdown_limit' : null) };
}

export function exitReason(p, value, now, c) {
  if (value <= p.cost * (1 - c.stopLossPct / 100)) return 'stop_loss';
  if (value >= p.cost * (1 + c.takeProfitPct / 100)) return 'take_profit';
  if (p.peakValue > p.cost && value <= p.peakValue * (1 - c.trailingStopPct / 100)) return 'trailing_stop';
  if (now - p.openedAt >= c.maxHoldMinutes * 60_000) return 'time_exit';
  return null;
}
