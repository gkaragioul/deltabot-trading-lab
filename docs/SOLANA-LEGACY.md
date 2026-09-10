# Legacy Solana Experiment — Historical Documentation

This document preserves the earlier Solana setup and its historical status.
The active project now uses Coinbase; see the repository README. Statements
below about Coinbase being read-only predate the new adapter.

# DeltaBot Memecoin Lab

An isolated Solana momentum/pullback experiment. It scans real markets and paper
trades using live swap quotes. Optional live execution is implemented behind an
explicit local activation and dedicated-wallet setup. No strategy profitability
has been established and simulated results are not earnings.

## Start and inspect

### Coinbase account connection

The user has switched the intended funding route to Coinbase. A separate,
read-only connection check is now available with `node src/coinbase.mjs`.
It loads `COINBASE_KEY_FILE` from the ignored `.env.local`, signs short-lived
ES256 request tokens, verifies API permissions, and reads all account pages.
It writes a balance/permission snapshot to ignored `runtime/coinbase/connection.json`.
The credential is stored outside this repository under the current user's local
application-data directory with Windows access restricted to that user. The
downloaded copy was moved there; no secret is printed or committed.

This checker does not submit orders or transfers. The existing Solana/Jupiter
engine has not been converted into a Coinbase execution adapter. The Coinbase
key has View and Trade permissions for Primary and no Transfer permission;
the API key itself has no $20 budget cap. Authenticated connection success is
not validation of automated trading or profitability. No funds were moved.

Authentication reference: https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication

### Solana paper experiment

Requires Node 24 on Windows or Linux. From this directory:

This machine's `.env.local` now selects the public, keyless Solana Vibe Station
RPC. The CLI loads that file automatically, including when launched by the
paper supervisor. Explicit process environment values take precedence. The file
is ignored by Git; it contains the public RPC URL and `JUPITER_KEYLESS=1`. Recreate this
setting on another machine with `SOLANA_RPC_URL=https://public.rpc.solanavibestation.com`.
No account or paid subscription was created. As a shared free endpoint, it can
still have outages or rate limits; failures continue to block affected entries.

```powershell
npm ci --ignore-scripts
npm test
node src/cli.mjs doctor
node src/cli.mjs run --cycles 1
./Start-Paper.ps1
node src/cli.mjs status
```

`Start-Paper.ps1` starts a hidden paper-only supervisor. It restarts workers that
exit with an error, with a 10-second delay. It does not change Windows sleep
settings, install a login task, or survive a machine reboot. The computer must
remain awake and connected. After reboot, run the launcher again. The SQLite
ledger resumes the existing experiment. A second worker is refused through an
OS-managed named pipe on Windows or abstract socket on Linux.

On Linux, run `node src/supervisor.mjs` under your existing process manager.
No hosted service or subscription is created by this project.

Read `runtime/paper/STATUS.md` for a readable snapshot. Run `status` to refresh it
and check whether a worker is actually alive. Runtime files are private local
outputs, excluded from Git. Source code does not modify the existing DeltaBot
payment utilities or read their credentials.

## Controls

```powershell
node src/cli.mjs pause
node src/cli.mjs resume
node src/cli.mjs flatten
node src/cli.mjs stop
node src/cli.mjs export
```

- **pause:** prevent new entries, continue managing existing exits.
- **resume:** remove an operator pause. It cannot clear a risk halt or unresolved
  transaction. If the worker has stopped, start it again after resume.
- **flatten:** keep trying to sell all positions while preventing new entries.
  An unavailable route is retained as an open position. Flatten is asynchronous.
- **stop:** terminate after the current cycle; open positions remain held. Flatten
  and verify zero positions before stopping if you want to exit everything.
- **export:** write the event ledger to `runtime/paper/events.jsonl` for review.

All commands accept `--mode paper|live`, `--runtime <directory>` and
`--config <JSON-file>`. `run` also accepts `--cycles <positive integer>`.
An existing runtime rejects mode or configuration changes. Use a new runtime
for a new strategy experiment; do not reset a funded ledger to bypass a halt.

## Initial strategy and budget

The ledger starts with $20 active simulated funds and $80 reserve. Position size
is at most $5, with at most two positions. A $10 peak-to-current drawdown pauses
entries, including open losses. These are hard maximums in the configuration.

Entry hypothesis: a token at least 30 minutes old, at least $50,000 liquidity and
$5,000 five-minute volume, a buy/sell count ratio of 1.5 or higher, five-minute
price growth between 2% and 30%, and a 1–8% pullback after observed growth. At
least three observations spanning two minutes are required. These thresholds
are unvalidated hypotheses, not optimized settings or an expected return.

Exits: 10% loss from full cost, 25% profit, 12% trailing decline after a profitable
mark, or a 60-minute maximum holding period. Trades wait three seconds and obtain
fresh quotes. Buy/sell transaction counts do not identify distinct traders and
can be manipulated. A stop condition cannot guarantee a fill or limit losses.

Discovery uses DEX Screener's latest profiles, a selective/promotional sample,
not every Solana token and not a curated list of memecoins. Arbitrary token names
are treated as data. `watchMints` can add explicit mint addresses. Candidates
must use ordinary SPL tokens with no mint/freeze authority. Token-2022 tokens
are excluded. The largest token account must hold at most 35% of supply; pool
vaults are included, so this conservative check can reject legitimate markets.
Missing holder data means no entry. These checks do not prove a token safe.

