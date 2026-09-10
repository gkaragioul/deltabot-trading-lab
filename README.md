# DeltaBot Trading Lab

Coinbase spot-market research, paper trading and execution diagnostics with
recorded order-book replay, the official Coinbase Python SDK and Backtesting.py.

**Version 0.2.0 · Experimental · 83 Node tests + 9 Python tests**

The default trading worker simulates orders. A manually gated live adapter exists,
but real-money fills have not been validated. **No profitable strategy has been
established.** The project reports losses, fees, missing data and failed hypotheses
alongside successful software checks.

## What is implemented

| Component | Capability |
| --- | --- |
| Coinbase paper engine | USDC spot discovery, closed-candle signals, decimal sizing, fee-aware exits and durable SQLite ledgers |
| Public depth recorder | BTC/ETH/SOL level2 books, five-second top-20 snapshots, stale-data and sequence-gap checks |
| Portfolio research | 13 frozen hypotheses, chronological train/validation/test selection, spread/latency stress and archived results |
| Recorded-book replay | Uses observations available at simulated time; rejects missing or stale books |
| Coinbase SDK 1.8.4 | Public REST candle checks against cached data, without account credentials |
| Backtesting.py 0.6.6 | Independent single-market broker using the bot's actual entry signals and explicit execution costs |
| Virtual-capital comparisons | In-memory balance/position experiments, including $200 cases, without changing live limits |
| Manual live adapter | IOC limits, previews, partial-fill accounting, one-shot submissions and pending-order recovery |

Freqtrade and Hummingbot were assessed but are **not installed or integrated**.
Post-only maker execution and slower strategy experiments remain planned research,
not implemented features. See [tool decisions and integration details](docs/TOOLS-AND-MARKET-DATA.md).

## Quick start

Use Node.js 24 or later. The Windows launchers run background workers with hidden
windows; direct Node commands can also be run in a terminal.

```powershell
npm ci
npm test
```

### Record public market data without an account key

```powershell
./Start-Coinbase-Recorder.ps1
node src/cb/record-books.mjs status
node src/cb/record-books.mjs stop
```

After an intentional stop, run `node src/cb/record-books.mjs resume` before the
launcher. The recorder cannot place orders. Samples are stored under
`runtime/coinbase-books`, retained for at most seven days and trimmed earlier
near the database size cap. It must stay awake and connected to collect data.

### Configure account-backed paper research

Store the Coinbase CDP credential JSON outside the repository. Set its path in
an untracked `.env.local` file, for example:

```dotenv
COINBASE_KEY_FILE=C:/private/coinbase/cdp_api_key.json
```

The file is read locally; never commit or paste its private key. Paper research
reads markets and the account fee tier. The `doctor` also checks permissions,
balances and a nonexecuting order preview; it does not submit a trade.

```powershell
node src/cb/cli.mjs doctor
./Start-Coinbase-Paper.ps1
node src/cb/cli.mjs status
./Start-Coinbase-Challenger.ps1
node src/cb/cli.mjs status --paper-strategy momentum-1.5-hold-180
```

Status commands refresh local Markdown dashboards. Workers need an awake,
connected computer. The baseline has a crash supervisor; the challenger and
recorder do not have an OS crash supervisor or automatic startup after reboot.

### Run research and the installed external tools

The optional Python integrations require Python 3.12 and `uv`. Setup creates an
isolated environment and installs 27 dependencies from the version-and-hash lock.

```powershell
./Setup-Research-Tools.ps1
node src/cb/research-cli.mjs collect --days 14 --products 8
node src/cb/research-cli.mjs run
npm run research:external
node src/cb/replay-recorded.mjs --minutes 60
```

Collect data before running the external command. The collector defaults to an
end date two UTC dates before today; use its explicit `--end` Unix timestamp and
`--dataset` options for a different archived window. Backtesting.py requires
complete candles, including warmup, for the selected markets. The combined
external command first checks nine sampled windows through the official SDK;
a failed check stops the run before simulation.

Outputs live under ignored `runtime/` directories. Source and dependency hashes,
protocols, input data, per-trade results and Markdown reports identify each run.
Local account ledgers, runtime datasets, dependencies and credentials are not
included in this repository or release.

## Latest simulation evidence

