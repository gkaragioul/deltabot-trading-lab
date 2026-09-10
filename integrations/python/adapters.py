"""External research engines. No account credentials or live execution."""
import math
import re
from decimal import Decimal
from importlib.metadata import version

import pandas as pd
from backtesting import Strategy
from backtesting.lib import FractionalBacktest
from coinbase.rest import RESTClient


class PublicCoinbase(RESTClient):
    """Use the real SDK with explicit null credentials and a public-read boundary."""
    def __init__(self):
        super().__init__(api_key=None, api_secret=None, key_file=None, timeout=15)
        self.session.trust_env = False  # Also avoid implicit .netrc authentication.

    def prepare_and_send_request(self, http_method, url_path, params=None, data=None, public=False):
        if http_method != 'GET' or not public or data or not re.fullmatch(
                r'/api/v3/brokerage/market/products/[A-Z0-9]+-(USDC|USD)(/candles)?', url_path):
            raise PermissionError('PUBLIC_MARKET_READS_ONLY')
        return super().prepare_and_send_request(http_method, url_path, params, data, public=True)


def compare_candles(expected, actual, start, end):
    """Strict comparison; missing/duplicate candles never count as agreement."""
    if start >= end or start % 60 or end % 60:
        raise ValueError('INVALID_COMPARISON_WINDOW')
    def index(rows):
        indexed = {}
        for r in rows:
            t = int(r['start'])
            if start <= t < end:
                if t in indexed:
                    raise ValueError('DUPLICATE_CANDLE')
                values = tuple(Decimal(str(r[k])) for k in ('open', 'high', 'low', 'close', 'volume'))
                if any(not v.is_finite() for v in values):
                    raise ValueError('INVALID_CANDLE')
                indexed[t] = values
        return indexed
    a, b = index(expected), index(actual)
    required = set(range(start, end, 60))
    changed = sorted(t for t in a.keys() & b.keys() if a[t] != b[t])
    return dict(passed=set(a) == set(b) == required and not changed,
                expectedMinutes=len(required), cachedMinutes=len(a), sdkMinutes=len(b),
                differingMinutes=changed, missingCached=sorted(required - a.keys()),
                missingSdk=sorted(required - b.keys()))


def validate_bundle(bundle):
    if bundle.get('version') != 1 or not bundle.get('markets') or not bundle.get('candidates'):
        raise ValueError('INVALID_EXTERNAL_BUNDLE')
    start, end = bundle['start'], bundle['end']
    if not isinstance(start, int) or not isinstance(end, int) or start % 60 or end % 60 or end <= start:
        raise ValueError('INVALID_EXTERNAL_WINDOW')
    fee = float(bundle['feeRate'])
    if not math.isfinite(fee) or not 0 <= fee <= .05:
        raise ValueError('INVALID_FEE')
    for candidate in bundle['candidates']:
        c = candidate['config']
        keys = ('activeUsd', 'positionUsd', 'maxHoldMinutes', 'cooldownMinutes', 'stopLossPct',
                'takeProfitPct', 'trailingStopPct', 'maxDailyLossUsd', 'maxDrawdownUsd')
        if any(not isinstance(c[k], (int, float)) or not math.isfinite(c[k]) or c[k] <= 0 for k in keys):
            raise ValueError('INVALID_EXTERNAL_CONFIG')
        if c['activeUsd'] > 20 or c['positionUsd'] > min(5, c['activeUsd']):
            raise ValueError('INVALID_EXTERNAL_BUDGET')
    for market in bundle['markets']:
        step = float(market['baseIncrement'])
        if not math.isfinite(step) or step <= 0:
            raise ValueError('INVALID_INCREMENT')
        rows = market['rows']
        if len(rows) < 3 or rows[0]['start'] > start - 120 or rows[-1]['start'] != end - 60:
            raise ValueError('INCOMPLETE_EXTERNAL_CANDLES')
        previous = None
        for row in rows:
            t = row['start']
            if not isinstance(t, int) or t % 60 or row['decisionAt'] != t + 60 or (previous is not None and t != previous + 60):
                raise ValueError('INVALID_EXTERNAL_CANDLE_TIME')
            previous = t
            o, h, lo, close, vol = [row[k] for k in ('open', 'high', 'low', 'close', 'volume')]
            if any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in (o, h, lo, close, vol)) or min(o, h, lo, close) <= 0 or vol < 0 or lo > min(o, close) or h < max(o, close):
                raise ValueError('INVALID_EXTERNAL_CANDLE')
            if any(type(row['entries'].get(c['id'])) is not bool for c in bundle['candidates']):
                raise ValueError('INVALID_EXTERNAL_SIGNAL')


