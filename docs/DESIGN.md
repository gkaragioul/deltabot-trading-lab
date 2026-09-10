# Solana trading experiment

Approved scope: user requested implementation after the seven-step trading plan.
Create an isolated Node 24 service with public live discovery, quote-backed paper
execution, guarded optional live Jupiter execution, a transactional SQLite ledger,
restart recovery, and readable reports. Do not modify existing DeltaBot services.

Initial account: $100 total, $20 active and $80 reserve; $5 positions, two at once,
$10 experiment drawdown pause including open positions. No leverage. Paper mode
is the default and must never load signing material or submit transactions.

Public Raydium quotes allow paper operation without an API key. Jupiter v2 is
used when configured and is required for live execution. No route means no fill.
Simulations apply adverse execution and explicitly labelled network/account cost
assumptions. Quotes are not proof of fills. No invented historical performance.

Live execution requires a dedicated wallet, Jupiter API key, explicit live mode,
and local live activation. Prepare and simulate transactions before signing.
Persist transaction identity before broadcast; never create a replacement while
the prior transaction is unresolved. Account confirmed token/SOL balance changes
from chain metadata, not advertised quote amounts. Uncertain results block entries.

Only ordinary SPL tokens without mint/freeze authorities qualify. Reject unknown
metadata, Token-2022 extensions, illiquid markets, and excessive holder concentration.
These are conservative screening heuristics, not proof a token is safe.

Strategy v1 is a falsifiable momentum/pullback hypothesis with minimum observation
history, liquidity, age, volume, buy/sell pressure, and capped recent price rise.
Record decisions and rejects with the current configuration hash. Exit on stop,
take-profit, trailing drawdown, maximum holding time, or explicit flatten command.
An unquotable position is valued at zero for conservative equity and pauses entries;
the position is retained and retried, never recorded as successfully sold.

One worker owns each runtime directory through an OS-managed lock. SQLite commits
events and state together. A watchdog restarts failed paper workers; it does not
restart live trading automatically. Reports clearly distinguish simulated money,
realized versus unrealized results, stale valuations, reserve, and service health.

Non-goals: assured returns, first-block sniping, leverage, market manipulation,
automated deposits, paid infrastructure, using existing wallets, or unattended
strategy changes. Further strategy versions require new observations.