The same eight-market window, **September 8, 2026 12:17 UTC through September 10,
2026 12:17 UTC**, produced these results. Each row is a separate virtual account.

| Strategy | Initial USDC | Position budget | Closed trades | Final USDC | Net USDC | Commissions USDC |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 20 | 5 | 42 | 14.9166 | -5.0834 | 4.9614 |
| Challenger | 20 | 5 | 23 | 17.2326 | -2.7674 | 2.7165 |
| Baseline | 200 | 50 | 39 | 149.6381 | -50.3619 | 46.0970 |
| Challenger | 200 | 50 | 23 | 171.0287 | -28.9713 | 27.1894 |
| Baseline | 200 | 5 | 143 | 181.4552 | -18.5448 | 16.8776 |
| Challenger | 200 | 5 | 23 | 197.2326 | -2.7674 | 2.7165 |

The captured account fee was 1.2% per taker side; it is not a universal Coinbase
rate. The model also charges spread and adverse execution. Larger virtual capital
scales the dollar loss allowances while retaining their percentages; this can
permit more trades even with unchanged position size. Larger positions encounter
different liquidity rejections, so results are reruns, not simple multiplication.

The earlier 14-day, 13-hypothesis study qualified no candidate. Recent external
BTC/ETH/SOL diagnostics found one losing SOL trade; two 25-minute recorded-book
replays found no entries. Zero trades are inconclusive. Holding cash outperformed
the tested trading runs. See [research protocol and results](docs/COINBASE-RESEARCH.md)
and [release notes](docs/releases/v0.2.0.md).

Minute-volume liquidity is a proxy. Current product selection introduces bias;
missing data may prevent exits and inflate conservative drawdown through zero
marks. Historical windows already inspected are not new independent validation.
Backtesting.py uses separate single-market accounts with different execution
assumptions; their returns must not be added as a portfolio.

## Controls and live limits

```powershell
node src/cb/cli.mjs pause
node src/cb/cli.mjs resume
node src/cb/cli.mjs flatten
node src/cb/cli.mjs stop
node src/cb/cli.mjs export
```

Use `--paper-strategy momentum-1.5-hold-180` for the separate challenger ledger.
Pause blocks entries while exits continue. Flatten attempts to close bot-owned
positions. Stop persists across restarts and disables management until restart;
it does not guarantee holdings were closed. Inspect status before assuming so.

Actual trading settings retain a **20-USDC strategy budget**, **5-USDC position
cap**, two positions, a 2-USDC daily-loss entry gate and a 5-USDC peak-drawdown
entry gate. These are software controls, not guaranteed maximum losses or API-key
spending restrictions. The 200-submission daily gate is a ceiling, not a quota;
necessary exits remain permitted. No transfers, borrowing or leverage.

Live mode needs deliberate activation through `Start-Coinbase-Live.ps1`, including
the `START20` confirmation. The paper supervisor cannot start it. Ambiguous orders
remain journaled and are not automatically resubmitted. A stopped pending ledger
can be inspected with `node src/cb/cli.mjs reconcile --mode live`, which reads
exchange state without submitting an order. Never erase pending state or reset a
ledger to bypass a halt. Preexisting account assets are not adopted as bot holdings.

## Verification and layout

```powershell
npm test
.venv-research/Scripts/python.exe -m unittest discover -s integrations/python -v
uv pip check --python .venv-research/Scripts/python.exe
```

- `src/cb/`: Coinbase data access, engine, controls, recorder and research.
- `integrations/python/`: installed-package adapters, tests and dependency lock.
- `test/`: Node regression and integration tests.
- `docs/VERIFICATION.md`: verification evidence and model limitations.
- `docs/releases/`: versioned release descriptions.

The Coinbase Node implementation uses built-in crypto, fetch, WebSocket and
SQLite. Optional Python packages retain their upstream licenses. The older Solana
experiment and its dependency remain in [legacy documentation](docs/SOLANA-LEGACY.md).
The npm `start`, `status` and `doctor` shortcuts still target that legacy engine;
use the explicit Coinbase commands above. Legacy dependency audit findings are
tracked separately from the Coinbase implementation.

Official references: [Coinbase fees](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees),
[Coinbase SDK](https://github.com/coinbase/coinbase-advanced-py),
[Backtesting.py](https://github.com/kernc/backtesting.py).