## Quote and cost model

This machine uses Jupiter Swap v2 through its official keyless access, enabled
with `JUPITER_KEYLESS=1`. No account, API key, or paid plan is needed. Order
requests are serialized at least 2.1 seconds apart, below the published keyless
30 requests per 60-second window. This pacing is per worker, so other processes
sharing the connection can still cause HTTP 429. Failed requests are surfaced;
there is no automatic provider fallback. An optional `JUPITER_API_KEY` takes
precedence and uses conservative 1.1-second spacing for the free tier.

Without either setting, paper quotes use the public Raydium Trade API. Every fill records its
provider. Changing providers can alter outcomes; use a new experiment to compare
providers fairly. Route failures never become simulated successful trades.

Paper fills use the quoted minimum output at 1% slippage, then a further 0.5%
adverse adjustment. The model deducts $0.35 per buy for assumed network/account
costs and $0.02 per sell. Account creation costs are conservatively expensed and
never recovered in the model. These are assumptions, not measured network fees.
Entries require an estimated immediate round trip below both the configured 12%
cost ceiling and the 10% stop-loss threshold, including these assumptions. USDC is valued at USD parity; a depeg invalidates
this assumption. Paper fills cannot reproduce competition, liquidity removal,
provider delays or all transaction failures. The first 48 hours are an operational
trial, not proof of a profitable strategy.

## Live prerequisites and activation

Live mode is **not funded or mainnet-fill validated**. An offline fixture verifies
signing, preflight account checks, durable transaction intent, one submission,
finalized chain accounting, failed fees, and uncertain outcomes. That does not
establish that a specific live route will pass simulation or land successfully.

Use a dedicated Solana wallet funded with USDC plus SOL worth **no more than $20
combined**, leaving the rest of the $100 outside it. A practical initial composition
is up to $18 USDC plus SOL for fees, while respecting that combined cap. The wallet
must have at least 0.005 SOL; buys preserve that reserve. Initial funding is checked
at the observed SOL price. Purchases can debit at most 0.003 SOL per transaction
in addition to the $5 token input. No loans or leverage are supported.

Store the Solana CLI-format 64-byte keypair JSON outside the repository with
access limited to your user. Never paste recovery material into a chat or commit
it to Git. Set these in the local process environment:

- `JUPITER_KEYLESS`: `1` for the official keyless connection (already configured),
  or optionally `JUPITER_API_KEY` for a Jupiter Developer Platform API key.
- `SOLANA_RPC_URL`: your HTTPS Solana RPC endpoint supporting account reads,
  largest-account queries, transaction simulation and finalized transaction lookup.
- `SOLANA_KEYPAIR_PATH`: absolute path to that dedicated keypair file.
- `LIVE_TRADING`: `1` to explicitly activate real execution.

Then run:

```powershell
node src/cli.mjs doctor --mode live
node src/cli.mjs run --mode live
```

The paper supervisor never starts live mode. Live settings must be present on
every restart. Use `--mode live` for status and controls. Live operation uses
Jupiter v2's official order/execute endpoints. Only a single required wallet
signer is supported; routes requiring additional signers are rejected. The bot
simulates the transaction and checks intended token deltas, wallet authority,
unrelated holdings and SOL debit before signing. Wallet trading/deposits outside
the bot cause a balance mismatch and halt new activity.

The transaction signature is committed before broadcasting. The execute response
does not establish success; finalized chain balances do. An unknown transaction
remains pending and blocks subsequent orders across restarts. There is deliberately
no automatic replacement or command to discard that pending identity. Inspect the
signature and reconcile the ledger before continuing. A failed transaction records
the network fee and pauses for review. Token-account rent is part of measured SOL
cash movement; reclaiming old account rent is not implemented.

## Validation and limitations

See `docs/VERIFICATION.md` for the latest observed results. The original public
Solana endpoint returned HTTP 429 for `getTokenLargestAccounts`. The locally
configured Solana Vibe Station endpoint subsequently passed all four doctor
checks, including the 20 largest token accounts. Failed screening is still logged
and rejected; the bot does not bypass unavailable data to create activity.

`npm audit` currently reports four moderate findings in the web3.js dependency
tree (via jayson/stream-json/uuid). The application uses native fetch for RPC and
does not use jayson's streaming server. No incompatible forced downgrade or
unreviewed dependency override was applied. This remains a dependency maintenance
item before treating the live adapter as production-ready.

## Official interfaces used

- [DEX Screener API](https://docs.dexscreener.com/api/reference)
- [Raydium Trade API](https://docs.raydium.io/sdk-api/trade-api)
- [Jupiter Swap v2](https://developers.jup.ag/docs/swap/order-and-execute)
- [Jupiter access and rate limits](https://developers.jup.ag/docs/portal/rate-limits)
- [Solana RPC](https://solana.com/docs/rpc)

`src/config.mjs` defines validated parameters; `strategy.mjs` holds the entry/exit
hypothesis; `providers.mjs` reads public data; `engine.mjs` manages the experiment;
`live.mjs` handles optional signing and reconciliation; `store.mjs` owns SQLite;
`cli.mjs`, `operations.mjs` and `supervisor.mjs` provide local operation.
