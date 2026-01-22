# lst-rewards-indexer

A production-grade **token-agnostic** reward indexing and distribution engine.

This system snapshots on-chain balances of **any SPL token**, computes **time-weighted stake**, applies **configurable per-reward eligibility rules**, and produces **deterministic, multisig-ready payout artifacts**.

The pipeline is fully auditable, completely token-agnostic, and designed for human-controlled execution via Squads.

---

## What This Repo Does

- Snapshots any SPL token balances on a fixed cadence
- Computes time-weighted stake per wallet
- Supports single-week or multi-week reward consolidation
- Applies configurable eligibility rules per reward (optional)
- Calculates dust-safe payout amounts
- Exports CSVs for multisig execution
- **User-friendly CLI** for reward configuration
- **Merkle distribution system** for scalable payouts (1000+ recipients)

### Distribution Options

| Method | Best For | Multisig Overhead |
|--------|----------|-------------------|
| Direct Squads Transfers | ≤12 recipients (2 batches) | N proposals (batches of 6) |
| **Merkle Distribution** | 12+ recipients | 1 proposal total |

The Merkle distribution system uses an on-chain Anchor program to verify cryptographic proofs, enabling efficient distribution to thousands of recipients with minimal multisig signing overhead. For anything beyond 2 batches of direct transfers, Merkle is the recommended approach.

---

## High-Level Pipeline

```
Snapshots → Weights → Reward Config (single/multi-week) → Payout Computation → CSV Export → Multisig Execution
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
│   │   ├── process-pipeline.ts
│   │   ├── snapshot-runner.ts
│   │   └── scheduler.ts
│   ├── merkle/                   # Merkle distribution system
│   │   ├── types.ts              # Type definitions
│   │   ├── tree.ts               # Merkle tree construction
│   │   ├── builder.ts            # Distribution artifact builder
│   │   └── relayer.ts            # Claim submission relayer
│   └── jobs/                     # Batch jobs
│       ├── create-reward.ts      # CLI tool for rewards
│       ├── classify-wallets.ts
│       ├── materialize-weights.ts
│       ├── compute-reward-payouts.ts
│       ├── export-reward-csv.ts
│       ├── build-merkle-distribution.ts    # Build Merkle artifacts
│       ├── init-merkle-distribution.ts     # Create multisig proposals
│       ├── run-merkle-relayer.ts           # Process claims
│       └── test-merkle-devnet.ts           # End-to-end devnet test
├── programs/                     # On-chain Anchor programs
│   └── merkle-distributor/       # Merkle distribution program
│       ├── src/lib.rs            # Program logic
│       ├── Cargo.toml
│       └── README.md
├── db/                           # Database schemas and migrations
│   ├── schema.sql                # Core database schema
│   ├── merkle-schema.sql         # Merkle distribution tables
│   └── drop-all-tables.sql       # Clean slate script
├── distributions/                # Generated Merkle artifacts (gitignored)
├── exports/                      # Generated CSVs (gitignored)
├── keys/                         # Keypairs (gitignored, NEVER commit)
├── Anchor.toml                   # Anchor workspace config
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── OPERATOR_PLAYBOOK.md          # Detailed operator guide
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

# Squads Multisig (required for payout proposals)
SQUADS_MULTISIG=YourMultisigPDA
SQUAD_VAULT_ADDRESS=YourVaultPDA
SQUADS_MEMBER_KEYPAIR=./keys/id.json

# Direct Squads Transfers (optional - for small distributions)
MAX_TRANSFERS_PER_TX=6

# Merkle Distribution (recommended for 12+ recipients)
MERKLE_PROGRAM_ID=8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4
RELAYER_KEYPAIR=./keys/id.json

# Relayer Configuration (optional)
RELAYER_BATCH_SIZE=2          # Claims per transaction (2 recommended)
RELAYER_MAX_RETRIES=3         # Retry attempts for failed claims
RELAYER_RETRY_DELAY=2000      # Delay between retries (ms)
RELAYER_COMPUTE_UNITS=400000  # Compute units per transaction
RELAYER_COMPUTE_PRICE=1000    # Priority fee (micro-lamports)
```

**Configuration Notes:**
- `PRIMARY_TOKEN_MINT`: The token you're tracking (e.g., your LST)
- `ELIGIBILITY_TOKEN_MINT`: Optional requirement (leave empty/commented for no requirement)
- If no eligibility token is set, all primary token holders are eligible
- `RELAYER_BATCH_SIZE`: Set to 2 for optimal throughput; use 1 if transactions are failing due to size limits

Secrets and keypairs must **never** be committed.

---

## Database Overview

PostgreSQL is used as the authoritative ledger.

Key tables:

- `wallets` — discovered wallets + ownership classification
- `snapshots` — append-only balance history
- `weights` — time-weighted stake per window
- `reward_configs` — declarative reward definitions (supports single or multi-week ranges)
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

### Quick Start: Automated Pipeline (Recommended)

Run the entire data preparation pipeline with one command:

