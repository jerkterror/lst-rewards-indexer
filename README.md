# lst-rewards-indexer

A production-grade indexing and reward calculation engine for **IndieSOL**, designed to support fair, auditable, and extensible reward distributions across multiple tokens.

This system snapshots on-chain balances, computes **time-weighted stake**, applies configurable eligibility rules, and produces **deterministic, multisig-ready reward outputs** for ORE, SOL, or any SPL token.

---

## Why This Exists

Reward systems that rely on point-in-time balances are easy to game.  
This project was built to ensure rewards are:

- **Fair** — resistant to short-term or just-in-time staking
- **Safe** — excludes program-owned vaults and unrecoverable addresses
- **Auditable** — every step is deterministic and inspectable
- **Extensible** — supports multiple reward tokens and partners
- **Human-controlled** — no hidden automation or irreversible steps

The system is intentionally designed to separate:
- **data collection**
- **math**
- **reward configuration**
- **execution artifacts**

Nothing moves on-chain without explicit review.

---

## High-Level Architecture

The pipeline is structured in clear, composable stages:

1. **Snapshot Indexing**
   - Periodically snapshots IndieSOL balances
   - Tracks ORE balances for eligibility
   - Appends immutable history

2. **Wallet Classification**
   - Classifies wallets as system-owned vs program-owned
   - Excludes vaults, PDAs, and protocol-owned accounts safely

3. **Weight Computation**
   - Computes **time-weighted IndieSOL stake**
   - Resistant to late staking
   - Window-based (e.g. weekly)

4. **Share Normalization**
   - Converts weights into normalized reward shares
   - Token-agnostic ratios

5. **Reward Configuration**
   - Manual, declarative reward definitions
   - Per-window, per-token, per-eligibility
   - No hard-coded assumptions

6. **Payout Preview**
   - Computes per-wallet payouts
   - Conservative rounding (never overpays)
   - Explicit dust accounting with carry-forward

7. **CSV Export**
   - Multisig-ready execution artifacts
   - Human-reviewable
   - Deterministic

---

## Core Design Principles

- **Append-only data** — snapshots and weights are never mutated
- **Idempotent jobs** — safe to re-run at every stage
- **Explicit eligibility** — applied per reward, not globally
- **Program-safe payouts** — system-owned wallets only by default
- **Dust transparency** — no silent rounding or loss
- **No hidden automation** — humans stay in control

---

## Repository Structure

```
lst-rewards-indexer/
├── src/
│   ├── db.ts                 # Postgres connection
│   ├── indexers/             # On-chain indexing logic
│   │   └── snapshot.ts
│   ├── runners/              # Entry points / schedulers
│   │   ├── snapshot-runner.ts
│   │   └── scheduler.ts
│   └── jobs/                 # Batch + manual jobs
│       ├── classify-wallets.ts
│       ├── materialize-weights.ts
│       ├── normalize-reward-shares.ts
│       ├── compute-reward-payouts.ts
│       └── export-reward-csv.ts
├── exports/                  # Generated CSVs (gitignored)
├── .env                      # Local env vars (gitignored)
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Environment Setup

### Requirements

- Node.js 18+
- PostgreSQL 16
- Solana RPC endpoint (Helius recommended)

### Environment Variables

Create a `.env` file locally:

```env
DATABASE_URL=postgres://postgres:password@localhost:65432/lst_rewards
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

---

## Database

The system uses PostgreSQL as an **authoritative ledger**.

Key tables include:

- `wallets` — discovered wallets + ownership classification
- `snapshots` — append-only balance history
- `weights` — time-weighted stake per window
- `reward_shares` — normalized ratios
- `reward_configs` — declarative reward definitions
- `reward_payouts_preview` — derived payout previews
- `reward_dust_ledger` — explicit dust accounting

All schema changes are additive and auditable.

---

## Running the System

### 1. Snapshot Indexing (Manual)

```bash
npx ts-node src/runners/snapshot-runner.ts
```

### 2. Snapshot Scheduler (Local / VM)

```bash
npx ts-node src/runners/scheduler.ts
```

Runs every 6 hours with built-in window guards.

---

### 3. Wallet Classification

```bash
npx ts-node src/jobs/classify-wallets.ts
```

Classifies wallets as system-owned vs program-owned (cached permanently).

---

### 4. Compute Weights

```bash
npx ts-node src/jobs/materialize-weights.ts
```

Computes time-weighted stake per wallet per window.

---

### 5. Normalize Shares

```bash
npx ts-node src/jobs/normalize-reward-shares.ts
```

Produces normalized reward shares (ratios).

---

### 6. Configure a Reward (Manual)

Example (ORE):

```sql
INSERT INTO reward_configs (
  reward_id,
  window_id,
  mint,
  total_amount,
  eligibility_mode,
  label
) VALUES (
  'ORE_W51',
  '2025-W51',
  'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp',
  7000000000,
  'eligible_only',
  'ORE rewards – week 51'
);
```

---

### 7. Compute Payout Previews (Dust-Aware)

```bash
npx ts-node src/jobs/compute-reward-payouts.ts
```

- Applies eligibility rules
- Uses carry-forward dust
- Never overpays

---

### 8. Export CSV for Execution

```bash
npx ts-node src/jobs/export-reward-csv.ts ORE_W51
```

Outputs:

```
exports/ORE_W51.csv
```

This file is multisig-ready and reviewable.

---

## Dust Handling Policy

- All payouts are conservatively rounded **down**
- Any remainder (“dust”) is recorded explicitly
- Dust is **carried forward** to the next reward for the same token
- No silent loss, no hidden treasury behavior

This keeps long-term fairness and auditability.

---

## What This System Does *Not* Do

- ❌ Automatically move tokens
- ❌ Sign transactions
- ❌ Hide logic behind automation
- ❌ Assume a single reward token
- ❌ Require governance decisions to be encoded in code

Execution is always an explicit, human-reviewed step.

---

## Intended Use

This system is suitable for:

- IndieSOL reward distributions
- Validator-aligned incentive programs
- Partner reward campaigns
- Multi-token reward experiments
- Transparent, auditable emissions

---

## Status

- Core reward engine: **complete**
- Snapshot + math pipeline: **stable**
- CSV execution artifacts: **ready**
- VM deployment: optional / next step
- UI: out of scope (by design)

---

## License / Ownership

Internal infrastructure for the IndieSOL / Layer33 ecosystem.  
Usage, redistribution, or extension should align with project governance.

---

## Questions / Extensions

This system is intentionally modular.  
Future extensions may include:

- VM deployment
- SOL-native rewards
- Partner onboarding docs
- Operational runbooks
- Dashboard / read-only UI

All can be built without changing the core math.

