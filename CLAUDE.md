# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn dev              # Run in development mode (tsx, hot reload)
yarn build            # Install deps, lint, and compile TypeScript to dist/
yarn start            # Build then run (production)
yarn lint             # Lint and auto-fix with Biome
yarn docker           # Build Docker image (linux/amd64)
yarn docker:run       # Run Docker container with .env file
```

No test suite exists in this repo.

## Architecture

This is an **order fulfillment bot** for the Pyra protocol on Solana. It automatically fulfills time-locked operations (withdrawals, spend limit updates) and processes deposit address balances. The `@quartz-labs` npm packages are the Pyra SDK (Quartz was the old name).

### Entry Flow

`src/index.ts` → instantiates `FillBot` → calls `bot.start()`

### Core Components

- **`src/bot.ts`** — `FillBot` class. Runs three concurrent loops:
  1. **Event listener** — subscribes to on-chain logs for `InitiateWithdrawDrift` and `InitiateUpdateSpendLimits` instructions, schedules immediate order processing
  2. **Open orders loop** (every 2.5 min) — fetches all open orders via API (RPC fallback), filters for orders past their release slot, schedules processing
  3. **Deposit addresses loop** (every 90s) — fetches deposit addresses with token balances via API (RPC fallback), builds and sends deposit fulfillment transactions

- **`src/utilts/helpers.ts`** — Transaction building, API data fetching (with RPC fallback), order filtering, compute budget helpers. Note the `utilts` typo in the directory name is intentional/legacy.

- **`src/config/config.ts`** — Zod-validated environment config
- **`src/config/constants.ts`** — Minimum SOL balance threshold (0.3 SOL)
- **`src/types/`** — Interfaces for API responses (orders, vaults/deposits)

### Key Patterns

- **API-first with RPC fallback**: Data fetching tries the Pyra API first, falls back to on-chain RPC calls if the API fails
- **Simulation before send**: Transactions are simulated before submitting to prevent failed on-chain transactions
- **Jitter on order processing**: 10s random delay to prevent race conditions when multiple bot instances process the same order
- **Expected error classification**: Known error conditions (insufficient funds, old vaults, etc.) are caught and skipped gracefully rather than retried
- **Gas fee ceiling**: Max 0.01 SOL per transaction; transactions exceeding this are skipped

### Key Dependencies

- `@quartz-labs/sdk` — Pyra protocol SDK for account/order management and instruction building
- `@quartz-labs/connection` — RPC connection pooling wrapper
- `@quartz-labs/logger` — Logging with daily error caching and email alerts
- `@solana/web3.js` / `@solana/spl-token` — Solana blockchain interaction

## Environment Variables

Required:
- `FILLER_KEYPAIR` — Base58-encoded Solana private key
- `RPC_URLS` — Comma-separated HTTPS RPC endpoints

Optional:
- `INTERNAL_API_URL` — Pyra API base URL (defaults to `http://internal.api.quartzpay.io/`)
- `EMAIL_TO`, `EMAIL_FROM`, `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASSWORD` — SMTP config for low-balance alerts

## Deployment

- Kubernetes on GKE (`deploy/prod/`), 2 replicas with rolling updates
- CI/CD via GitHub Actions: push to `main` → build Docker image → deploy to GKE
- Secrets (keypair, RPC URLs, email password) managed via Kubernetes secrets

## Tooling

- **Biome** for linting/formatting (tabs, import extension enforcement)
- **TypeScript** strict mode, ES2022 target, NodeNext modules
- **Yarn** package manager with frozen lockfile
