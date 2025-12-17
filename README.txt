# GOBOG Gold Website (English + Phase Schedule in USDT)

Edit `config.json` only:
- TOKEN_ADDRESS
- PRESALE_ADDRESS
- USDT_ADDRESS
- CHAIN_ID (97 testnet / 56 mainnet)
- EXPLORER_BASE
- PRESALE_START_TIME (epoch seconds)

Phase schedule:
- Phases contain `duration_days`, `gobg_per_1_usdt`, and `usdt_per_gobg`.
- The conversion uses an implied rate: Phase 1 (1000 IDR/GOBG) == 1 USDT = 15 GOBG => 1 USDT ~ 15000 IDR.

Important:
- This schedule is UI labeling unless your presale smart contract enforces tiered pricing.
- `USE_PHASE_RATE_FOR_ESTIMATE` controls whether estimate follows phases.
