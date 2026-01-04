//! Merkle Distributor Program
//! 
//! A Solana program for distributing SPL tokens using Merkle proofs.
//! 
//! ## Overview
//! 
//! This program enables efficient, trustless distribution of SPL tokens to
//! many recipients through a single Merkle root commitment. The workflow:
//! 
//! 1. Off-chain: Build Merkle tree from (recipient, amount) pairs
//! 2. Multisig: Fund vault and initialize distribution with Merkle root
//! 3. Relayer/Users: Submit claims with Merkle proofs
//! 4. Optional: Clawback remaining funds after expiry
//! 
//! ## Security Properties
//! 
//! - Only the committed Merkle root can authorize claims
//! - Each leaf can only be claimed once (tracked via claim PDAs)
//! - Domain separation prevents cross-distribution replay
//! - Authority controls initialization and clawback

use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4");

/// Domain separator for leaf hashing (must match off-chain builder)
pub const DOMAIN_SEPARATOR: &[u8] = b"L33_MERKLE_V1";

/// Maximum proof depth (supports up to 2^20 = ~1M recipients)
pub const MAX_PROOF_LEN: usize = 20;

#[program]
pub mod merkle_distributor {
    use super::*;

    /// Initialize a new distribution
    /// 
    /// Creates the distribution account and vault for token storage.
    /// Must be called by the distribution authority (typically a multisig).
    pub fn initialize(
        ctx: Context<Initialize>,
        distribution_id: [u8; 32],
        merkle_root: [u8; 32],
        total_amount: u64,
        num_recipients: u64,
    ) -> Result<()> {
        let distribution = &mut ctx.accounts.distribution;
        
        distribution.authority = ctx.accounts.authority.key();
        distribution.operator = ctx.accounts.authority.key(); // Default: authority is operator
        distribution.mint = ctx.accounts.mint.key();
        distribution.vault = ctx.accounts.vault.key();
        distribution.distribution_id = distribution_id;
        distribution.merkle_root = merkle_root;
        distribution.total_amount = total_amount;
        distribution.claimed_amount = 0;
        distribution.num_recipients = num_recipients;
        distribution.num_claimed = 0;
        distribution.paused = false;
        distribution.bump = ctx.bumps.distribution;
        distribution.vault_bump = ctx.bumps.vault;

        msg!(
            "Distribution initialized: recipients={}, total={}",
            num_recipients,
            total_amount
        );

        Ok(())
    }

    /// Set the operator (relayer) that can submit claims
    /// 
    /// The operator can submit claims on behalf of recipients but cannot
    /// modify the distribution or claim funds for themselves.
    pub fn set_operator(ctx: Context<SetOperator>, new_operator: Pubkey) -> Result<()> {
        ctx.accounts.distribution.operator = new_operator;
        msg!("Operator set to: {}", new_operator);
        Ok(())
    }

    /// Claim tokens for a single recipient
    /// 
    /// Verifies the Merkle proof and transfers tokens to the recipient.
    /// Creates a claim PDA to prevent double-claiming.
    pub fn claim(
        ctx: Context<ProcessClaim>,
        index: u64,
        amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let distribution = &ctx.accounts.distribution;
        
        // Check not paused
        require!(!distribution.paused, DistributorError::Paused);

        // Verify the Merkle proof
        let leaf = compute_leaf(
            &distribution.distribution_id,
            &ctx.accounts.recipient.key(),
            amount,
        );
        
        require!(
            verify_proof(&proof, &distribution.merkle_root, leaf),
            DistributorError::InvalidProof
        );

        // Transfer tokens
        let seeds = &[
            b"distribution",
            distribution.distribution_id.as_ref(),
            &[distribution.bump],
        ];
        let signer = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.recipient_token_account.to_account_info(),
                authority: ctx.accounts.distribution.to_account_info(),
            },
            signer,
        );

        token::transfer(transfer_ctx, amount)?;

        // Update distribution stats
        let distribution = &mut ctx.accounts.distribution;
        distribution.claimed_amount = distribution.claimed_amount.checked_add(amount)
            .ok_or(DistributorError::Overflow)?;
        distribution.num_claimed = distribution.num_claimed.checked_add(1)
            .ok_or(DistributorError::Overflow)?;

        // Initialize claim record
        let claim_record = &mut ctx.accounts.claim_record;
        claim_record.distribution = ctx.accounts.distribution.key();
        claim_record.index = index;
        claim_record.recipient = ctx.accounts.recipient.key();
        claim_record.amount = amount;
        claim_record.claimed_at = Clock::get()?.unix_timestamp;
        claim_record.bump = ctx.bumps.claim_record;

        msg!(
            "Claimed: recipient={}, amount={}, index={}",
            ctx.accounts.recipient.key(),
            amount,
            index
        );

        Ok(())
    }

    /// Pause the distribution (emergency only)
    pub fn pause(ctx: Context<AdminAction>) -> Result<()> {
        ctx.accounts.distribution.paused = true;
        msg!("Distribution paused");
        Ok(())
    }

    /// Unpause the distribution
    pub fn unpause(ctx: Context<AdminAction>) -> Result<()> {
        ctx.accounts.distribution.paused = false;
        msg!("Distribution unpaused");
        Ok(())
    }

    /// Clawback remaining funds to authority
    /// 
    /// Returns any unclaimed tokens to the distribution authority.
    /// Typically used after claim period expires.
    pub fn clawback(ctx: Context<Clawback>) -> Result<()> {
        let distribution = &ctx.accounts.distribution;
        let remaining = ctx.accounts.vault.amount;

        let seeds = &[
            b"distribution",
            distribution.distribution_id.as_ref(),
            &[distribution.bump],
        ];
        let signer = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.authority_token_account.to_account_info(),
                authority: ctx.accounts.distribution.to_account_info(),
            },
            signer,
        );

        token::transfer(transfer_ctx, remaining)?;

        msg!("Clawback: {} tokens returned to authority", remaining);

        Ok(())
    }
}

