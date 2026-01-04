// src/merkle/types.ts
// Core types for Merkle distribution system

import { PublicKey } from '@solana/web3.js';

/**
 * Raw payout entry from CSV
 */
export interface PayoutEntry {
  wallet: string;
  mint: string;
  amount: bigint;
  rewardId: string;
  windowId: string;
}

/**
 * Merkle tree leaf data
 */
export interface MerkleLeaf {
  index: number;
  wallet: string;
  amount: bigint;
  leaf: Buffer;
}

/**
 * Proof for a single recipient
 */
export interface MerkleProof {
  index: number;
  wallet: string;
  amount: string; // stringified bigint for JSON serialization
  proof: string[]; // hex-encoded proof nodes
}

/**
 * Complete distribution artifact
 * This is the output of the Merkle builder and input to multisig + relayer
 */
export interface DistributionArtifact {
  // Identity
  distributionId: string;
  rewardId: string;
  windowId: string;

  // Token info
  mint: string;
  totalAmount: string; // stringified bigint

  // Merkle data
  merkleRoot: string; // hex-encoded
  numRecipients: number;

  // Verification
  csvHash: string; // SHA-256 of source CSV

  // Proofs for each recipient
  proofs: MerkleProof[];

  // Metadata
  createdAt: string;
  version: string;
}

/**
 * Distribution status in the system
 */
export type DistributionStatus =
  | 'pending'      // Artifact created, awaiting multisig approval
  | 'funded'       // Vault funded, awaiting root initialization
  | 'active'       // Root initialized, claims can be processed
  | 'completed'    // All claims processed
  | 'clawedback';  // Remaining funds returned

/**
 * Database record for Merkle distribution
 */
export interface MerkleDistributionRecord {
  distributionId: string;
  rewardId: string;
  windowId: string;
  mint: string;
  totalAmount: string;
  merkleRoot: string;
  numRecipients: number;
  csvHash: string;
  status: DistributionStatus;
  claimedAmount: string;
  claimedCount: number;
  artifactPath: string;
  onChainAddress: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Claim status for relayer tracking
 */
export type ClaimStatus =
  | 'pending'    // Not yet claimed
  | 'submitted'  // Transaction submitted
  | 'confirmed'  // Claim confirmed on-chain
  | 'failed';    // Claim failed (will retry)

/**
 * Database record for claim tracking
 */
export interface MerkleClaimRecord {
  distributionId: string;
  index: number;
  wallet: string;
  amount: string;
  status: ClaimStatus;
  txSignature: string | null;
  attempts: number;
  lastAttempt: Date | null;
  confirmedAt: Date | null;
}

/**
 * Distribution PDA seeds
 */
export const DISTRIBUTION_SEED = Buffer.from('distribution');
export const CLAIM_SEED = Buffer.from('claim');

/**
 * Program ID placeholder (replace with actual deployed program)
 */
export const MERKLE_DISTRIBUTOR_PROGRAM_ID = new PublicKey(
  '8LMVzwtrcVCLJPFfUFviqWv49WoyN1PKNLd9EDj4X4H4'
);

/**
 * Domain separator for leaf hashing
 * Prevents cross-program and cross-version replay attacks
 */
export const DOMAIN_SEPARATOR = 'L33_MERKLE_V1';

