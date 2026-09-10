# Tools, repositories and recorded market depth

Reviewed 10 September 2026. The useful additions address data quality, realistic
execution and independent validation. They do not supply a demonstrated profitable
strategy for this account.

## Repository assessment

| Project | Useful contribution | Decision for this bot |
| --- | --- | --- |
| [Coinbase Advanced Python SDK](https://github.com/coinbase/coinbase-advanced-py) | Official REST/authentication and WebSocket handling | **Installed and integrated, 1.8.4:** public REST candle cross-check against the native collector; credentials explicitly disabled |
| [Freqtrade](https://github.com/freqtrade/freqtrade) | Strategy backtesting/dry runs; lookahead and recursive-indicator analysis | **Not installed:** duplicates the broker/backtest integration selected here and needs a separate strategy port; reconsider for broader strategy research |
| [Hummingbot](https://github.com/hummingbot/hummingbot) | Coinbase Advanced Trade connector and market-making/execution framework | **Not installed:** relevant when testing passive orders and queue/fill probability; our present taker strategy does not use those capabilities |
| [Backtesting.py](https://github.com/kernc/backtesting.py) | Independent Python backtester with spread, two-sided commissions and fractional trading support | **Installed and integrated, 0.6.6:** consumes the bot's actual causal entry signals and runs a separate diagnostic broker |

GitHub API metadata showed all four repositories unarchived. Their most recent
push dates at inspection were June 19, September 10, September 9 and August 5,
2026 respectively. Repository license identifiers were Apache-2.0, GPL-3.0,
Apache-2.0 and AGPL-3.0. The recorder remains our own Node code. The two selected
Python packages and their dependencies are now installed in `.venv-research`,
isolated from the running bot. All 27 dependency versions and distribution hashes
are pinned in `integrations/python/requirements.lock`. Upstream package licenses
remain applicable; the integration does not relicense third-party code.

## Installed repository integrations

```powershell
./Setup-Research-Tools.ps1
npm run research:external
node src/cb/external-cli.mjs sdk-check
node src/cb/external-cli.mjs backtest
.venv-research/Scripts/python.exe -m unittest discover -s integrations/python -v
```

Setup requires Python 3.12 and `uv`, both available on this host. It installs the
hashed lock and tests the adapters. The default command reads the existing
`runtime/coinbase-research/dataset.json`, exports BTC/ETH/SOL signals for baseline
and `momentum-1.5-hold-180`, verifies three one-hour windows per market using the
official SDK, then runs twelve Backtesting.py diagnostics (three markets, two
strategies, two cost scenarios). A mismatched or incomplete SDK comparison stops
the combined run before simulation. No account client or credential file is read.

Optional `--dataset <JSON>`, `--products BTC-USDC,ETH-USDC`,
`--candidates baseline,momentum-1.5-hold-180`, `--start <Unix seconds>` and
`--end <Unix seconds>` select explicit inputs. Only registered strategies can be
exported. Candles must be complete, unique, consecutive and valid, including an
hour of warmup. Signals use only the last 60 closed candles and the exact native
decision functions. No missing bars are filled or interpolated.

The SDK uses its real `get_public_candles` method, explicit null credentials,
disabled ambient `.netrc` authentication, a 15-second timeout and public GET-only
route checks. Public-vs-cached equality uses decimal comparisons of all OHLCV
fields. Nine matching sampled windows do not prove the entire dataset correct
and both clients still rely on Coinbase as the underlying data source.

Backtesting.py uses independent virtual 20-USDC single-market accounts with one
position and at most 5 USDC including entry costs. Fractional units use each
product's base increment. Entry signals and close-based exits fill at the next
bar open; net stops/targets, trailing stops, holding time, cooldown and loss gates
are modeled separately in the adapter. The final position closes at the final
bar's open, with no synthetic extra bar. Zero-trade outcomes are inconclusive.

Base costs use the dataset's measured taker fee (1.2% per side in the first run),
10 bps spread and 10 bps extra adverse cost on each side. Stress uses 30 bps
spread and 20 bps per-side adverse cost. The upstream engine charges spread at
entry and commissions on both sides. A reserve covers the spread/commission
cross term so broker sizing cannot exceed the 5-USDC cap. Tests include a price
gap doubling the entry price and verify sizing at the actual fill price.

These are **diagnostics, not an exact reproduction of the portfolio bot**:
there is no cross-market allocation, order-book depth, partial execution,
exchange minimum-order filter or daily order-count gate. Adverse execution is
an extra cash cost, not a price adjustment. Never sum these separate account
returns or treat them as an independent profitable holdout. Use the original
portfolio replay and recorded-book replay for those execution constraints.

Each invocation saves its signal bundle, per-trade results, logs, hashes of input,
source and dependency lock, and `REPORT.md` under a unique directory in
`runtime/coinbase-external`. `latest.json` points to the most recent run. This is
an on-demand research command; it adds no second live or background trading bot.

The first completed 14-day diagnostic (August 25 through September 7) matched
all nine SDK windows. Base-cost baseline results were -0.3827 USDC on BTC,
-1.4785 on ETH and -3.8525 on SOL, respectively 3, 11 and 30 closed trades.
The challenger took no BTC/ETH trades and lost 0.3386 USDC on two SOL trades.
Stress costs worsened each trading result. These are separate 20-USDC accounts
on already examined historical data, not new evidence of profitability.

Freqtrade's [lookahead/recursive checks](https://github.com/freqtrade/freqtrade/blob/develop/docs/strategy-customization.md)
address future-data leakage and indicator initialization differences.
[Backtesting.py's execution documentation](https://kernc.github.io/backtesting.py/doc/backtesting/backtesting.html)
describes commission and next-bar assumptions; equivalent settings must be used
before treating a cross-engine comparison as meaningful.

## Implemented improvement

The previous historical model approximated liquidity from minute volume and a
fixed spread. The new recorder stores actual public Coinbase order-book samples
for BTC, ETH and SOL. This lets new simulations check whether quotes were really
available at the time and use observed bid/ask depth instead of that volume proxy.

```powershell
./Start-Coinbase-Recorder.ps1
node src/cb/record-books.mjs status
node src/cb/record-books.mjs stop
node src/cb/record-books.mjs resume
node src/cb/replay-recorded.mjs --minutes 60
node src/cb/replay-recorded.mjs --minutes 60 --candidate momentum-1.5-hold-180
```

After stop, use resume and the launcher to start again. The recorder is independent
of both paper bots and has no account client, credentials or trading endpoint.
The replay tool reads product metadata, candles and fees using the existing
read-only API client; it never submits an order.

The official [public WebSocket endpoint](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-endpoints)
does not require a JWT. Subscribe separately to level2 and heartbeats. Coinbase
documents most USDC public products as aliases of the corresponding USD feed;
the archive explicitly stores both source USD ID and research USDC alias.
The [level2 protocol](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/level2)
uses absolute updated quantities, with zero removing a price level.

Real probes showed sequence numbers covering the complete connection stream,
including heartbeat and subscription messages. Tests enforce that observed
contract. Gaps, out-of-order messages, malformed levels or stalled data trigger
invalidation and reconnect. Reconnection creates a fresh epoch and requires new
snapshots. No stale book is carried across the gap.

The recorder maintains full in-memory books, then samples the top 20 levels every
five seconds into SQLite. Each sample includes local observation time, exchange
publication time, source product, sequence and connection epoch. Historical lookup
requires a sample observed at or before simulated time, a still-connected epoch,
and freshness of both observation and original exchange time. Missing quotes
are rejected; recorded replay never falls back to fabricated liquidity.

Stored samples live in ignored `runtime/coinbase-books/books.sqlite`, with readable
`STATUS.md` and `REPLAY.md` in that directory. Replay results are archived in its
`replays` subdirectory. A SQLite read transaction pins replay observations; a
digest identifies the books actually used. Replay reports per-market minute
coverage and explicitly distinguishes incomplete/no-trade data from success.

Retention is at most seven days. Oldest samples are removed earlier as used pages
approach 80% of the approximately 512-MiB database cap, leaving insertion headroom.
WAL/index overhead and the host disk still require space. The process must remain
awake and connected; network reconnects back off from one to 30 seconds. The
launcher does not install a Windows startup task or an OS crash supervisor.

## Observed verification

A 20-second real public-feed check processed 1,004 messages and recorded nine
valid book samples, with zero reconnects/errors. A subsequent background session
reported 2,687 messages, 30 samples and a fresh connection at 11:49:14 UTC.
Read-only archive-based 5-USDC sizing checks succeeded for all three products.
With observed 1.2% taker fees and the existing adverse execution assumptions,
their modeled immediate round-trip costs were approximately 2.57–2.60%.
These were computed quotes, not executed trades or profits.

The first five-minute recorded replay had only one minute of book coverage per
market, generated zero qualifying trades and made no profitability claim. Allow
fresh data to accumulate. Sampling cannot reconstruct queue position, guarantee
fills, simulate passive maker orders or capture every intraminute price move.

Tests cover level replacement/removal, decimal price normalization, heartbeats in
sequence tracking, missing initial snapshots, stale/crossed/invalid books,
historical lookahead and disconnect barriers, original exchange-time freshness,
capacity eviction and refusal to invent liquidity in recorded replay. Independent
review identified the storage-cap and exchange-freshness issues; both were fixed
and reproduced by regression tests.
