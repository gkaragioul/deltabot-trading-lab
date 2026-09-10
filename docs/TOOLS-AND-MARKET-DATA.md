# Tools, repositories and recorded market depth

Reviewed 10 September 2026. The useful additions address data quality, realistic
execution and independent validation. They do not supply a demonstrated profitable
strategy for this account.

## Repository assessment

| Project | Useful contribution | Decision for this bot |
| --- | --- | --- |
| [Coinbase Advanced Python SDK](https://github.com/coinbase/coinbase-advanced-py) | Official REST/authentication and WebSocket handling, reconnect/resubscribe patterns | Used the documented public-feed protocol to implement a native Node recorder; SDK itself not installed |
| [Freqtrade](https://github.com/freqtrade/freqtrade) | Strategy backtesting/dry runs; lookahead and recursive-indicator analysis | Useful independent validation framework; retain small pre-registered studies and fresh forward evaluation |
| [Hummingbot](https://github.com/hummingbot/hummingbot) | Coinbase Advanced Trade connector and market-making/execution framework | Relevant to a future passive-order simulation once fill probability and cancellation behavior can be modeled |
| [Backtesting.py](https://github.com/kernc/backtesting.py) | Independent Python backtester with spread, two-sided commissions and fractional trading support | Suitable secondary validation engine; requires explicit alignment with our sizing, risk and execution assumptions |

GitHub API metadata showed all four repositories unarchived. Their most recent
push dates at inspection were June 19, September 10, September 9 and August 5,
2026 respectively. Repository license identifiers were Apache-2.0, GPL-3.0,
Apache-2.0 and AGPL-3.0. No framework source was copied and no new package was
installed. The new recorder is our own code using the official protocol.

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
