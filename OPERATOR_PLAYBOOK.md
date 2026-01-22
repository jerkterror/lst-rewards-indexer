# LST Rewards Indexer — Operator Playbook

## Table of Contents
1. [Overview](#overview)
2. [Environment Setup](#environment-setup)
3. [Database Setup](#database-setup)
4. [Understanding the Scheduler](#understanding-the-scheduler)
5. [Running the Pipeline](#running-the-pipeline)
6. [Job Reference](#job-reference)
7. [Create Reward Tool — Complete Guide](#create-reward-tool--complete-guide)
8. [Squads Multisig Payouts](#squads-multisig-payouts)
9. [Useful Database Queries](#useful-database-queries)

---

## Overview

The LST Rewards Indexer is a **token-agnostic** Solana rewards distribution system that:
- Takes periodic snapshots of token holder balances
- Computes time-weighted stakes
- Distributes rewards proportionally to eligible wallets
- Handles dust carry-forward across reward periods

**Workflow:**
```
Snapshot → Classify Wallets → Materialize Weights → Create Reward → Compute Payouts → Export CSV → (Optional) Squads Payout
```

---

## Environment Setup

Create a `.env` file in the project root:

```env
# Required - Solana RPC
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Required - PostgreSQL connection
DATABASE_URL=postgresql://user:password@localhost:5432/lst_rewards

# Required - Primary token to track (the LST)
PRIMARY_TOKEN_MINT=L33mHftsNpaj39z1omnGbGbuA5eKqSsbmr91rjTod48
PRIMARY_TOKEN_SYMBOL=INDIESOL

# Optional - Eligibility token requirement (e.g., must hold ORE to qualify)
ELIGIBILITY_TOKEN_MINT=oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp
ELIGIBILITY_TOKEN_SYMBOL=ORE
ELIGIBILITY_TOKEN_MIN_AMOUNT=1000000000  # 1 ORE (9 decimals)

# Optional - For Squads multisig payouts
SQUADS_MULTISIG=YourMultisigPDA
SQUAD_VAULT_ADDRESS=YourVaultAddress
SQUADS_MEMBER_KEYPAIR=./keys/id.json
MAX_TRANSFERS_PER_TX=6
```

### Configuration: Known Tokens

The token registry in `src/config/tokens.ts` contains pre-configured tokens:

| Symbol | Mint | Decimals |
|--------|------|----------|
| INDIESOL | `L33mHftsNpaj39z1omnGbGbuA5eKqSsbmr91rjTod48` | 9 |
| ORE | `oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp` | 9 |
| SOL | `So11111111111111111111111111111111111111112` | 9 |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | 6 |

---

## Database Setup

### Initial Setup

```bash
# Create database
createdb lst_rewards

# Run schema
psql -d lst_rewards -f db/schema.sql
```

### Reset Database (DESTRUCTIVE)

```bash
psql -d lst_rewards -f db/drop-all-tables.sql
psql -d lst_rewards -f db/schema.sql
```

### Tables Overview

| Table | Purpose |
|-------|---------|
| `wallets` | Discovered token holders and their system/program ownership classification |
| `snapshots` | Append-only ledger of balance snapshots |
| `weights` | Time-weighted stake per wallet per window |
| `reward_shares` | Normalized shares (0-1) derived from weights |
| `reward_configs` | Reward definitions (created via CLI) |
| `reward_payouts_preview` | Computed payout amounts (can be recomputed) |
| `reward_dust_ledger` | Authoritative dust accounting (append-only, never modify) |

---

## Understanding the Scheduler

The scheduler (`src/runners/scheduler.ts`) runs snapshots automatically using `node-cron`.

### Current Configuration

```typescript
cron.schedule('0 */6 * * *', async () => { ... });
```

**Schedule:** Every 6 hours at minute 0 (`0:00`, `6:00`, `12:00`, `18:00` UTC)

### Running the Scheduler

```bash
npx ts-node src/runners/scheduler.ts
```

This process runs indefinitely and takes snapshots at the scheduled intervals.

### Testing with 1-minute Interval

Uncomment the test schedule in `scheduler.ts`:
```typescript
// cron.schedule('* * * * *', async () => {  // Every minute
cron.schedule('0 */6 * * *', async () => {   // Every 6 hours (production)
```

---

## Running the Pipeline

The **recommended way** to prepare data for rewards is the unified pipeline runner:

```bash
npx ts-node src/runners/process-pipeline.ts
```

### Pipeline Steps

1. **Snapshot** — Captures current token balances
2. **Classify Wallets** — Identifies system-owned vs program-owned wallets
3. **Materialize Weights** — Computes time-weighted stakes

### Flags

| Flag | Description |
|------|-------------|
| `--skip-snapshot` | Skip the snapshot step (use existing data) |
| `--force` | Force recomputation (not currently implemented) |

### Examples

```bash
# Full pipeline
npx ts-node src/runners/process-pipeline.ts

# Skip snapshot (just process existing data)
npx ts-node src/runners/process-pipeline.ts --skip-snapshot
```

---

## Job Reference

### 1. Snapshot Runner (`snapshot-runner.ts`)

**Purpose:** Takes a one-time snapshot of all token holder balances.

```bash
npx ts-node src/runners/snapshot-runner.ts
```

**What it does:**
- Fetches all holders of `PRIMARY_TOKEN_MINT`
- Optionally fetches eligibility token balances
- Persists snapshot records with ISO week `window_id` (e.g., `2025-W52`)

---

### 2. Classify Wallets (`classify-wallets.ts`)

**Purpose:** Determines if wallets are system-owned (eligible for rewards) or program-owned (PDAs, excluded).

```bash
npx ts-node src/jobs/classify-wallets.ts
```

**What it does:**
- Queries wallets where `is_system_owned IS NULL`
- Batches RPC calls (100 wallets per call)
- Updates `wallets.is_system_owned` column

**Why it matters:** Only system-owned wallets receive rewards. Program-owned wallets (PDAs, vaults, etc.) are excluded.

---

### 3. Materialize Weights (`materialize-weights.ts`)

**Purpose:** Computes time-weighted stake for each wallet per window.

```bash
npx ts-node src/jobs/materialize-weights.ts
```

**Formula:**
```
weight = SUM(primary_token_amount × seconds_held)
```

The system assumes 6-hour snapshot intervals. For the last snapshot in a window, it assumes the balance was held for 6 hours.

---

### 4. Normalize Reward Shares (`normalize-reward-shares.ts`)

**Purpose:** Converts weights to normalized shares (0-1).

```bash
npx ts-node src/jobs/normalize-reward-shares.ts
```

**Formula:**
```
share = wallet_weight / total_weight_for_window
```

---

### 5. Compute Reward Payouts (`compute-reward-payouts.ts`)

**Purpose:** Calculates actual payout amounts for all configured rewards.

```bash
npx ts-node src/jobs/compute-reward-payouts.ts
```

**What it does:**
- Processes all `reward_configs` in creation order
- Handles dust carry-forward from previous rewards of the same mint
- Writes to `reward_payouts_preview` and `reward_dust_ledger`
- Idempotent: skips rewards already in `reward_dust_ledger`

**Dust Handling:**
```
effective_total = configured_total + carry_in
carry_out = effective_total - SUM(FLOOR(share × effective_total))
```

---

### 6. Export Reward CSV (`export-reward-csv.ts`)

**Purpose:** Exports payout data to CSV for external processing.

```bash
npx ts-node src/jobs/export-reward-csv.ts <REWARD_ID>
```

**Example:**
```bash
npx ts-node src/jobs/export-reward-csv.ts ORE_2025_W52
```

**Output:** `exports/<REWARD_ID>.csv` with columns:
- `wallet`
- `mint`
- `amount` (raw units)
- `reward_id`
- `window_id`

---

### 7. Squads Create Payout Proposals (`squads-create-payout-proposals.ts`)

**Purpose:** Creates Squads multisig proposals to distribute rewards.

```bash
npx ts-node src/jobs/squads-create-payout-proposals.ts <csv-path>
```

**Required Environment Variables:**
- `SQUADS_MULTISIG` — Multisig PDA address
- `SQUAD_VAULT_ADDRESS` — Vault authority address
- `SQUADS_MEMBER_KEYPAIR` — Path to member keypair file
- `MAX_TRANSFERS_PER_TX` — Transfers per transaction (default: 6)

**Example:**
```bash
npx ts-node src/jobs/squads-create-payout-proposals.ts exports/ORE_2025_W52.csv
```

---

## Create Reward Tool — Complete Guide

The `create-reward.ts` script is the primary way to configure reward distributions.

### Basic Usage

```bash
# Interactive mode
npx ts-node src/jobs/create-reward.ts

# List existing rewards
npx ts-node src/jobs/create-reward.ts --list
```

### All Command-Line Flags

| Flag | Description | Example |
|------|-------------|---------|
| `--token` | Reward token symbol | `--token ORE` |
| `--amount` | Reward amount (human-readable) | `--amount 7` |
| `--window-start` | Start of window range (YYYY-WNN) | `--window-start 2025-W50` |
| `--window-end` | End of window range (YYYY-WNN) | `--window-end 2025-W52` |
| `--eligibility` or `--eligibility-mode` | `all-weighted` or `eligible-only` | `--eligibility all-weighted` |
| `--eligibility-token` | Token required for eligibility | `--eligibility-token ORE` |
| `--eligibility-amount` | Minimum balance required | `--eligibility-amount 1` |
| `--label` | Human-readable description | `--label "Week 52 ORE rewards"` |
| `--reward-id` | Custom reward ID | `--reward-id ORE_W52_CUSTOM` |
| `--dry-run` | Preview without saving | `--dry-run` |
| `--list` | List recent rewards | `--list` |

### Interactive Prompts

When running without flags, the tool prompts for:

1. **Token symbol** — Select from known tokens (INDIESOL, ORE, SOL, USDC, USDT)
2. **Amount** — Human-readable amount (e.g., `7` for 7 tokens)
3. **Window configuration** — Current week or custom range
4. **Eligibility mode** — Type `a` for all-weighted or `e` for eligible-only
5. **Eligibility requirements** — If eligible-only, specify token and minimum amount
6. **Label** — Description for the reward
7. **Reward ID** — Unique identifier

### Eligibility Modes

| Mode | Description |
|------|-------------|
| `all-weighted` (a) | All wallets receive rewards proportional to their time-weighted stake |
| `eligible-only` (e) | Only wallets meeting eligibility criteria receive rewards |

### Examples

**Single Week, All Wallets:**
```bash
npx ts-node src/jobs/create-reward.ts \
  --token ORE \
  --amount 7 \
  --window-start 2025-W52 \
  --eligibility all-weighted \
  --label "ORE Week 52"
```

**Multi-Week Range:**
```bash
npx ts-node src/jobs/create-reward.ts \
  --token ORE \
  --amount 21 \
  --window-start 2025-W50 \
  --window-end 2025-W52 \
  --eligibility all-weighted \
  --label "ORE Weeks 50-52 combined"
```

**Eligible-Only (Must Hold 1 ORE):**
```bash
npx ts-node src/jobs/create-reward.ts \
  --token USDC \
  --amount 100 \
  --window-start 2025-W52 \
  --eligibility eligible-only \
  --eligibility-token ORE \
  --eligibility-amount 1 \
  --label "USDC bonus for ORE holders"
```

**Dry Run (Preview Only):**
```bash
npx ts-node src/jobs/create-reward.ts \
  --token ORE \
  --amount 7 \
  --dry-run
```

**Interactive Mode:**
```bash
npx ts-node src/jobs/create-reward.ts
# Follow prompts:
# - Enter token: ORE
# - Enter amount: 7
# - Choose window: 1 (current week)
# - Eligibility mode: a (all-weighted)
# - Confirm: y
```

---

## Squads Multisig Payouts

For treasury management via Squads multisig:

### Setup

1. Configure environment:
```env
SQUADS_MULTISIG=YourMultisigPDA
SQUAD_VAULT_ADDRESS=YourVaultPDA
SQUADS_MEMBER_KEYPAIR=./keys/id.json
MAX_TRANSFERS_PER_TX=6
```

2. Export the reward CSV:
```bash
npx ts-node src/jobs/export-reward-csv.ts ORE_2025_W52
```

3. Create proposals:
```bash
npx ts-node src/jobs/squads-create-payout-proposals.ts exports/ORE_2025_W52.csv
```

### Batching

The script automatically batches transfers to fit within Solana's transaction size limits. Each batch becomes a separate multisig proposal.

---

## Useful Database Queries

### Snapshot Queries

**Most Recent Snapshot:**
```sql
SELECT * FROM snapshots
ORDER BY ts DESC
LIMIT 1;
```

**Recent Snapshots (Last 10):**
```sql
SELECT
  id,
  wallet,
  primary_token_amount,
  eligible,
  window_id,
  ts
FROM snapshots
ORDER BY ts DESC
LIMIT 10;
```

**Snapshots Per Window:**
```sql
SELECT
  window_id,
  COUNT(*) as snapshot_count,
  COUNT(DISTINCT wallet) as unique_wallets,
  MIN(ts) as first_snapshot,
  MAX(ts) as last_snapshot
FROM snapshots
GROUP BY window_id
ORDER BY window_id DESC;
```

**Latest Snapshot Per Wallet:**
```sql
SELECT DISTINCT ON (wallet)
  wallet,
  primary_token_amount,
  eligible,
  window_id,
  ts
FROM snapshots
ORDER BY wallet, ts DESC;
```

---

### Wallet Queries

**All Current Wallets:**
```sql
SELECT
  wallet,
  first_seen,
  is_system_owned
FROM wallets
ORDER BY first_seen DESC;
```

**System-Owned Wallets (Eligible for Rewards):**
```sql
SELECT wallet, first_seen
FROM wallets
WHERE is_system_owned = true
ORDER BY first_seen DESC;
```

**Unclassified Wallets:**
```sql
SELECT wallet, first_seen
FROM wallets
WHERE is_system_owned IS NULL;
```

**Wallet Classification Summary:**
```sql
SELECT
  CASE
    WHEN is_system_owned = true THEN 'System-owned (eligible)'
    WHEN is_system_owned = false THEN 'Program-owned (excluded)'
    ELSE 'Unclassified'
  END as status,
  COUNT(*) as count
FROM wallets
GROUP BY is_system_owned;
```

---

### Weight Queries

**Top Holders by Weight (Current Window):**
```sql
SELECT
  wallet,
  weight,
  window_id
FROM weights
WHERE window_id = (SELECT MAX(window_id) FROM weights)
ORDER BY weight DESC
LIMIT 20;
```

**Weight Distribution Per Window:**
```sql
SELECT
  window_id,
  COUNT(*) as wallet_count,
  SUM(weight) as total_weight,
  AVG(weight) as avg_weight,
  MIN(weight) as min_weight,
  MAX(weight) as max_weight
FROM weights
GROUP BY window_id
ORDER BY window_id DESC;
```

---

### Reward Queries

**All Configured Rewards:**
```sql
SELECT
  reward_id,
  window_start,
  window_end,
  mint,
  total_amount,
  eligibility_mode,
  label,
  created_at
FROM reward_configs
ORDER BY created_at DESC;
```

**Reward Status (Processed vs Pending):**
```sql
SELECT
  r.reward_id,
  r.window_start,
  r.window_end,
  r.label,
  CASE
    WHEN d.reward_id IS NOT NULL THEN 'Processed'
    ELSE 'Pending'
  END as status,
  d.distributed,
  d.carry_out as dust
FROM reward_configs r
LEFT JOIN reward_dust_ledger d ON d.reward_id = r.reward_id
ORDER BY r.created_at DESC;
```

**Payout Summary for a Reward:**
```sql
SELECT
  reward_id,
  COUNT(*) as recipient_count,
  SUM(payout_amount) as total_distributed,
  AVG(payout_amount) as avg_payout,
  MIN(payout_amount) as min_payout,
  MAX(payout_amount) as max_payout
FROM reward_payouts_preview
WHERE reward_id = 'YOUR_REWARD_ID'
GROUP BY reward_id;
```

**Top Recipients for a Reward:**
```sql
SELECT
  wallet,
  share,
  payout_amount
FROM reward_payouts_preview
WHERE reward_id = 'YOUR_REWARD_ID'
ORDER BY payout_amount DESC
LIMIT 20;
```

---

### Dust Ledger Queries

**Dust Accounting History:**
```sql
SELECT
  reward_id,
  mint,
  configured_total,
  carry_in,
  distributed,
  carry_out,
  created_at
FROM reward_dust_ledger
ORDER BY created_at DESC;
```

**Current Dust Balance Per Mint:**
```sql
SELECT DISTINCT ON (mint)
  mint,
  carry_out as current_dust,
  reward_id as last_reward,
  created_at
FROM reward_dust_ledger
ORDER BY mint, created_at DESC;
```

---

### Diagnostic Queries

**Check for Missing Data:**
```sql
-- Windows with snapshots but no weights
SELECT DISTINCT window_id FROM snapshots
WHERE window_id NOT IN (SELECT DISTINCT window_id FROM weights);

-- System-owned wallets with snapshots but no weights
SELECT DISTINCT s.wallet, s.window_id
FROM snapshots s
JOIN wallets w ON w.wallet = s.wallet
WHERE w.is_system_owned = true
  AND NOT EXISTS (
    SELECT 1 FROM weights wt
    WHERE wt.wallet = s.wallet AND wt.window_id = s.window_id
  );
```

**Verify Reward Computation:**
```sql
-- Compare configured vs distributed
SELECT
  r.reward_id,
  r.total_amount as configured,
  d.carry_in,
  d.distributed,
  d.carry_out,
  (r.total_amount::numeric + d.carry_in - d.distributed - d.carry_out) as discrepancy
FROM reward_configs r
JOIN reward_dust_ledger d ON d.reward_id = r.reward_id;
```

**Wallet Activity Over Time:**
```sql
SELECT
  wallet,
  COUNT(DISTINCT window_id) as windows_active,
  MIN(ts) as first_seen,
  MAX(ts) as last_seen,
  SUM(primary_token_amount) / COUNT(*) as avg_balance
FROM snapshots
WHERE wallet = 'YOUR_WALLET_ADDRESS'
GROUP BY wallet;
```

---

## Merkle Distribution System (Scalable Payouts)

The Merkle distribution system provides a more scalable alternative to the direct Squads multisig payouts. Instead of creating N transfer proposals (one per batch of ~6 recipients), the multisig approves a single Merkle root that commits to the entire payout list.

### Benefits

| Traditional Multisig | Merkle Distribution |
|---------------------|---------------------|
| N proposals for N/6 batches | 1 proposal total |
| O(N) signing overhead | O(1) signing overhead |
| Best for ≤12 recipients | Scales to 1000+ recipients |
| Each signer reviews many txs | Signers review summary + root |

### Architecture

```
Existing Pipeline (unchanged)
├── Snapshots → Weights → Shares → Reward Config → Payouts → CSV

New Execution Layer
├── CSV Export
├── Merkle Builder (generates root + proofs)
├── Multisig approves single proposal:
│   └── Initialize distribution + Fund vault (one tx)
├── Relayer executes claims (untrusted, batched)
└── Optional clawback of remaining funds
```

### Workflow

#### Step 1: Build Merkle Distribution Artifact

After generating the payout CSV, build the Merkle tree:

```bash
npx ts-node src/jobs/build-merkle-distribution.ts exports/ORE_W52.csv
```

This creates:
- `distributions/ORE_W52_merkle.json` — Contains Merkle root and proofs
- Database record in `merkle_distributions` table

#### Step 2: Initialize via Multisig

Create a multisig proposal to initialize and fund the distribution:

```bash
npx ts-node src/jobs/init-merkle-distribution.ts distributions/ORE_W52_merkle.json
```

This creates a single Squads proposal that:
1. **Initializes Distribution** — Sets the Merkle root on-chain
2. **Funds Vault** — Transfers tokens to the distribution vault

#### Step 3: Approve and Execute Proposal

In the Squads UI:
1. Review the distribution summary (reward ID, amount, recipient count)
2. Verify the Merkle root matches the artifact
3. Approve and execute the proposal

#### Step 4: Run Relayer

Process claims with the relayer:

```bash
npx ts-node src/jobs/run-merkle-relayer.ts distributions/ORE_W52_merkle.json
```

The relayer:
- Submits claims in batches (configurable size)
- Creates recipient ATAs as needed
- Handles retries for failed transactions
- Tracks progress in database

### Environment Variables

```env
# Required for Merkle distributions
MERKLE_PROGRAM_ID=8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4
RELAYER_KEYPAIR=./keys/relayer.json

# Optional relayer tuning
RELAYER_BATCH_SIZE=2        # 2 recommended; use 1 if transactions fail due to size
RELAYER_MAX_RETRIES=3
RELAYER_RETRY_DELAY=2000
RELAYER_COMPUTE_UNITS=400000
RELAYER_COMPUTE_PRICE=1000
```

**Note:** `RELAYER_BATCH_SIZE=2` works well for most distributions. If you encounter transaction size errors with very large recipient counts (1000+), reduce to 1.

### Deployed Program

| Network | Program ID | Status |
|---------|------------|--------|
| **Mainnet** | `8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4` | ✅ Production |
| Devnet | `8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4` | ✅ Testing |

**Explorer:** [View on Solscan](https://solscan.io/account/8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4)

### Database Tables

| Table | Purpose |
|-------|---------|
| `merkle_distributions` | Distribution configs, Merkle roots, status |
| `merkle_claims` | Per-recipient claim tracking |
| `merkle_relayer_batches` | Batch submission history |

Run the schema migration:
```bash
psql -d lst_rewards -f db/merkle-schema.sql
```

### Monitoring Queries

**Distribution Progress:**
```sql
SELECT * FROM merkle_distribution_summary;
```

**Pending Claims:**
```sql
SELECT * FROM merkle_pending_claims WHERE distribution_id = 'YOUR_ID';
```

**Claim Statistics:**
```sql
SELECT
  distribution_id,
  status,
  COUNT(*) as count,
  SUM(amount::numeric) as total_amount
FROM merkle_claims
GROUP BY distribution_id, status
ORDER BY distribution_id, status;
```

### Security Model

1. **Custody** — Tokens remain in multisig vault until funding
2. **Commitment** — Merkle root is cryptographic commitment to exact payouts
3. **Replay Protection** — Each claim can only be processed once (claim PDAs)
4. **Relayer Trust** — Relayer is untrusted; cannot steal funds or modify amounts
5. **Clawback** — Authority can recover unclaimed funds after distribution period

### Testing on Devnet

Use the end-to-end test script to verify the system works before mainnet:

```bash
# Create a test CSV with devnet token addresses
# Example: exports/DEV_TEST.csv

# Run full test (initializes, funds, and processes all claims)
npx ts-node src/jobs/test-merkle-devnet.ts exports/DEV_TEST.csv
```

The test script performs:
1. Database setup (creates reward config)
2. Builds Merkle distribution artifact
3. Initializes distribution on-chain
4. Funds the vault
5. Processes all claims
6. Verifies recipient balances

**Required for devnet testing:**
- `SOLANA_RPC_URL` pointing to devnet (e.g., `https://api.devnet.solana.com`)
- `RELAYER_KEYPAIR` with devnet SOL for fees
- Test SPL tokens minted and held by the relayer wallet

### Troubleshooting

**"Invalid Merkle proof" error:**
- Ensure artifact matches deployed distribution
- Verify distribution ID consistency
- Check that the on-chain Merkle root matches the artifact (may need fresh distribution)

**"DeclaredProgramIdMismatch" error:**
- The deployed program binary doesn't match the `declare_id!` in source
- Rebuild with `anchor build` and upgrade with `anchor upgrade`

**Claims failing:**
- Check relayer has sufficient SOL for fees
- Verify recipient wallet is valid Solana address
- Check vault has sufficient token balance

**Slow processing:**
- Increase `RELAYER_BATCH_SIZE` to 2 (higher values may hit tx size limits)
- Reduce `RELAYER_RETRY_DELAY` for faster retries
- Use dedicated RPC for better throughput

---

## Quick Reference: Full Reward Distribution Workflow

### Option A: Traditional Squads Multisig (≤12 recipients)

```bash
# 1. Run pipeline to collect and process data
npx ts-node src/runners/process-pipeline.ts

# 2. Create reward configuration
npx ts-node src/jobs/create-reward.ts --token ORE --amount 7

# 3. Compute payouts
npx ts-node src/jobs/compute-reward-payouts.ts

# 4. Export CSV
npx ts-node src/jobs/export-reward-csv.ts ORE_2025_W52

# 5. Create Squads proposals (batched transfers)
npx ts-node src/jobs/squads-create-payout-proposals.ts exports/ORE_2025_W52.csv
```

### Option B: Merkle Distribution (12+ recipients, recommended)

```bash
# 1. Run pipeline to collect and process data
npx ts-node src/runners/process-pipeline.ts

# 2. Create reward configuration
npx ts-node src/jobs/create-reward.ts --token ORE --amount 7

# 3. Compute payouts
npx ts-node src/jobs/compute-reward-payouts.ts

# 4. Export CSV
npx ts-node src/jobs/export-reward-csv.ts ORE_2025_W52

# 5. Build Merkle distribution
npx ts-node src/jobs/build-merkle-distribution.ts exports/ORE_2025_W52.csv

# 6. Create multisig proposal (init + fund in single tx)
npx ts-node src/jobs/init-merkle-distribution.ts distributions/ORE_2025_W52_merkle.json

# 7. Approve proposal in Squads UI

# 8. Run relayer to process claims
npx ts-node src/jobs/run-merkle-relayer.ts distributions/ORE_2025_W52_merkle.json
```

---

## Building and Deploying the Merkle Program

### Current Deployment Status

| Network | Program ID | IDL | Status |
|---------|------------|-----|--------|
| **Mainnet** | `8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4` | ✅ Published | Production |
| Devnet | `8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4` | ✅ Published | Testing |

**Explorer:** [View on Solscan](https://solscan.io/account/8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4)

**Upgrade Authority:** `3smkPvNBjbeh4KSnwqVWGK2Pk9MeW6ShHXj5YKf3r8Wg`

---

If you need to deploy or upgrade the on-chain program:

### Prerequisites (WSL/Linux recommended)

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Install Anchor CLI
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.31.0
avm use 0.31.0
```

### Build the Program

```bash
cd /path/to/lst-rewards-indexer

# Clean build to ensure fresh artifacts
anchor clean
anchor build

# Verify the build output exists
ls -la programs/merkle-distributor/target/deploy/merkle_distributor.so
```

**Note:** The correct `.so` file is in `programs/merkle-distributor/target/deploy/`, not the root `target/deploy/`.

### Deploy (New Installation)

```bash
# Set network
solana config set --url mainnet-beta  # or devnet

# Ensure deployer has SOL (~2.5 SOL needed temporarily for buffer, ~0.1 SOL kept for rent)
solana balance

# Copy your deployer keypair to the Solana config location
cp ./keys/id.json ~/.config/solana/id.json

# Verify address
solana address

# Deploy
anchor deploy --provider.cluster mainnet --provider.wallet ./keys/id.json
```

### Upgrade (Existing Deployment)

Program upgrades require ~2 SOL temporary deposit (returned after upgrade):

```bash
# Ensure your keypair is the upgrade authority
solana address  # Should match the upgrade authority

# Upgrade using solana program deploy (handles buffer automatically)
solana program deploy programs/merkle-distributor/target/deploy/merkle_distributor.so \
  --program-id 8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4 \
  --url mainnet-beta

# Verify upgrade succeeded
solana program show 8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4 --url mainnet-beta
```

### Publish/Update IDL

After deployment or upgrade, publish the IDL for explorer decoding:

```bash
# Initial publish
anchor idl init 8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4 \
  --filepath target/idl/merkle_distributor.json \
  --provider.cluster mainnet \
  --provider.wallet ./keys/id.json

# Update after program changes
anchor idl upgrade 8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4 \
  --filepath target/idl/merkle_distributor.json \
  --provider.cluster mainnet \
  --provider.wallet ./keys/id.json
```

### Important: Back Up Your Keypairs!

After deployment, back up these files securely:
- `target/deploy/merkle_distributor-keypair.json` (program keypair - determines program ID)
- `keys/id.json` (upgrade authority - can upgrade the program)

**Loss of the upgrade authority keypair means you cannot upgrade the program.**

### Upgrade Cost Notes

- **Net cost:** ~0.01 SOL (transaction fees only)
- **Temporary deposit:** ~2.1 SOL (returned immediately after upgrade)
- You need to have the full deposit amount available, but you get it back