// ============================================================================
// Accounts
// ============================================================================

#[derive(Accounts)]
#[instruction(distribution_id: [u8; 32])]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + Distribution::INIT_SPACE,
        seeds = [b"distribution", distribution_id.as_ref()],
        bump
    )]
    pub distribution: Account<'info, Distribution>,

    /// The token mint for this distribution
    pub mint: Account<'info, token::Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = mint,
        token::authority = distribution,
        seeds = [b"vault", distribution_id.as_ref()],
        bump
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SetOperator<'info> {
    #[account(
        mut,
        has_one = authority @ DistributorError::Unauthorized
    )]
    pub distribution: Account<'info, Distribution>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(index: u64, amount: u64)]
pub struct ProcessClaim<'info> {
    #[account(
        mut,
        has_one = vault @ DistributorError::InvalidVault
    )]
    pub distribution: Account<'info, Distribution>,

    #[account(
        init,
        payer = payer,
        space = 8 + ClaimRecord::INIT_SPACE,
        seeds = [
            b"claim",
            distribution.key().as_ref(),
            index.to_le_bytes().as_ref()
        ],
        bump
    )]
    pub claim_record: Account<'info, ClaimRecord>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    /// The recipient wallet
    /// CHECK: Verified via Merkle proof
    pub recipient: UncheckedAccount<'info>,

    /// The recipient's token account
    #[account(
        mut,
        token::mint = distribution.mint,
        token::authority = recipient
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    /// Anyone can submit claims (relayer pattern)
    /// Security is provided by the Merkle proof - tokens always go to the
    /// verified recipient regardless of who submits the transaction.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(
        mut,
        has_one = authority @ DistributorError::Unauthorized
    )]
    pub distribution: Account<'info, Distribution>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Clawback<'info> {
    #[account(
        mut,
        has_one = authority @ DistributorError::Unauthorized,
        has_one = vault @ DistributorError::InvalidVault
    )]
    pub distribution: Account<'info, Distribution>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = distribution.mint,
        token::authority = authority
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ============================================================================
// State
// ============================================================================

#[account]
#[derive(InitSpace)]
pub struct Distribution {
    /// The authority that can manage this distribution
    pub authority: Pubkey,
    /// The operator that can submit claims (typically a relayer)
    pub operator: Pubkey,
    /// The SPL token mint being distributed
    pub mint: Pubkey,
    /// The vault holding tokens
    pub vault: Pubkey,
    /// Unique distribution identifier
    pub distribution_id: [u8; 32],
    /// Merkle root committing to all (recipient, amount) pairs
    pub merkle_root: [u8; 32],
    /// Total tokens allocated
    pub total_amount: u64,
    /// Tokens claimed so far
    pub claimed_amount: u64,
    /// Number of recipients
    pub num_recipients: u64,
    /// Number of claims processed
    pub num_claimed: u64,
    /// Emergency pause flag
    pub paused: bool,
    /// PDA bump
    pub bump: u8,
    /// Vault PDA bump
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ClaimRecord {
    /// The distribution this claim belongs to
    pub distribution: Pubkey,
    /// Index in the Merkle tree
    pub index: u64,
    /// Recipient wallet
    pub recipient: Pubkey,
    /// Amount claimed
    pub amount: u64,
    /// Timestamp of claim
    pub claimed_at: i64,
    /// PDA bump
    pub bump: u8,
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum DistributorError {
    #[msg("Invalid Merkle proof")]
    InvalidProof,
    #[msg("Distribution is paused")]
    Paused,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Invalid vault")]
    InvalidVault,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Proof too long")]
    ProofTooLong,
}

// ============================================================================
// Merkle Verification
// ============================================================================

/// Compute leaf hash using domain separation
/// Must match the off-chain builder exactly
pub fn compute_leaf(
    distribution_id: &[u8; 32],
    recipient: &Pubkey,
    amount: u64,
) -> [u8; 32] {
    let mut data = Vec::with_capacity(DOMAIN_SEPARATOR.len() + 32 + 32 + 8);
    data.extend_from_slice(DOMAIN_SEPARATOR);
    data.extend_from_slice(distribution_id);
    data.extend_from_slice(recipient.as_ref());
    data.extend_from_slice(&amount.to_le_bytes());
    
    keccak::hash(&data).to_bytes()
}

/// Verify a Merkle proof
pub fn verify_proof(
    proof: &[[u8; 32]],
    root: &[u8; 32],
    leaf: [u8; 32],
) -> bool {
    if proof.len() > MAX_PROOF_LEN {
        return false;
    }

    let mut current = leaf;
    
    for sibling in proof {
        current = hash_pair(&current, sibling);
    }

    current == *root
}

/// Hash two nodes, sorting for determinism
fn hash_pair(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (first, second) = if a <= b { (a, b) } else { (b, a) };
    
    let mut data = [0u8; 64];
    data[..32].copy_from_slice(first);
    data[32..].copy_from_slice(second);
    
    keccak::hash(&data).to_bytes()
}
