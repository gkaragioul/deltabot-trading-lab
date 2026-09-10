# Verification — 10 September 2026

## Coinbase automation build

The current build implements the separate Coinbase engine in `src/cb`. It runs
paper mode by default; the live adapter is implemented but real fills have not
been exercised. No actual trade or transfer was submitted during this work.
Older sections below preserve historical Solana/connection milestones.

All **68 tests pass**, including 25 new Coinbase automation tests and the four
earlier Coinbase connection tests. Node syntax checks for all source/tests and
PowerShell parser checks for the three Coinbase launchers pass. Coinbase uses
native crypto/fetch/SQLite and adds no dependency.

Independent review findings were reproduced and addressed with regressions:
confirmed fills retained despite account mismatch/outage; protective exits
preserve baseline holdings; fee outages block buys without blocking all exits;
freshness and shutdown controls rechecked after asynchronous work; conservative
UTC rollover before settlement; a shared live-worker lock across runtimes;
read-only recovery for stopped ledgers with uncertain orders; throttled rejected
and zero-filled exits. The final focused review found no remaining material
defect in the last recovery/rollover changes. This is not exchange certification.

At 11:02:42 UTC, the real doctor passed authentication, permissions, account reads,
fee retrieval, product discovery, order-book validation, 60 closed candles and a
nonexecuting BTC-USDC order preview. The preview reported total 4.98488218998 USDC,
commission 0.05910927498 and no errors. Fee tier Intro 1 quoted taker 0.012.
View=true, Trade=true, Transfer=false. Available balances were 50.5268 USDC and
0.056855257 SOL. The product listing paginated 930 rows; screening selected 20.

At 11:14:52 UTC, the final 24-hour replay produced:

| Measure | Historical simulation |
| --- | ---: |
| Starting equity | 20 USDC |
| Ending equity | 15.8995750137 USDC |
| Net change | -4.1004249863 USDC |
| Orders / buys / sells | 56 / 28 / 28 |
| Modeled commissions | 3.29996578 USDC |
| Remaining positions | 0 |

Products were BTC, ETH, ZEC, XRP, SOL, HYPE, VVV and NEAR against USDC. The replay
uses the current product universe and fee, closed candles for decisions, and the
next candle's open with assumed 10-bps spread and adverse price adjustment for
fills. Liquidity is assumed, not reconstructed; minute sampling misses intraminute
losses and execution competition. Current product selection has survivorship
bias. It crosses two UTC dates, each with its own entry loss threshold. Exits may
exceed those thresholds. The sample was not used to optimize settings.

An earlier replay at 11:07:35 UTC showed 58 orders, ending equity 15.8121706637 and
3.41821003 commissions. Both samples lose money. Neither establishes a profitable
strategy, and the outcome does not support repeated 10x/100x return claims.
The latest full events and assumptions are in ignored `runtime/coinbase/backtest.json`.

The Coinbase paper supervisor and worker started in the background and completed
live-data scans. The observed dashboard reported no qualifying purchases at that
point. A stale-candle candidate was rejected and subsequently healthy scans were
observed. Graceful stop released both worker and supervisor locks; `resume` and
the launcher restarted the existing ledger. At 11:17:11 UTC, the restarted worker
reported eight total scans, zero buys/sells, no pending order and no current error.
The legacy Solana worker and supervisor
were stopped, and both legacy locks were verified released. No Windows sleep or
login settings were changed. Paper operation requires this computer awake/online.

Live submission, actual partial fills, product alias behavior and exchange-side
settlement timing remain validated by fixtures only. The API key itself does not
enforce the software's 20-USDC budget. A new runtime must not be used to bypass
an existing halted ledger or forget bot-owned holdings. External account changes
require investigation; recovery never silently treats them as earned money.

## Coinbase account connection

At 10:44:32 UTC, the new read-only connection check authenticated successfully
against Coinbase Advanced Trade. The server reported View=true, Trade=true,
Transfer=false. Seven accounts were paginated; nonzero available balances were
50.5268 USDC and 0.056855257 SOL, both with zero held amounts.

The downloaded key matched the identifier supplied by the user. Its ECDSA
credential was moved from Downloads to a user-only Windows ACL directory outside
Git, and its path was saved in ignored local configuration. No secret values
were emitted. Offline tests verify the actual JWT signature and request binding,
GET-only endpoint restrictions, pagination completeness/loop rejection, and
safe HTTP failures. Live checks were account/permission reads only. Coinbase
automated execution was not implemented by that earlier connection-only module;
the separate adapter described above now exists, with live mode inactive.