```bash
# Full pipeline (snapshot + processing)
npx ts-node src/runners/process-pipeline.ts

# Or skip snapshot if cron already ran it
npx ts-node src/runners/process-pipeline.ts --skip-snapshot
```

This automatically runs:
1. Snapshot balances (optional)
2. Classify wallets
3. Materialize weights

---

### Production Workflow

**For production with cron-based snapshots:**

1. **Set up cron** to run snapshots every 6 hours:
   ```bash
   npx ts-node src/runners/scheduler.ts
   ```

2. **Process data** when ready to create rewards:
   ```bash
   npx ts-node src/runners/process-pipeline.ts --skip-snapshot
   ```

3. **Create and distribute rewards** (see sections below)

---

### Manual Steps (Advanced)

If you need fine-grained control, run steps individually:

#### 1. Snapshot Balances

```bash
npx ts-node src/runners/snapshot-runner.ts
```

Or run continuously:

```bash
npx ts-node src/runners/scheduler.ts
```

---

#### 2. Classify Wallets

```bash
npx ts-node src/jobs/classify-wallets.ts
```

Marks wallets as system-owned or program-owned.

---

#### 3. Compute Weights

```bash
npx ts-node src/jobs/materialize-weights.ts
```

Computes time-weighted stake exposure per window.

---

### 4. Configure a Reward (CLI Tool)

Use the user-friendly CLI tool to create reward configurations:

```bash
# Interactive mode (recommended for beginners)
npx ts-node src/jobs/create-reward.ts

# Single-week reward (CLI mode)
npx ts-node src/jobs/create-reward.ts \
  --token ORE \
  --amount 7 \
  --window-start 2025-W51 \
  --window-end 2025-W51 \
  --label "ORE rewards - week 51"

# Multi-week consolidation (e.g., bi-weekly payout)
npx ts-node src/jobs/create-reward.ts \
  --token ORE \
  --amount 28 \
  --window-start 2025-W51 \
  --window-end 2025-W52 \
  --label "ORE rewards - weeks 51-52"

# With eligibility requirement
npx ts-node src/jobs/create-reward.ts \
  --token ORE \
  --amount 7 \
  --window-start 2025-W51 \
  --window-end 2025-W51 \
  --eligibility eligible-only \
  --eligibility-token ORE \
  --eligibility-amount 1

# No eligibility requirement (all holders get rewards)
npx ts-node src/jobs/create-reward.ts \
  --token USDC \
  --amount 1000 \
  --window-start 2025-W51 \
  --window-end 2025-W51 \
  --eligibility all-weighted

# List existing rewards
npx ts-node src/jobs/create-reward.ts --list

# Dry run (preview without saving)
npx ts-node src/jobs/create-reward.ts --token ORE --amount 7 --dry-run
```

**Window Consolidation:**
- Single-week: Set `--window-start` and `--window-end` to the same week
- Multi-week: Specify different start and end weeks to consolidate multiple weeks into one payout
- Benefits: Reduce multisig transaction overhead, batch bi-weekly or monthly rewards
- The system aggregates time-weighted stakes across the entire window range

**Supported eligibility modes:**
- `all-weighted`: All token holders receive rewards proportional to stake
- `eligible-only`: Only holders meeting eligibility requirements receive rewards

---

### 5. Compute Payout Previews

```bash
npx ts-node src/jobs/compute-reward-payouts.ts
```

- Aggregates time-weighted stakes across window ranges
- Applies eligibility rules
- Rounds conservatively
- Records dust explicitly

---

### 6. Export CSV for Execution

```bash
npx ts-node src/jobs/export-reward-csv.ts ORE_2025_W51
# Or for multi-week:
npx ts-node src/jobs/export-reward-csv.ts ORE_2025_W51_to_2025_W52
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

- Sign transactions automatically
- Move funds without multisig approval
- Encode governance decisions in code

### Two Execution Paths

**Option A: Direct Squads Transfers** (≤12 recipients)
- Export CSV → Create batched transfer proposals → Multisig approves → Funds sent

**Option B: Merkle Distribution** (12+ recipients, recommended)
- Export CSV → Build Merkle tree → Multisig approves single proposal → Relayer processes claims

See `OPERATOR_PLAYBOOK.md` for detailed instructions on both methods.

---

## Merkle Distribution Quick Start

For distributions with more than ~12 recipients, the Merkle system is more efficient:

```bash
# 1. Build Merkle distribution from CSV
npx ts-node src/jobs/build-merkle-distribution.ts exports/ORE_2025_W52.csv

# 2. Create multisig proposal (init + fund in single tx)
npx ts-node src/jobs/init-merkle-distribution.ts distributions/ORE_2025_W52_merkle.json

# 3. Approve and execute proposal in Squads UI

# 4. Run relayer to process claims
npx ts-node src/jobs/run-merkle-relayer.ts distributions/ORE_2025_W52_merkle.json
```

### Deployed Program

| Network | Program ID | IDL |
|---------|------------|-----|
| Mainnet | `8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4` | ✅ Published |
| Devnet | `8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4` | ✅ Published |

**Explorer:** [View on Solscan](https://solscan.io/account/8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4)

---

