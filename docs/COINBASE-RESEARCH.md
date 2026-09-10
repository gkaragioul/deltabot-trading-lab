# Coinbase research protocol — 10 September 2026

Objective: improve the automated tool using honest simulated evidence. The user's
requested frequent, repeated 10x/100x profits remain unachieved. A positive fitted
backtest is not sufficient evidence, and real-money execution remains inactive.

## Reproduce the study

```powershell
node src/cb/research-cli.mjs collect --days 14 --products 8
node src/cb/research-cli.mjs run
node src/cb/research-cli.mjs status
```

Collection defaults to an end time two UTC dates before today, to avoid the most
recent day already inspected in the earlier baseline replay. `--end` can specify
an exact Unix timestamp in seconds. The initial study covers 25 August through
8 September 2026, end-exclusive. Only read-only Coinbase endpoints are used.
API limits are respected with 300-minute chunks and paced requests. Local cached
chunks make interrupted collection resumable. Invalid partial JSON is refetched.

The dataset is `runtime/coinbase-research/dataset.json`; cache files, archived
protocols, results and the latest readable `RESEARCH.md` stay under that ignored
directory. Dataset and source fingerprints identify each study. Atomic JSON
replacement prevents interrupted result writes from destroying valid cache files.
If explicit run options disagree with the cached dataset, run fails clearly:
use `collect` to fetch the requested dataset first. A reused result is labeled
cached. Do not count an implementation-verification rerun as independent evidence.

## Frozen hypotheses and selection

`src/cb/research-strategies.mjs` defines 13 hypotheses before evaluation: the
original baseline, six more selective momentum variants, four volume-breakout
variants, and two trend/dip variants. No iterative parameter tuning on the final
test data is performed. Changing hypotheses requires a new version and genuinely
new validation data. Repeated searches over the same periods increase overfitting.

The chronological split is seven training days, four validation days and three
test days. Each window starts with an independent 20-USDC paper account; returns
are not compounded between windows. Every variant is evaluated on training and
validation. Ranking only considers candidates profitable in both, with at least
10 and five closed trades respectively, no remaining positions and conservative
drawdown at most 10% of starting budget. Rank by validation net P&L minus maximum
drawdown, with deterministic ID tie-breaking. Test results are never an input.

Selection is saved before the final test. If no candidate qualifies, the candidate
with the highest validation net P&L among those that traded is evaluated solely
for diagnosis. The selected/diagnostic candidate and baseline are then tested;
other candidates' test windows are not evaluated. A stress run increases assumed
spread and adverse prices and delays entry decisions by one minute.

Qualification additionally requires positive test/stress net returns, at least
10 test and five stress closed trades, acceptable drawdown, no unresolved holdings
and adequate data coverage. Even a pass means eligibility for fresh forward
paper validation, not permission or evidence for live trading. The present paper
challenger is exploratory and failed these qualifications; it is not promoted.

## Cost and data model

All simulations use the captured account taker rate, observed as 1.2% per side.
Decisions only inspect fully closed candles; modeled fills use a later open with
10-bps spread and 10-bps adverse adjustment per side. Available depth is proxied by
1% of the previous minute's volume. It is not a historical order-book reconstruction.
Stress uses 20-bps spread, 15-bps adverse adjustment and one-minute signal delay.
Stops are sampled once per minute; intraminute stops, queue position, real fills
and service outages are not reproduced. Current fee tiers replace unavailable
historical per-order tiers. USDC is valued at USD parity.

Missing bars remain missing and can block entries/exits. Unpriced open holdings
are valued at zero, producing conservative drawdown spikes that are not realized
cash losses. Current product availability/volume ranking creates selection and
survivorship bias. In the first study, VVV coverage was 73.13%, NEAR 94.24%, and
the other six markets 97.66–100%. These gaps independently block qualification.

## Observed results

None of the 13 candidates passed training and validation selection. The diagnostic
candidate `momentum-1.5-hold-180` lost 1.7160 USDC during training and gained just
0.0355 during validation with four completed trades. That is insufficient evidence.

| Three-day test | Original baseline | Diagnostic challenger |
| --- | ---: | ---: |
| Net P&L | -5.1475 USDC | -1.3280 USDC |
| Return on 20 USDC | -25.737% | -6.640% |
| Orders | 86 | 14 |
| Commissions | 5.0861 USDC | 0.8219 USDC |

