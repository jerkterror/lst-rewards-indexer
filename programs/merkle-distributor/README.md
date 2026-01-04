# Merkle Distributor Program

An Anchor program for distributing SPL tokens using Merkle proofs.

## Overview

This program enables efficient, trustless distribution of SPL tokens to many recipients through a single Merkle root commitment. It's designed for reward distributions where:

- A multisig commits to a payout list via Merkle root
- An untrusted relayer can batch-submit claims
- Recipients receive exact amounts with cryptographic guarantees

## Building

```bash
# Install Anchor CLI if needed
cargo install --git https://github.com/coral-xyz/anchor anchor-cli --locked

# Build the program
anchor build
```

## Program Instructions

### `initialize`
Creates a new distribution with a Merkle root commitment.

**Accounts:**
- `authority` (signer) — Distribution authority (typically multisig)
- `distribution` (writable) — Distribution PDA to create
- `mint` — Token mint for distribution
- `vault` (writable) — Token vault PDA

**Args:**
- `distribution_id: [u8; 32]` — Unique distribution identifier
- `merkle_root: [u8; 32]` — Merkle root committing to payouts
- `total_amount: u64` — Total tokens to distribute
- `num_recipients: u64` — Number of recipients

### `claim`
Claims tokens for a recipient using a Merkle proof.

**Accounts:**
- `distribution` (writable) — Distribution account
- `claim` (writable) — Claim record PDA (prevents double-claims)
- `vault` (writable) — Token vault
- `recipient` — Recipient wallet
- `recipient_token_account` (writable) — Recipient's ATA
- `payer` (signer) — Operator or recipient

**Args:**
- `index: u64` — Leaf index in Merkle tree
- `amount: u64` — Claim amount
- `proof: Vec<[u8; 32]>` — Merkle proof

### `set_operator`
Sets the operator (relayer) that can submit claims.

### `pause` / `unpause`
Emergency pause controls.

### `clawback`
Returns remaining funds to authority.

## PDAs

| PDA | Seeds | Purpose |
|-----|-------|---------|
| Distribution | `["distribution", distribution_id]` | Stores distribution config |
| Vault | `["vault", distribution_id]` | Holds tokens for distribution |
| Claim | `["claim", distribution.key(), index]` | Tracks claimed leaves |

## Security

- **Merkle Verification**: Every claim verified against committed root
- **Replay Protection**: Claim PDAs prevent double-claiming
- **Domain Separation**: Leaf hash includes domain prefix
- **Authority Controls**: Only authority can pause/clawback

## Integration

The off-chain components in `src/merkle/` handle:
- Building Merkle trees from payout CSVs
- Generating proofs for each recipient
- Batch-submitting claims via relayer

See the main `OPERATOR_PLAYBOOK.md` for operational guides.

