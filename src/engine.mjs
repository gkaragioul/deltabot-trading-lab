import { setTimeout as sleep } from 'node:timers/promises';
import { USDC, usd } from './config.mjs';
import { assess, exitReason, risk, observe } from './strategy.mjs';
import { safeError } from './providers.mjs';

export class Engine {
  constructor(store, c, data, options = {}) {
    this.store = store; this.c = c; this.data = data;
    this.now = options.now ?? Date.now; this.sleep = options.sleep ?? sleep; this.live = options.live ?? null;
  }
  event(type, fields = {}) { return { type, at: this.now(), ...fields }; }
  fresh(q) {
    if (!Number.isFinite(q.at) || this.now() - q.at > this.c.maxQuoteAgeSeconds * 1000 || q.at > this.now() + 1000) throw new Error('STALE_QUOTE');
  }
  paperOutput(q) {
    this.fresh(q);
    return BigInt(q.minOut) * BigInt(10000 - this.c.paperAdverseBps) / 10000n;
  }
  async value(p) {
    const q = await this.data.quote(p.mint, USDC, p.amount); this.fresh(q);
    const gross = this.live ? BigInt(q.minOut) : this.paperOutput(q);
    if (gross > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('VALUE_OVERFLOW');
    return Math.max(0, Number(gross) - usd(this.c.paperSellOverheadUsd));
  }
  async tick() {
    let s = this.store.read(); const events = [];
    s.lastError = null;
    if (s.mode === 'live' && !this.live) throw new Error('LIVE_BROKER_REQUIRED');
    if (this.live) {
      await this.live.reconcile(s);
      s = this.store.read();
      if (s.pending) { s.lastTick = this.now(); this.store.save(s); return s; }
    }
    const command = this.store.getCommand();
    for (const mint of Object.keys(s.positions)) {
      const p = s.positions[mint];
      try {
        p.value = await this.value(p); p.valuedAt = this.now(); p.peakValue = Math.max(p.peakValue, p.value);
        const reason = command === 'flatten' ? 'manual_flatten' : exitReason(p, p.value, this.now(), this.c);
        if (!reason) continue;
        if (this.live) {
          this.store.save(s, events.splice(0));
          await this.live.trade(s, { side: 'sell', mint: p.mint, amount: p.amount, reason, symbol: p.symbol });
          s = this.store.read(); if (s.pending) return s;
        } else {
          await this.sleep(this.c.fillDelaySeconds * 1000);
          const proceeds = await this.value(p);
          s.cash += proceeds; s.realized += proceeds - p.cost; s.sells++;
          delete s.positions[p.mint]; s.cooldown[p.mint] = this.now() + this.c.cooldownMinutes * 60000;
          events.push(this.event('sell', { mode: 'paper', mint: p.mint, reason, proceeds, cost: p.cost, profit: proceeds - p.cost }));
        }
      } catch (e) {
        if (this.live) { s = this.store.read(); if (s.pending) return s; }
        if (s.positions[p.mint]) s.positions[p.mint].value = null;
        events.push(this.event('exit_unavailable', { mint: p.mint, error: safeError(e) }));
      }
    }
    let check = risk(s, this.c); s.peak = Math.max(s.peak, check.equity);
    if (check.drawdown >= usd(this.c.maxDrawdownUsd)) s.paused = 'drawdown_limit';
    if (this.live) {
      this.store.save(s, events.splice(0));
      await this.live.verifyBalances(s); s = this.store.read();
    }
    let markets;
    try { markets = await this.data.discover(Object.keys(s.positions)); s.lastDiscovery = this.now(); }
    catch (e) {
      s.lastError = safeError(e); s.lastTick = this.now();
      this.store.save(s, [...events, this.event('discovery_error', { error: s.lastError })]); return s;
    }
    s.latestDecisions = []; s.scans++;
    for (const market of markets) {
      observe(s, market);
      const decision = assess(market, s.history[market.mint] ?? [], this.c);
      check = risk(s, this.c);
      let reason = decision.reason;
      if (command) reason = `operator_${command}`;
      else if (check.halt) reason = check.reason;
      else if (s.positions[market.mint]) reason = 'already_held';
      else if (s.cooldown[market.mint] > this.now()) reason = 'cooldown';
      else if (Object.keys(s.positions).length >= this.c.maxPositions) reason = 'position_limit';
      else if (s.cash < usd(this.c.positionUsd + this.c.paperBuyOverheadUsd)) reason = 'cash_limit';
      const row = { mint: market.mint, symbol: market.symbol, reason, at: this.now() };
      s.latestDecisions.push(row);
      events.push(this.event('candidate', { ...row, market, configHash: s.configHash }));
      if (reason !== 'momentum_pullback') continue;
      try {
        const screen = await this.data.screen(market.mint);
        if (!screen.ok) throw new Error(screen.reason.toUpperCase());
        const amount = String(usd(this.c.positionUsd));
        const q = await this.data.quote(USDC, market.mint, amount); this.fresh(q);
        const tokens = this.live ? BigInt(q.minOut) : this.paperOutput(q);
        const exit = await this.data.quote(market.mint, USDC, tokens.toString()); this.fresh(exit);
        const net = Number(this.live ? BigInt(exit.minOut) : this.paperOutput(exit)) - usd(this.c.paperSellOverheadUsd);
        const cost = usd(this.c.positionUsd + this.c.paperBuyOverheadUsd);
        const maxEntryLoss = Math.min(this.c.maxRoundTripLossPct, this.c.stopLossPct);
        if (net <= cost * (1 - maxEntryLoss / 100)) throw new Error('ROUND_TRIP_COST_TOO_HIGH');
        await this.sleep(this.c.fillDelaySeconds * 1000);
        if (this.store.getCommand()) throw new Error('OPERATOR_PAUSED');
        if (this.live) {
          this.store.save(s, events.splice(0));
          await this.live.trade(s, { side: 'buy', mint: market.mint, amount, symbol: market.symbol, decimals: screen.decimals });
          s = this.store.read(); if (s.pending) return s;
        } else {
          const fresh = await this.data.quote(USDC, market.mint, amount);
          const filled = this.paperOutput(fresh);
          const liquidation = await this.value({ mint: market.mint, amount: filled.toString() });
          if (liquidation <= cost * (1 - maxEntryLoss / 100)) throw new Error('ROUND_TRIP_COST_TOO_HIGH');
          if (this.store.getCommand()) throw new Error('OPERATOR_PAUSED');
          s.cash -= cost; s.buys++;
          s.positions[market.mint] = { mint: market.mint, symbol: market.symbol, decimals: screen.decimals,
            amount: filled.toString(), cost, value: liquidation, peakValue: liquidation,
            openedAt: this.now(), valuedAt: this.now() };
          events.push(this.event('buy', { mode: 'paper', mint: market.mint, amount: filled.toString(), cost,
            source: fresh.source, quoteAt: fresh.at, execution: 'simulated_at_minimum_output_minus_adverse_bps' }));
        }
        row.reason = 'entered';
      } catch (e) {
        if (this.live) { s = this.store.read(); if (s.pending) return s; }
        row.reason = safeError(e); events.push(this.event('entry_rejected', { mint: market.mint, reason: row.reason }));
        if (/^(HTTP_|NETWORK_|RPC_)/.test(row.reason)) s.lastError = row.reason;
      }
    }
    s.lastTick = this.now();
    this.store.save(s, events); return s;
  }
}