The challenger stress result was -1.5035 USDC (-7.517%). Trading less reduced
modeled losses; it did not create a demonstrated positive edge. The no-trade
benchmark returned zero and outperformed every strategy with negative P&L.
All historical test periods in these reports are now exposed. Any further
confirmation must use new data, and overlapping windows are not independent.

## Fresh paper challenger

```powershell
./Start-Coinbase-Challenger.ps1
node src/cb/cli.mjs status --paper-strategy momentum-1.5-hold-180
node src/cb/cli.mjs pause --paper-strategy momentum-1.5-hold-180
node src/cb/cli.mjs resume --paper-strategy momentum-1.5-hold-180
node src/cb/cli.mjs stop --paper-strategy momentum-1.5-hold-180
```

The challenger uses a separate `runtime/coinbase-forward-momentum-1.5-hold-180`
ledger and reports its unqualified experimental status. It runs alongside the
original paper supervisor for comparison on new data. It has its own simulated
20-USDC budget, never a second real allocation. `--paper-strategy` is forbidden
with live mode, and config overrides are disallowed to preserve the hypothesis.
The legacy `backtest` command rejects this flag; use the research runner so the
actual hypothesis rules are tested. Both versions retain the existing loss limits.

The challenger launcher starts a hidden worker without its own crash supervisor.
This computer must remain awake and online. Daily follow-up checks can inspect
and recover failed paper workers while honoring operator stop/pause and risk
halts. The previous bounty heartbeat was repurposed to this active research task,
daily at 09:00 Europe/Athens. It stays quiet without a meaningful new finding.

Keep all failed trials and archived results. Never erase loss history, lower fee
assumptions to force success, or force trades to meet a daily activity quota.
Continue improving reliability and registering bounded new hypotheses while
collecting genuinely fresh forward evidence. No result currently supports live
activation or the requested 10x/100x outcome.

## Recorded-depth continuation

The public book recorder and recorded-depth replay described in
[TOOLS-AND-MARKET-DATA.md](TOOLS-AND-MARKET-DATA.md) now supplement this research.
Daily follow-up should inspect recorder health as well as both paper workers,
honor its durable stop control, and prefer newly recorded books for execution
validation. `node src/cb/replay-recorded.mjs --minutes 1440` evaluates the latest
closed day of candles against available prior book observations. Check coverage;
do not claim a complete replay when the recorder was offline or history was
trimmed. Repeated windows are still overlapping evidence, not new independent
tests. Neither recording depth nor obtaining a profitable short replay authorizes
or establishes live profitability.

Official references: [candle endpoint](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/products/get-product-candles)
and [maker/taker fee rules](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees).

## External engine continuation

The official Coinbase Python SDK and Backtesting.py are installed and integrated;
see [TOOLS-AND-MARKET-DATA.md](TOOLS-AND-MARKET-DATA.md). `npm run research:external`
checks sampled cached candles through the public SDK and runs independent
single-market simulations using the same entry decisions. Use it after a new
dataset or a material adapter/strategy change, not repeatedly on unchanged data.
Read `runtime/coinbase-external/latest.json` and its referenced `REPORT.md` for
results. A successful command means the diagnostic completed, not that a strategy
passed profitability qualification. Do not add independent account returns,
promote a zero-trade result, retune against exposed periods or enable live trading.

## Virtual capital comparisons

`replayDataset` accepts optional `capitalUsd` and `positionUsd` for in-memory
simulation. Position budget defaults to proportional scaling of the original
strategy allocation. Daily-loss and drawdown allowances scale with starting
capital, retaining their original percentages. The original configuration is
validated before making a local copy; real-money configuration still rejects
capital above 20 USDC and positions above 5 USDC. Virtual capital is bounded at
10,000 USDC. Results include `simulationBudget` so sizing and loss limits are
explicit. These options do not change live workers or their ledgers.

The September 10 $200 comparison reran the September 8 12:17–September 10 12:17
UTC dataset. With 50-USDC positions, baseline ended at 149.6381 USDC and challenger
at 171.0287. With 5-USDC positions, they ended at 181.4552 and 197.2326 respectively.
Keeping small positions does not necessarily preserve the original number of
trades: a larger daily-loss/drawdown allowance let the baseline continue trading
longer. Fees remained the captured 1.2% per side. Neither configuration was
profitable; increased order size also encountered more modeled liquidity rejects.
Detailed protocol, events and report are under
`runtime/coinbase-simulations/2026-09-10T1217Z/capital-200`.
