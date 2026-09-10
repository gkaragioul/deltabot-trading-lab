# Coinbase Automation Implementation Plan

Goal: a runnable Coinbase spot trading tool with paper operation and a separately
activated live adapter, exact accounting, durable recovery and clear reporting.
Architecture and constraints: [COINBASE-DESIGN.md](COINBASE-DESIGN.md).
Execution: inline using the existing approved scope and test-driven workflow.

1. API and arithmetic (`src/cb/api.mjs`, `decimal.mjs`, `config.mjs`).
   Add tests for ES256 method/path binding, endpoint restrictions, decimal floor
   sizing, invalid configuration, fees and product filtering. Extend existing
   signing without widening the old read-only connection. Validate real account
   fee/product reads. Writes remain disabled by default.
2. Market and execution (`market.mjs`, `execution.mjs`).
   Test closed-candle filtering, stale depth rejection, bounded IOC construction,
   partial fills, one-submit recovery and trade-owned balance accounting. Add
   preview verification and terminal settlement based on actual order totals.
3. Engine (`engine.mjs`).
   Test budget, per-day entry limit, daily loss/drawdown, fees, pause/flatten,
   preservation across restarts, exit handling during discovery outages, and
   recheck of controls immediately before any submit.
4. Operations (`cli.mjs`, `report.mjs`, `supervisor.mjs`, PowerShell launchers).
   Provide explicit paper/live modes and distinct runtimes. Add public-data replay
   and Markdown dashboard. Test the CLI lifecycle, start paper, verify worker
   state and logs. Never use a live-run command during development.
5. Independent review and verification.
   Reviewer inspects the completed implementation and tests; fix material issues
   with regressions. Run full tests, real read/preview checks and historical replay.
   Commit reviewed source; report measured outcomes and remaining live limits.

Implementation complete for steps 1–4. Review fixes include definitive fill
accounting during account outages, baseline-protected exits, fee-outage exit
management, fresh final guards, conservative UTC-day rollover before settlement,
shared live-worker exclusion, durable shutdown and explicit read-only recovery.
Final verification and operational observations are recorded in VERIFICATION.md.
