-- LST Rewards Indexer - Database Schema
-- This script creates all required tables and indexes for the rewards system
--
-- Usage:
--   psql -d your_database_name -f schema.sql
--
-- Or from within psql:
--   \i schema.sql

-- ============================================================================
-- WALLETS
-- Tracks all discovered IndieSOL holders and their classification
-- ============================================================================

CREATE TABLE IF NOT EXISTS wallets (
    wallet TEXT PRIMARY KEY,
    first_seen TIMESTAMP NOT NULL DEFAULT NOW(),
    is_system_owned BOOLEAN
);

CREATE INDEX IF NOT EXISTS idx_wallets_system_owned
    ON wallets(is_system_owned)
    WHERE is_system_owned = true;

COMMENT ON TABLE wallets IS 'Discovered wallet addresses and their ownership classification';
COMMENT ON COLUMN wallets.wallet IS 'Base58-encoded Solana wallet address';
COMMENT ON COLUMN wallets.first_seen IS 'When this wallet was first discovered by the indexer';
COMMENT ON COLUMN wallets.is_system_owned IS 'True if wallet is owned by System Program (eligible for rewards), false if program-owned, null if not yet classified';

-- ============================================================================
-- SNAPSHOTS
-- Append-only ledger of balance snapshots
-- ============================================================================

