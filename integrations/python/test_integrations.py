import unittest
from unittest.mock import patch

import adapters


def bundle():
    rows = [dict(start=i * 60, decisionAt=(i + 1) * 60, open=100, high=100,
                 low=100, close=100, volume=10, entries={'fixture': i == 1}) for i in range(10)]
    return dict(version=1, start=120, end=600, feeRate='0.012', inputSha256='fixture',
                candidates=[dict(id='fixture', config=dict(activeUsd=20, positionUsd=5,
                    maxHoldMinutes=2, cooldownMinutes=1, stopLossPct=50, takeProfitPct=50,
                    trailingStopPct=50, maxDailyLossUsd=2, maxDrawdownUsd=5))],
                markets=[dict(product='TEST-USDC', baseIncrement='0.000001', rows=rows)])


class IntegrationTests(unittest.TestCase):
    def test_fractional_sizing_charges_both_sides_without_exceeding_budget(self):
        result = adapters.run_backtests(bundle(), spread_bps=0, adverse_bps=0)
        r = result['runs'][0]
        self.assertEqual(r['closedTrades'], 1)
        self.assertAlmostEqual(r['netChange'], -0.1185768, places=7)
        self.assertAlmostEqual(r['executionCosts'], 0.1185768, places=7)
        self.assertLessEqual(r['maxEntryCost'], 5)
        self.assertEqual(r['openPositions'], 0)

    def test_next_open_and_price_gap_do_not_use_signal_close_or_overspend(self):
        b = bundle()
        for row in b['markets'][0]['rows'][2:]:
            row.update(open=200, high=200, low=200, close=200)
        r = adapters.run_backtests(b, spread_bps=0, adverse_bps=0)['runs'][0]
        self.assertEqual(r['trades'][0]['entryAt'], 120)
        self.assertEqual(r['trades'][0]['entryPrice'], 200)
        self.assertLessEqual(r['maxEntryCost'], 5)

    def test_combined_spread_and_commission_still_respect_five_dollar_cap(self):
        r = adapters.run_backtests(bundle(), spread_bps=30, adverse_bps=20)['runs'][0]
        self.assertLessEqual(r['maxEntryCost'], 5)
        self.assertLess(r['netChange'], -0.1185768)

    def test_cost_total_includes_spread_when_commissions_are_zero(self):
        b = bundle(); b['feeRate'] = '0'
        r = adapters.run_backtests(b, spread_bps=10, adverse_bps=0)['runs'][0]
        self.assertAlmostEqual(r['executionCosts'], -r['netChange'], places=10)
        self.assertGreater(r['executionCosts'], 0)
        self.assertEqual(r['commissions'], 0)

    def test_stop_decided_on_close_fills_at_next_open(self):
        b = bundle()
        b['candidates'][0]['config']['stopLossPct'] = 5
        b['markets'][0]['rows'][2].update(close=90, low=90)
        for row in b['markets'][0]['rows'][3:]:
            row.update(open=80, high=80, low=80, close=80)
        r = adapters.run_backtests(b, spread_bps=0, adverse_bps=0)['runs'][0]
        self.assertEqual(r['trades'][0]['exitAt'], 180)
        self.assertEqual(r['trades'][0]['exitPrice'], 80)

    def test_final_liquidation_does_not_reuse_last_bar_or_leave_holdings(self):
        b = bundle()
        b['candidates'][0]['config']['maxHoldMinutes'] = 100
        r = adapters.run_backtests(b, spread_bps=0, adverse_bps=0)['runs'][0]
        self.assertEqual(r['trades'][0]['exitAt'], 540)
        self.assertEqual(r['closedTrades'], 1)
        self.assertEqual(r['openPositions'], 0)

    def test_missing_candles_and_future_decision_times_are_rejected(self):
        for mutate in (lambda b: b['markets'][0]['rows'].pop(4),
                       lambda b: b['markets'][0]['rows'][4].update(decisionAt=9999)):
            b = bundle(); mutate(b)
            with self.assertRaises(ValueError): adapters.run_backtests(b)

    def test_public_sdk_rejects_private_reads_and_writes_before_network(self):
        client = adapters.PublicCoinbase()
        self.assertFalse(client.is_authenticated)
        with patch.object(client.session, 'request', side_effect=AssertionError('unexpected network')):
            with self.assertRaises(PermissionError): client.get_accounts()
            with self.assertRaises(PermissionError): client.post('/api/v3/brokerage/orders', data={})
        client.session.close()

    def test_candle_comparison_cannot_pass_empty_partial_or_changed_data(self):
        rows = bundle()['markets'][0]['rows'][:3]
        same = adapters.compare_candles(rows, rows, 0, 180)
        self.assertTrue(same['passed'])
        for incoming in ([], rows[:2], [dict(r, close=99) for r in rows]):
            self.assertFalse(adapters.compare_candles(rows, incoming, 0, 180)['passed'])


if __name__ == '__main__': unittest.main()
