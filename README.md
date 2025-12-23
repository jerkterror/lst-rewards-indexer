# lst-rewards-indexer

A production-grade **token-agnostic** reward indexing and distribution engine.

This system snapshots on-chain balances of **any SPL token**, computes **time-weighted stake**, applies **configurable per-reward eligibility rules**, and produces **deterministic, multisig-ready payout artifacts**.

The pipeline is fully auditable, completely token-agnostic, and designed for human-controlled execution via Squads.

---

## What This Repo Does

- Snapshots any SPL token balances on a fixed cadence
- Computes time-weighted stake per wallet
- Normalizes stake into reward shares
- Applies configurable eligibility rules per reward (optional)
- Calculates dust-safe payout amounts
- Exports CSVs for multisig execution
- **User-friendly CLI** for reward configuration

Nothing is ever sent on-chain automatically.

---

## High-Level Pipeline

```
Snapshots → Weights → Shares → Reward Config → Payout Preview → CSV Export → Multisig Execution
```

## Repository Structure

```
lst-rewards-indexer/
├── src/
│   ├── db.ts                     # Postgres connection
│   ├── config/                   # Configuration
│   │   └── tokens.ts             # Token registry
│   ├── indexers/                 # On-chain indexing logic
│   │   └── snapshot.ts
│   ├── runners/                  # Entry points / schedulers
│   │   ├── snapshot-runner.ts
│   │   └── scheduler.ts
│   └── jobs/                     # Batch jobs
│       ├── create-reward.ts      # CLI tool for rewards
│       ├── classify-wallets.ts
│       ├── materialize-weights.ts
│       ├── normalize-reward-shares.ts
│       ├── compute-reward-payouts.ts
│       └── export-reward-csv.ts
├── db/                           # Database schemas and migrations
│   ├── schema.sql                # Full database schema
│   └── drop-all-tables.sql       # Clean slate script
├── exports/                      # Generated CSVs (gitignored)
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Requirements

- Node.js 18+
- PostgreSQL 16+
- Solana RPC endpoint (Helius recommended)

---

## Environment Setup

Create a local `.env` file:

```env
# Database
DATABASE_URL=postgres://user:password@localhost:5432/lst_rewards

# Solana RPC
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY

# Token Configuration
# Primary token being tracked (the LST you're rewarding holders of)
PRIMARY_TOKEN_MINT=L33mHftsNpaj39z1omnGbGbuA5eKqSsbmr91rjTod48
PRIMARY_TOKEN_SYMBOL=INDIESOL

# Eligibility token (OPTIONAL - leave empty for no requirement)
# This determines who is eligible to receive rewards
ELIGIBILITY_TOKEN_MINT=oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp
ELIGIBILITY_TOKEN_SYMBOL=ORE
ELIGIBILITY_TOKEN_MIN_AMOUNT=1000000000  # 1 ORE (9 decimals)

# Squads Multisig (optional - only for payout proposals)
SQUADS_MULTISIG=
SQUAD_VAULT_ADDRESS=
SQUADS_MEMBER_KEYPAIR=

# Optional
MAX_TRANSFERS_PER_TX=6
```

**Configuration Notes:**
- `PRIMARY_TOKEN_MINT`: The token you're tracking (e.g., your LST)
- `ELIGIBILITY_TOKEN_MINT`: Optional requirement (leave empty/commented for no requirement)
- If no eligibility token is set, all primary token holders are eligible

Secrets and keypairs must **never** be committed.

---

## Database Overview

PostgreSQL is used as the authoritative ledger.

Key tables:

- `wallets` — discovered wallets + ownership classification
- `snapshots` — append-only balance history
- `weights` — time-weighted stake per window
- `reward_shares` — normalized stake ratios
- `reward_configs` — declarative reward definitions
- `reward_payouts_preview` — computed payout amounts
- `reward_dust_ledger` — explicit dust accounting

All data is append-only or idempotent.

---

## Database Setup

### Initial Setup

Initialize the database schema using the provided SQL file:

```bash
# Using psql directly
psql -d your_database_name -f db/schema.sql

# Or with Docker (if using Docker PostgreSQL)
docker cp db/schema.sql your-postgres-container:/tmp/schema.sql
docker exec -i your-postgres-container psql -U postgres -d lst_rewards -f /tmp/schema.sql
```

### Reset Database (Fresh Start)

To wipe all data and start fresh:

```bash
# Using psql directly
psql -d your_database_name -f db/drop-all-tables.sql
psql -d your_database_name -f db/schema.sql

# Or with Docker
docker cp db/drop-all-tables.sql your-postgres-container:/tmp/drop-all-tables.sql
docker cp db/schema.sql your-postgres-container:/tmp/schema.sql
docker exec -i your-postgres-container psql -U postgres -d lst_rewards -f /tmp/drop-all-tables.sql
docker exec -i your-postgres-container psql -U postgres -d lst_rewards -f /tmp/schema.sql
```

---

## Running the Pipeline

### 1. Snapshot Balances

```bash
npx ts-node src/runners/snapshot-runner.ts
```

Or run continuously:

```bash
npx ts-node src/runners/scheduler.ts
```

---

### 2. Classify Wallets

```bash
npx ts-node src/jobs/classify-wallets.ts
```

Marks wallets as system-owned or program-owned.

---

### 3. Compute Weights

```bash
npx ts-node src/jobs/materialize-weights.ts
```

Computes time-weighted IndieSOL exposure per window.

---

### 4. Normalize Shares

```bash
npx ts-node src/jobs/normalize-reward-shares.ts
```

Converts weights into normalized reward shares.

---

### 5. Configure a Reward (CLI Tool)

Use the user-friendly CLI tool to create reward configurations:

```bash
# Interactive mode (recommended for beginners)
npx ts-node src/jobs/create-reward.ts

# CLI mode (for scripting)
npx ts-node src/jobs/create-reward.ts \
  --token ORE \
  --amount 7 \
  --window 2025-W51 \
  --label "ORE rewards - week 51"

# With eligibility requirement
npx ts-node src/jobs/create-reward.ts \
  --token ORE \
  --amount 7 \
  --eligibility eligible-only \
  --eligibility-token ORE \
  --eligibility-amount 1

# No eligibility requirement (all holders get rewards)
npx ts-node src/jobs/create-reward.ts \
  --token USDC \
  --amount 1000 \
  --eligibility all-weighted

# List existing rewards
npx ts-node src/jobs/create-reward.ts --list

# Dry run (preview without saving)
npx ts-node src/jobs/create-reward.ts --token ORE --amount 7 --dry-run
```

**Supported eligibility modes:**
- `all-weighted`: All token holders receive rewards proportional to stake
- `eligible-only`: Only holders meeting eligibility requirements receive rewards

---

### 6. Compute Payout Previews

```bash
npx ts-node src/jobs/compute-reward-payouts.ts
```

- Applies eligibility rules
- Rounds conservatively
- Records dust explicitly

---

### 7. Export CSV for Execution

```bash
npx ts-node src/jobs/export-reward-csv.ts ORE_W51
```

Outputs a multisig-ready CSV in `exports/`.

---

## Dust Handling

- All payouts are rounded **down**
- Remainders are tracked per reward
- Dust is carried forward to the next reward of the same mint

No silent loss and no overpayment.

---

## Execution Model

This system **does not**:

- Sign transactions
- Move funds automatically
- Encode governance decisions in code

Execution is performed separately via a Squads multisig using the exported CSVs.

---