def run_backtests(bundle, spread_bps=10, adverse_bps=10):
    validate_bundle(bundle)
    if any(not math.isfinite(x) or x < 0 or x > 100 for x in (spread_bps, adverse_bps)):
        raise ValueError('INVALID_EXTERNAL_COSTS')
    fee = float(bundle['feeRate'])
    # Additional adverse execution is charged as a per-side cost, not a price model.
    effective_fee = fee + adverse_bps / 10000
    runs = []
    for market in bundle['markets']:
        rows = market['rows']
        for candidate in bundle['candidates']:
            c = candidate['config']
            frame = pd.DataFrame([{**{k.title(): r[k] for k in ('open', 'high', 'low', 'close', 'volume')},
                                   'Enter': r['entries'][candidate['id']]} for r in rows],
                                 index=pd.to_datetime([r['start'] for r in rows], unit='s', utc=True))

            class ImportedSignals(Strategy):
                def init(self):
                    self.high_value = 0
                    self.cooldown_until = -1
                    self.peak = c['activeUsd']
                    self.day = None
                    self.day_start = c['activeUsd']
                    self.day_halted = False
                    self.halted = False
                    self.closed_count = 0

                def next(self):
                    i = len(self.data) - 1
                    now = rows[i]['decisionAt']
                    # Orders submitted on a closed bar fill at the next bar's open.
                    # Schedule liquidation on the penultimate bar; never reprocess
                    # the final bar with finalize_trades=True (which changes fills).
                    if i >= len(rows) - 2:
                        if self.position: self.position.close()
                        return
                    if now < bundle['start']: return
                    liquidation_equity = self.equity
                    if self.position:
                        liquidation_equity -= self.position.size * self.data.Close[-1] * effective_fee
                    if now // 86400 != self.day:
                        self.day, self.day_start, self.day_halted = now // 86400, liquidation_equity, False
                    self.peak = max(self.peak, liquidation_equity)
                    self.halted |= self.peak - liquidation_equity >= c['maxDrawdownUsd']
                    self.day_halted |= self.day_start - liquidation_equity >= c['maxDailyLossUsd']
                    if len(self.closed_trades) > self.closed_count:
                        self.closed_count = len(self.closed_trades)
                        # Cooldown begins at the actual fill timestamp, not decision time.
                        self.cooldown_until = self.closed_trades[-1].exit_time.timestamp() + c['cooldownMinutes'] * 60
                        self.high_value = 0
                    if self.position:
                        trade = self.trades[0]
                        cost = trade.size * trade.entry_price * (1 + effective_fee)
                        value = trade.size * self.data.Close[-1] * (1 - effective_fee)
                        self.high_value = max(self.high_value, value)
                        if (value <= cost * (1 - c['stopLossPct'] / 100)
                                or value >= cost * (1 + c['takeProfitPct'] / 100)
                                or (self.high_value > cost and value <= self.high_value * (1 - c['trailingStopPct'] / 100))
                                or now - trade.entry_time.timestamp() >= c['maxHoldMinutes'] * 60):
                            self.position.close()
                        return
                    if self.orders or self.halted or self.day_halted or now < self.cooldown_until or self.equity < c['positionUsd']:
                        return
                    if self.data.Enter[-1]:
                        # With no holdings, available margin equals cash. Fractional
                        # broker sizing applies this budget at the actual fill price,
                        # including spread/commission, even after an overnight gap.
                        # The upstream broker sizes commission on the raw price,
                        # then charges it on the spread-adjusted price. Reserve the
                        # small cross term so combined costs stay within our cap.
                        budget = c['positionUsd'] / (1 + effective_fee * spread_bps / 10000)
                        self.buy(size=min(math.nextafter(1.0, 0), budget / self.equity))

            bt = FractionalBacktest(frame, ImportedSignals, fractional_unit=float(market['baseIncrement']),
                                    cash=c['activeUsd'], commission=effective_fee, spread=spread_bps / 10000,
                                    trade_on_close=False, exclusive_orders=True, finalize_trades=False)
            result = bt.run()
            trades = [dict(quantity=float(t.Size), entryAt=int(t.EntryTime.timestamp()), exitAt=int(t.ExitTime.timestamp()),
                           entryPrice=float(t.EntryPrice), exitPrice=float(t.ExitPrice),
                           net=float(t.PnL), feeAndAdverseCosts=float(t.Commission),
                           spreadCost=float(t.Size * t.EntryPrice * (spread_bps / 10000) / (1 + spread_bps / 10000)))
                      for t in result['_trades'].itertuples()]
            for trade in trades:
                trade['executionCosts'] = trade['feeAndAdverseCosts'] + trade['spreadCost']
            max_cost = max((t['quantity'] * t['entryPrice'] * (1 + effective_fee) for t in trades), default=0)
            if max_cost > c['positionUsd'] + 1e-8 or result['_strategy'].position:
                raise ValueError('EXTERNAL_BROKER_INVARIANT_FAILED')
            fees_and_adverse = sum(t['feeAndAdverseCosts'] for t in trades)
            spread_costs = sum(t['spreadCost'] for t in trades)
            commissions = fees_and_adverse * fee / effective_fee if effective_fee else 0
            runs.append(dict(product=market['product'], candidate=candidate['id'],
                             startEquity=c['activeUsd'], endEquity=float(result['Equity Final [$]']),
                             netChange=float(result['Equity Final [$]']) - c['activeUsd'],
                             closedTrades=len(trades), openPositions=0, maxEntryCost=max_cost,
                             executionCosts=fees_and_adverse + spread_costs, commissions=commissions,
                             adverseCosts=fees_and_adverse - commissions, spreadCosts=spread_costs,
                             maxDrawdownPct=-float(result['Max. Drawdown [%]']), trades=trades))
    return dict(engine='backtesting.py', engineVersion=version('backtesting'),
                inputSha256=bundle['inputSha256'], start=bundle['start'], end=bundle['end'],
                feeRate=fee, spreadBps=spread_bps, adverseBps=adverse_bps, runs=runs,
                qualification='diagnostic_only',
                limitations=['Independent single-market accounts; do not sum returns as a portfolio.',
                             'Shared entry signals; independent broker and close-based net exit/risk rules.',
                             'No order-book depth, partial fills, product minimums or daily order-count gate.',
                             'Spread charged at entry; adverse execution charged as extra cost on both sides.',
                             'Liquidates at final candle open; no parameter optimization or live activation.'])