CREATE TABLE IF NOT EXISTS snapshots (
    id SERIAL PRIMARY KEY,
    wallet TEXT NOT NULL REFERENCES wallets(wallet),
    amount NUMERIC NOT NULL,
    ore_amount NUMERIC NOT NULL,
    eligible BOOLEAN NOT NULL,
    window_id TEXT NOT NULL,
    ts TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_wallet
    ON snapshots(wallet);

CREATE INDEX IF NOT EXISTS idx_snapshots_window
    ON snapshots(window_id);

CREATE INDEX IF NOT EXISTS idx_snapshots_ts
    ON snapshots(ts DESC);

CREATE INDEX IF NOT EXISTS idx_snapshots_wallet_window
    ON snapshots(wallet, window_id);

COMMENT ON TABLE snapshots IS 'Append-only history of wallet balances at each snapshot time';
COMMENT ON COLUMN snapshots.wallet IS 'Wallet address';
COMMENT ON COLUMN snapshots.amount IS 'IndieSOL balance in raw units (no decimals)';
COMMENT ON COLUMN snapshots.ore_amount IS 'ORE balance in raw units (no decimals)';
COMMENT ON COLUMN snapshots.eligible IS 'True if wallet had >= 1 ORE at snapshot time';
COMMENT ON COLUMN snapshots.window_id IS 'ISO week identifier (format: YYYY-WNN)';
COMMENT ON COLUMN snapshots.ts IS 'Timestamp when snapshot was taken';

-- ============================================================================
-- WEIGHTS
-- Time-weighted stake per wallet per window
-- ============================================================================

CREATE TABLE IF NOT EXISTS weights (
    window_id TEXT NOT NULL,
    wallet TEXT NOT NULL REFERENCES wallets(wallet),
    weight NUMERIC NOT NULL,
    last_ts TIMESTAMP NOT NULL,
    PRIMARY KEY (window_id, wallet)
);

CREATE INDEX IF NOT EXISTS idx_weights_window
    ON weights(window_id);

COMMENT ON TABLE weights IS 'Time-weighted stake computed as SUM(amount × seconds_held) per wallet per window';
COMMENT ON COLUMN weights.window_id IS 'ISO week identifier (format: YYYY-WNN)';
COMMENT ON COLUMN weights.wallet IS 'Wallet address';
COMMENT ON COLUMN weights.weight IS 'Time-weighted stake amount (amount × seconds held)';
COMMENT ON COLUMN weights.last_ts IS 'Timestamp of last snapshot included in weight calculation';

-- ============================================================================
-- REWARD SHARES
-- Normalized shares (0-1) derived from weights
-- ============================================================================

CREATE TABLE IF NOT EXISTS reward_shares (
    window_id TEXT NOT NULL,
    wallet TEXT NOT NULL REFERENCES wallets(wallet),
    share NUMERIC NOT NULL,
    weight NUMERIC NOT NULL,
    total_weight NUMERIC NOT NULL,
    PRIMARY KEY (window_id, wallet)
);

CREATE INDEX IF NOT EXISTS idx_reward_shares_window
    ON reward_shares(window_id);

COMMENT ON TABLE reward_shares IS 'Normalized shares computed as wallet_weight / total_weight per window';
COMMENT ON COLUMN reward_shares.window_id IS 'ISO week identifier (format: YYYY-WNN)';
COMMENT ON COLUMN reward_shares.wallet IS 'Wallet address';
COMMENT ON COLUMN reward_shares.share IS 'Normalized share (0-1) representing proportion of total weight';
COMMENT ON COLUMN reward_shares.weight IS 'This wallet''s time-weighted stake';
COMMENT ON COLUMN reward_shares.total_weight IS 'Sum of all weights for this window';

-- ============================================================================
-- REWARD CONFIGS
-- Declarative reward definitions (created manually or via CLI)
-- ============================================================================

CREATE TABLE IF NOT EXISTS reward_configs (
    reward_id TEXT PRIMARY KEY,
    window_id TEXT NOT NULL,
    mint TEXT NOT NULL,
    total_amount NUMERIC NOT NULL,
    eligibility_mode TEXT NOT NULL CHECK (eligibility_mode IN ('eligible_only', 'all_weighted')),
    label TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reward_configs_window
    ON reward_configs(window_id);

CREATE INDEX IF NOT EXISTS idx_reward_configs_mint
    ON reward_configs(mint);

CREATE INDEX IF NOT EXISTS idx_reward_configs_created
    ON reward_configs(created_at);

COMMENT ON TABLE reward_configs IS 'Reward distribution configurations defining how rewards are allocated';
COMMENT ON COLUMN reward_configs.reward_id IS 'Unique identifier for this reward (e.g., ORE_W51)';
COMMENT ON COLUMN reward_configs.window_id IS 'ISO week identifier this reward applies to';
COMMENT ON COLUMN reward_configs.mint IS 'SPL token mint address for reward token';
COMMENT ON COLUMN reward_configs.total_amount IS 'Total reward pool in raw token units (e.g., 7000000000 for 7 ORE)';
COMMENT ON COLUMN reward_configs.eligibility_mode IS 'eligible_only: only wallets with ORE >= 1, all_weighted: all wallets proportional to stake';
COMMENT ON COLUMN reward_configs.label IS 'Human-readable description';
COMMENT ON COLUMN reward_configs.created_at IS 'When this reward was configured';

-- ============================================================================
-- REWARD PAYOUTS PREVIEW
-- Computed payout amounts (can be recomputed, not authoritative)
-- ============================================================================

CREATE TABLE IF NOT EXISTS reward_payouts_preview (
    reward_id TEXT NOT NULL REFERENCES reward_configs(reward_id),
    wallet TEXT NOT NULL REFERENCES wallets(wallet),
    window_id TEXT NOT NULL,
    mint TEXT NOT NULL,
    share NUMERIC NOT NULL,
    total_amount NUMERIC NOT NULL,
    payout_amount NUMERIC NOT NULL,
    PRIMARY KEY (reward_id, wallet)
);

CREATE INDEX IF NOT EXISTS idx_payouts_preview_reward
    ON reward_payouts_preview(reward_id);

CREATE INDEX IF NOT EXISTS idx_payouts_preview_wallet
    ON reward_payouts_preview(wallet);

COMMENT ON TABLE reward_payouts_preview IS 'Computed payout amounts per wallet (non-authoritative, can be regenerated)';
COMMENT ON COLUMN reward_payouts_preview.reward_id IS 'Reference to reward configuration';
COMMENT ON COLUMN reward_payouts_preview.wallet IS 'Recipient wallet address';
COMMENT ON COLUMN reward_payouts_preview.window_id IS 'ISO week identifier';
COMMENT ON COLUMN reward_payouts_preview.mint IS 'SPL token mint address';
COMMENT ON COLUMN reward_payouts_preview.share IS 'Wallet''s normalized share (0-1)';
COMMENT ON COLUMN reward_payouts_preview.total_amount IS 'Total reward pool (including carry-in dust)';
COMMENT ON COLUMN reward_payouts_preview.payout_amount IS 'FLOOR(share × total_amount) - actual tokens to send';

-- ============================================================================
-- REWARD DUST LEDGER
-- Authoritative record of dust accounting (NEVER modify, append-only)
-- ============================================================================

CREATE TABLE IF NOT EXISTS reward_dust_ledger (
    reward_id TEXT PRIMARY KEY REFERENCES reward_configs(reward_id),
    mint TEXT NOT NULL,
    configured_total NUMERIC NOT NULL,
    carry_in NUMERIC NOT NULL,
    distributed NUMERIC NOT NULL,
    carry_out NUMERIC NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dust_ledger_mint
    ON reward_dust_ledger(mint);

CREATE INDEX IF NOT EXISTS idx_dust_ledger_created
    ON reward_dust_ledger(created_at);

COMMENT ON TABLE reward_dust_ledger IS 'AUTHORITATIVE dust accounting ledger (append-only, never modify)';
COMMENT ON COLUMN reward_dust_ledger.reward_id IS 'Reference to reward configuration';
COMMENT ON COLUMN reward_dust_ledger.mint IS 'SPL token mint address';
COMMENT ON COLUMN reward_dust_ledger.configured_total IS 'Reward amount from reward_configs';
COMMENT ON COLUMN reward_dust_ledger.carry_in IS 'Dust carried forward from previous reward of same mint';
COMMENT ON COLUMN reward_dust_ledger.distributed IS 'SUM of all payout_amounts (actual tokens sent)';
COMMENT ON COLUMN reward_dust_ledger.carry_out IS 'Dust carried to next reward: (configured_total + carry_in) - distributed';
COMMENT ON COLUMN reward_dust_ledger.created_at IS 'When payout computation was performed';

-- ============================================================================
-- VERIFICATION QUERIES
-- Run these to verify schema is working correctly
-- ============================================================================

-- Uncomment to verify tables were created:
-- SELECT table_name
-- FROM information_schema.tables
-- WHERE table_schema = 'public'
-- ORDER BY table_name;

-- Uncomment to verify indexes were created:
-- SELECT indexname, tablename
-- FROM pg_indexes
-- WHERE schemaname = 'public'
-- ORDER BY tablename, indexname;
