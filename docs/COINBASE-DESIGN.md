# Coinbase automation design

Approved scope: finish the automated Coinbase tool, retaining funds in Coinbase.
The system blocks entries after 200 total submissions/day while necessary exits
remain allowed; signals and costs determine actual
activity. No trade quota, return guarantee or unvalidated profit claim.

Implement a separate Coinbase spot engine and ledger. Keep the existing Solana
experiment intact, stop its paper worker as a one-time migration when the Coinbase
paper worker starts. The launcher does not later manage legacy workers.
Use Node 24, native crypto/fetch, SQLite WAL and existing single-worker locks.
No additional dependency, leverage, derivative, withdrawal or wallet transfer.

Default experiment: USDC quote currency, 20 USDC strategy budget, 5 USDC per
position including entry fees, two positions, 2 USDC daily loss stop and 5 USDC
peak drawdown stop. Loss stops block entries and still manage exits. Limits are
validated, not environment-overridable. Existing account holdings are excluded
from bot positions. Monetary operations use exact decimal arithmetic.

Market data: eligible account-visible online spot USDC products, order books and
one-minute candles. Rolling closed candles feed a momentum/pullback hypothesis.
Reject stale/invalid books, inadequate depth, wide spread and excessive costs.
Use the account's current taker fee; paper fills include spread and adverse price
adjustment. Screening does not establish a positive expected return.

Execution: preview bounded limit IOC orders, journal unique client id before
one submit, reconcile terminal order totals and fees, support partial fills.
Unknown outcomes remain pending; never automatically replace an uncertain order.
Pending requests are searched by client id after restart. Account balance changes
outside the bot block entries and require reconciliation. Limit orders may fail
to fill; stops do not guarantee execution. Live startup requires explicit local
activation and an operator command. This build is tested with mocks and live
read/preview endpoints; the assistant does not activate real-money execution.

Operations: CLI doctor/run/status/pause/resume/stop/flatten/export/backtest,
Markdown dashboard, paper-only hidden supervisor and launch/stop scripts.
Controls rechecked before submission. Read-only historical replay reports fees,
trade count and P&L with modeled fills and no lookahead. Tests cover signing,
decimals, risk gates, fills, recovery, outage exits, controls and account mismatch.

Credentials remain outside Git with current-user Windows permissions. Reports
omit secrets. Configuration and execution mode are bound to each SQLite ledger.
