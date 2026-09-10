# Memecoin Lab Implementation Plan

**Goal:** Build and run the approved quote-backed Solana trading experiment.
**Architecture:** Independent Node service; providers, strategy, execution, ledger,
and operations separated. SQLite is the authoritative state and event store.
**Tech stack:** Node 24, built-in SQLite/test runner, Solana web3.js.
**Spec:** DESIGN.md. Execute inline; authorization is already present.

## Constraints
Paper default; $20 active/$80 reserve; $5/order; two positions; $10 loss pause.
No changes to existing services, no credential discovery, no paid services.

## Tasks
- [x] Ledger and risk: `src/config.mjs`, `src/store.mjs`, `src/strategy.mjs`.
  First test restart durability, malformed values, concentration rejection,
  bounded observation history, and peak-to-current account drawdown.
  Run `node --test test/core.test.mjs`; implement until assertions pass.
- [x] Providers and paper execution: `src/providers.mjs`, `src/engine.mjs`.
  Test HTTP failures, schema mismatches, duplicate candidates, delayed quote fills,
  exact token amounts, cost deductions, rejected exits, and persisted cooldowns.
  Run `node --test test/engine.test.mjs test/providers.test.mjs`.
- [x] Live execution: `src/live.mjs`. Test hard activation/configuration gates,
  transaction input/output validation, durable pending transaction recovery,
  actual chain deltas, and ambiguous submission preventing repeat buys.
  Run `node --test test/live.test.mjs`.
- [x] Operations: `src/cli.mjs`, start/stop scripts, README, generated report.
  Test competing worker lock, stop with open positions, bounded run, status,
  configuration mismatch rejection, and replay/restart operation.
- [x] Full verification: run all tests, dependency audit, inspect diffs, perform
  public API smoke checks and start a paper worker. Record real observed health
  and remaining live prerequisites. Never label simulated gains as earnings.
