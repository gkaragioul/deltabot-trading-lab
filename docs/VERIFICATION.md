# Verification — 10 September 2026

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
