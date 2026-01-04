-- Merkle Distribution Schema Extensions
-- Adds tables for tracking Merkle-based reward distributions
--
-- Usage:
--   psql -d your_database_name -f db/merkle-schema.sql

-- ============================================================================
-- MERKLE DISTRIBUTIONS
-- Tracks Merkle distribution configurations and state
-- ============================================================================

CREATE TABLE IF NOT EXISTS merkle_distributions (
    distribution_id TEXT PRIMARY KEY,
    reward_id TEXT NOT NULL REFERENCES reward_configs(reward_id),
    window_id TEXT NOT NULL,
    mint TEXT NOT NULL,
    total_amount NUMERIC NOT NULL,
    merkle_root TEXT NOT NULL,
    num_recipients INTEGER NOT NULL,
    csv_hash TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    
    -- On-chain state (populated after multisig initialization)
    on_chain_address TEXT,
    vault_ata TEXT,
    
    -- Tracking
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'funded', 'active', 'completed', 'clawedback')
    ),
    claimed_amount NUMERIC NOT NULL DEFAULT 0,
    claimed_count INTEGER NOT NULL DEFAULT 0,
    
    -- Timestamps
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    funded_at TIMESTAMP,
    activated_at TIMESTAMP,
    completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_merkle_dist_reward
    ON merkle_distributions(reward_id);

CREATE INDEX IF NOT EXISTS idx_merkle_dist_status
    ON merkle_distributions(status);

CREATE INDEX IF NOT EXISTS idx_merkle_dist_mint
    ON merkle_distributions(mint);

COMMENT ON TABLE merkle_distributions IS 'Merkle distribution configurations for scalable reward distribution';
COMMENT ON COLUMN merkle_distributions.distribution_id IS 'Unique hash-derived identifier for this distribution';
COMMENT ON COLUMN merkle_distributions.merkle_root IS 'Hex-encoded Merkle root committing to all payouts';
COMMENT ON COLUMN merkle_distributions.csv_hash IS 'SHA-256 hash of source CSV for verification';
COMMENT ON COLUMN merkle_distributions.artifact_path IS 'Path to JSON artifact containing proofs';
COMMENT ON COLUMN merkle_distributions.on_chain_address IS 'Distribution PDA address after initialization';
COMMENT ON COLUMN merkle_distributions.vault_ata IS 'Token vault ATA for this distribution';
COMMENT ON COLUMN merkle_distributions.status IS 'Current state: pending → funded → active → completed/clawedback';

-- ============================================================================
-- MERKLE CLAIMS
-- Tracks claim status for relayer processing
-- ============================================================================

CREATE TABLE IF NOT EXISTS merkle_claims (
    distribution_id TEXT NOT NULL REFERENCES merkle_distributions(distribution_id),
    leaf_index INTEGER NOT NULL,
    wallet TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    
    -- Claim state
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'submitted', 'confirmed', 'failed')
    ),
    
    -- Transaction tracking
    tx_signature TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt TIMESTAMP,
    confirmed_at TIMESTAMP,
    error_message TEXT,
    
    PRIMARY KEY (distribution_id, leaf_index)
);

CREATE INDEX IF NOT EXISTS idx_merkle_claims_distribution
    ON merkle_claims(distribution_id);

CREATE INDEX IF NOT EXISTS idx_merkle_claims_wallet
    ON merkle_claims(wallet);

CREATE INDEX IF NOT EXISTS idx_merkle_claims_status
    ON merkle_claims(status);

CREATE INDEX IF NOT EXISTS idx_merkle_claims_pending
    ON merkle_claims(distribution_id, status)
    WHERE status IN ('pending', 'failed');

COMMENT ON TABLE merkle_claims IS 'Claim tracking for relayer batch processing';
COMMENT ON COLUMN merkle_claims.leaf_index IS 'Index of this claim in the Merkle tree';
COMMENT ON COLUMN merkle_claims.status IS 'Claim state: pending → submitted → confirmed/failed';
COMMENT ON COLUMN merkle_claims.attempts IS 'Number of submission attempts (for retry logic)';

-- ============================================================================
-- MERKLE RELAYER BATCHES
-- Tracks relayer batch submissions for monitoring
-- ============================================================================

CREATE TABLE IF NOT EXISTS merkle_relayer_batches (
    id SERIAL PRIMARY KEY,
    distribution_id TEXT NOT NULL REFERENCES merkle_distributions(distribution_id),
    batch_index INTEGER NOT NULL,
    claim_indices INTEGER[] NOT NULL,
    
    -- Transaction info
    tx_signature TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN ('pending', 'submitted', 'confirmed', 'failed')
    ),
    
    -- Metrics
    claims_count INTEGER NOT NULL,
    compute_units INTEGER,
    fee_lamports BIGINT,
    
    -- Timing
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    submitted_at TIMESTAMP,
    confirmed_at TIMESTAMP,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_relayer_batches_distribution
    ON merkle_relayer_batches(distribution_id);

CREATE INDEX IF NOT EXISTS idx_relayer_batches_status
    ON merkle_relayer_batches(status);

COMMENT ON TABLE merkle_relayer_batches IS 'Batch submission tracking for relayer operations';

-- ============================================================================
-- HELPER VIEWS
-- ============================================================================

CREATE OR REPLACE VIEW merkle_distribution_summary AS
SELECT
    d.distribution_id,
    d.reward_id,
    d.window_id,
    d.mint,
    d.total_amount,
    d.num_recipients,
    d.status,
    d.claimed_count,
    d.claimed_amount,
    CASE
        WHEN d.num_recipients > 0
        THEN ROUND(100.0 * d.claimed_count / d.num_recipients, 1)
        ELSE 0
    END AS claim_progress_pct,
    d.created_at,
    d.activated_at
FROM merkle_distributions d
ORDER BY d.created_at DESC;

COMMENT ON VIEW merkle_distribution_summary IS 'Summary view of Merkle distributions with progress';

CREATE OR REPLACE VIEW merkle_pending_claims AS
SELECT
    c.distribution_id,
    c.leaf_index,
    c.wallet,
    c.amount,
    c.attempts,
    c.last_attempt,
    c.error_message
FROM merkle_claims c
WHERE c.status IN ('pending', 'failed')
ORDER BY c.distribution_id, c.leaf_index;

COMMENT ON VIEW merkle_pending_claims IS 'Claims awaiting processing by relayer';

-- ============================================================================
-- UPDATE TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION update_merkle_distribution_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_merkle_distribution_updated ON merkle_distributions;

CREATE TRIGGER trigger_merkle_distribution_updated
    BEFORE UPDATE ON merkle_distributions
    FOR EACH ROW
    EXECUTE FUNCTION update_merkle_distribution_timestamp();