## Jupiter setup update

Item 2 now uses Jupiter's documented keyless access, enabled through the ignored
local setting `JUPITER_KEYLESS=1`. No key, account or paid plan was created.
Jupiter's official documentation index specifies 0.5 RPS access on api.jup.ag
without sign-up: https://developers.jup.ag/docs/llms.txt.

The full suite passes 39 tests. New coverage checks keyless authentication-header
omission, pacing concurrent calls after HTTP 429, preserving keyed access, and
requiring a wallet, RPC and explicit activation even with keyless access.
Real doctor checks all pass: 15 discovery candidates, Jupiter quote for 5 USDC
returning 49,426,847 SOL base units, slot 445855342, and 20 holder accounts.
These are read-only quotes and account queries, not swaps or payment receipts.

Before changing providers, the paper ledger had 15 scans and no buys, sells or
open positions. The worker was stopped and both worker/supervisor locks were
verified released. The existing ledger is retained, and the provider transition
is recorded in a worker_connection event and shown in the status report.
Live configuration remains false; no wallet or activation was added.

## RPC setup update

The user requested setup of item 1, the Solana data connection. Configured the
officially documented public endpoint `https://public.rpc.solanavibestation.com`
in this project's ignored `.env.local`. No account, API key or paid plan was
needed. CLI startup loads it automatically; explicit environment overrides win.
The running worker records only the RPC hostname, never query strings or secrets.

All four doctor checks now pass: discovery (15 candidates in the observed
snapshot), Raydium quote, Solana slot (445854055), and holder data (20 accounts).
The earlier HTTP 429 issue is resolved in these checks with the replacement
endpoint. This is observed functionality, not an uptime guarantee for a public
shared service. The updated suite passes 36 tests, including environment loading
and precedence. This setup does not activate live trading or resolve the separate
dependency maintenance items below.

## Implemented and tested

- 35 Node tests pass, including complete offline live signing/submission/settlement
  fixtures and the paper buy/exit/accounting lifecycle.
- All source modules pass Node syntax checks.
- Independent review found budget-ceiling, exit-fee-reserve, stale live-mark,
  recovered holding-time, refreshed-risk, and stale-report issues. They were
  reproduced and fixed with regression tests.
- Additional regressions cover failed network fees, external deposits during
  settlement, late operator pause, entry costs already beyond stop-loss, and
  rate-limit visibility.
- A local paper cycle completed using public discovery, storing decisions in SQLite.
- Hidden supervisor and worker started; live scans continued after the launching
  command returned. Graceful stop released both process locks. The ledger and
  observation history remained intact. Worker is restarted for continued paper use.

## Observed public API results

At approximately 09:43 UTC:
- DEX Screener discovery succeeded: 16 candidates returned in that snapshot.
- Raydium quote succeeded: input 5,000,000 USDC base units ($5 at parity), expected
  output 49,576,954 wrapped-SOL base units. This is a quote, not a executed trade.
- Solana getSlot succeeded: 445852555.
- Solana getAccountInfo succeeded in a separate read check.
- Solana getTokenLargestAccounts returned HTTP 429 and a Retry-After header of 10
  seconds. A separate public provider also rate-limited this method. No bypass is
  applied. A candidate requiring unavailable holder data cannot enter.

The public doctor's nonzero exit correctly reports that degraded holder-data
dependency. It is not a test-suite failure. Configure a reliable RPC endpoint for
uninterrupted holder checks; the default worker still collects market observations.

## Remaining limits

- No funds deposited, no live swaps sent, no earnings. Live activation/API/keypair
  configuration is absent. Mainnet signing/execution remains unvalidated.
- Paper data is quote-backed but fills and overheads are modeled, not actual
  transaction receipts. No profitability claim or 48-hour result is established.
- npm audit reports four moderate findings through the installed web3.js dependency
  tree (jayson, stream-json, uuid). No compatible upstream fix was selected; the
  suggested force downgrade would replace the API with an incompatible release.
  RPC uses native fetch, not jayson's streaming-server path. This is still an
  unresolved dependency maintenance item for production live use.
- Worker does not auto-start after reboot or prevent sleep. Public API service
  availability is external. No hosting, paid RPC plan, or account has been purchased.
- Hardware/network failures can prevent exits; no software stop guarantees its
  price. Failed quotes stay unresolved and conservatively valued, never marked sold.

All fixtures use generated unfunded test keys and mocked provider/chain responses.
Real public checks are read-only. No existing DeltaBot service or wallet was used.
