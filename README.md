# DeltaBot Coinbase Trading Lab

Coinbase spot-market scanner, paper trader and manually activated live-order
adapter. Funds stay on Coinbase. The default worker simulates trades using live
order books, the account's taker fee and adverse execution assumptions.

**No profitable edge has been established.** The initial 24-hour, eight-market
replay made 58 simulated orders and lost 4.1878 USDC from 20 USDC, including 3.4182
USDC of modeled commissions. The measured account fee was 1.2% per taker side.
Higher activity is not a return target; repeated 10x/100x returns are not an
implemented or supported claim. Historical simulation is not a payment receipt.

## Start and inspect

Requires Node 24. The local Coinbase key is configured through `COINBASE_KEY_FILE`
in ignored `.env.local`. Its private file remains outside Git with user-only
Windows permissions. Never put private key material in these documents.

```powershell
npm test
node src/cb/cli.mjs doctor
./Start-Coinbase-Paper.ps1
node src/cb/cli.mjs status
```

The doctor reads permissions, balances, fees, products and candles and requests
a nonexecuting order preview. It does not place a trade. The current key has View
and Trade permissions and no Transfer permission. Software limits are not
restrictions enforced by the API key itself.

Open [the paper dashboard](runtime/coinbase-paper/STATUS.md) for process health,
signals, positions, commissions and profit/loss. `status` refreshes the snapshot.
Worker logs and the SQLite event ledger are in the same ignored folder. The
hidden supervisor restarts an unexpectedly failed paper worker. The computer must
remain awake and online; it does not resume after reboot automatically.

## Controls

```powershell
node src/cb/cli.mjs pause
node src/cb/cli.mjs resume
node src/cb/cli.mjs flatten
node src/cb/cli.mjs stop
node src/cb/cli.mjs export
node src/cb/cli.mjs backtest --hours 24 --products 8
```

- `pause`: block new entries; keep managing existing exits.
- `resume`: remove an operator control. Restart the launcher if stopped.
- `flatten`: keep attempting sales of bot-owned positions and block new buys.
  Verify zero positions before stopping; unavailable sales remain open.
- `stop` or Ctrl+C: block subsequent submissions and finish the active work before
  exit. Already submitted orders still need settlement. Held assets remain held,
  with no automatic exit while the worker is stopped.
- `export`: write event history to `events.jsonl`.
- `backtest`: replay two to 48 hours across up to 20 currently eligible products;
  save assumptions, results and events to `runtime/coinbase/backtest.json`.

Commands accept `--mode paper|live`, `--runtime <directory>` and
`--config <JSON-file>`. Run also accepts `--cycles <positive integer>`.
Configuration and mode are bound to the ledger. A live worker holds a shared OS
lock independent of runtime or checkout. Do not create a new live ledger to
bypass a halt or orphan an earlier bot position.

For a stopped live ledger with a pending order, use
`node src/cb/cli.mjs reconcile --mode live`. This command only reads Coinbase and
updates the local ledger; it cannot submit orders. It preserves the stop control.
If settlement is still unknown, it remains pending. Once reconciled, `resume`
can remove the control, followed by explicit manual startup. Balance halts clear
only if actual and expected balances match. External deposits, withdrawals or
manual trades require investigation; the tool does not silently adopt them as P&L.
Drawdown halts cannot be cleared by `resume` or reconciliation.

## Strategy and limits

The default scan interval is 15 seconds, subject to API latency. Discovery selects
up to 20 eligible USDC spot products by reported 24-hour volume. This is Coinbase's
listed universe, not every newly launched memecoin. Closed one-minute candles
feed an unvalidated hypothesis: five-minute momentum 0.6–8%, EMA5 above EMA20,
and a 0.1–0.8% pullback from the recent high.

| Control | Default / hard maximum |
| --- | --- |
| Starting strategy budget | 20 USDC |
| Cost per position including entry commission | 5 USDC |
| Simultaneous positions | 2 |
| Daily loss threshold for blocking entries | 2 USDC |
| Peak drawdown threshold for blocking entries | 5 USDC |
| Daily entry gate | 200 total submissions; necessary exits allowed |
| Maximum spread / limit-price deviation | 30 / 30 basis points |
| Modeled immediate round-trip cost ceiling | 3% |
| Net stop / take-profit / trailing decline | 3.5% / 6% / 1.5% |
| Maximum holding time / re-entry cooldown | 15 / 5 minutes |

Sizing and fill accounting use decimal fixed-point arithmetic. The daily order
setting is a ceiling, not a quota; there may be no qualifying trades. Zero-filled
or explicitly rejected live exits wait at least a minute before another attempt.
Necessary exits can exceed the daily entry gate. Loss thresholds block new
purchases but do not guarantee a maximum loss. Days use UTC; unpriced holdings
remain included conservatively in the next day's loss baseline.

The 3% cost ceiling accommodates the observed 1.2% taker fee per side plus modeled
execution costs. Parameters were not optimized on the replay. The losing replay
does not justify activating this strategy. USDC is valued at USD parity.

## Live adapter

The adapter implements bounded immediate-or-cancel limit orders, mandatory
previews, actual partial-fill/commission accounting and durable recovery. It saves
a unique client order ID before one submission. An uncertain result stays pending
across restarts and is never automatically submitted again. Do not delete pending
state to get the bot moving; reconcile it against Coinbase first.

Preexisting holdings form a baseline and are not bot positions. Unrelated account
changes pause entries. Protective exits require sufficient inventory above that
baseline. Confirmed settlements are recorded even if balance checks fail; those
discrepancies remain halted. Unavailable fees block buys while exits use a
conservative estimate. Stale books, missing liquidity or API failures can prevent
execution. Software stops require the worker and network to be healthy.

**Real-money fills have not been validated. Live trading is not running.**
Manual activation is available through `Start-Coinbase-Live.ps1`, which requires
typing `START20`. It enables both the process environment gate and explicit CLI
activation flag for that session only. The paper supervisor cannot start it.
Use `--mode live` for its status and controls. No transfers, borrowing or leverage.

## Verification and source layout

The [research protocol and results](docs/COINBASE-RESEARCH.md) document the new
14-day, 13-hypothesis study, separate train/validation/test windows and exploratory
forward challenger. No candidate passed qualification. Run
`node src/cb/research-cli.mjs status` for the latest research report.

[External tool assessment and public book recorder](docs/TOOLS-AND-MARKET-DATA.md)
document the next improvement: actual Coinbase depth sampling and recorded-book
replay. The recorder runs independently and cannot place trades.

[Verification record](docs/VERIFICATION.md) documents tests, real read/preview
checks, replay outcomes and limitations. Coinbase uses native crypto, fetch and
SQLite; this addition installs no new dependency.

- `src/cb/api.mjs`: signed requests, endpoint restrictions, pagination and pacing.
- `decimal.mjs`, `config.mjs`, `market.mjs`: arithmetic, validation and signals.
- `execution.mjs`, `engine.mjs`: journaled orders, fills, exits and risk controls.
- `cli.mjs`, `operations.mjs`, `supervisor.mjs`, `report.mjs`: process and controls.
- `backtest.mjs`: historical replay with modeled liquidity, spread and fees.

The old Solana experiment is retained in [legacy documentation](docs/SOLANA-LEGACY.md).
Its paper worker is stopped as a one-time migration. The Coinbase launcher does
not control legacy workers subsequently started manually. Original npm scripts
still refer to the legacy engine; use Coinbase commands above. Existing Solana
dependency audit findings remain a legacy maintenance item; Coinbase does not
import that SDK.

Official interfaces: [authentication](https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication),
[create order](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/create-order),
[get order](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/get-order).
