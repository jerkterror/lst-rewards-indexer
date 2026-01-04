// src/merkle/relayer.ts
// Relayer service for batch-claiming Merkle distributions

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { pool } from '../db';
import { DistributionArtifact, MerkleProof, MERKLE_DISTRIBUTOR_PROGRAM_ID } from './types';

/**
 * Relayer configuration
 */
export interface RelayerConfig {
  connection: Connection;
  payer: Keypair;
  programId: PublicKey;
  batchSize: number;
  maxRetries: number;
  retryDelayMs: number;
  computeUnitLimit: number;
  computeUnitPrice: number; // micro-lamports
}

/**
 * Claim instruction data layout
 * [discriminator (8)] [index (8)] [amount (8)] [proof_len (4)] [proof (32 * len)]
 */
export function buildClaimInstruction(
  programId: PublicKey,
  distribution: PublicKey,
  claim: PublicKey,
  vault: PublicKey,
  recipient: PublicKey,
  recipientAta: PublicKey,
  payer: PublicKey,
  index: number,
  amount: bigint,
  proof: string[]
): TransactionInstruction {
  // Anchor discriminator for "claim"
  const discriminator = Buffer.from([62, 198, 214, 193, 213, 159, 108, 210]);

  // Encode instruction data
  const proofBuffers = proof.map((p) => Buffer.from(p, 'hex'));
  const proofLen = proofBuffers.length;

  const data = Buffer.alloc(8 + 8 + 8 + 4 + proofLen * 32);
  let offset = 0;

  discriminator.copy(data, offset);
  offset += 8;

  data.writeBigUInt64LE(BigInt(index), offset);
  offset += 8;

  data.writeBigUInt64LE(amount, offset);
  offset += 8;

  data.writeUInt32LE(proofLen, offset);
  offset += 4;

  for (const proofNode of proofBuffers) {
    proofNode.copy(data, offset);
    offset += 32;
  }

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: distribution, isSigner: false, isWritable: true },
      { pubkey: claim, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: false },
      { pubkey: recipientAta, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Derive distribution PDA
 */
export function getDistributionPda(
  programId: PublicKey,
  distributionId: Buffer
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('distribution'), distributionId],
    programId
  );
}

/**
 * Derive claim PDA
 */
export function getClaimPda(
  programId: PublicKey,
  distribution: PublicKey,
  index: number
): [PublicKey, number] {
  const indexBuffer = Buffer.alloc(8);
  indexBuffer.writeBigUInt64LE(BigInt(index));

  return PublicKey.findProgramAddressSync(
    [Buffer.from('claim'), distribution.toBuffer(), indexBuffer],
    programId
  );
}

/**
 * Derive vault PDA
 */
export function getVaultPda(
  programId: PublicKey,
  distributionId: Buffer
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), distributionId],
    programId
  );
}

/**
 * Batch claims processor
 */
export class MerkleRelayer {
  constructor(private config: RelayerConfig) {}

  /**
   * Process all pending claims for a distribution
   */
  async processDistribution(artifact: DistributionArtifact): Promise<{
    processed: number;
    failed: number;
    skipped: number;
  }> {
    const distributionIdBuffer = Buffer.from(artifact.distributionId, 'hex');
    const mint = new PublicKey(artifact.mint);

    const [distributionPda] = getDistributionPda(
      this.config.programId,
      distributionIdBuffer
    );

    const [vaultPda] = getVaultPda(
      this.config.programId,
      distributionIdBuffer
    );

    // Get pending claims from database, matched with artifact proofs
    const pendingClaims = await this.getPendingClaims(artifact.distributionId, artifact);

    if (pendingClaims.length === 0) {
      console.log('No pending claims');
      return { processed: 0, failed: 0, skipped: 0 };
    }

    console.log(`Processing ${pendingClaims.length} pending claims...`);

    let processed = 0;
    let failed = 0;
    let skipped = 0;

    // Process in batches
    for (let i = 0; i < pendingClaims.length; i += this.config.batchSize) {
      const batch = pendingClaims.slice(i, i + this.config.batchSize);
      const batchNum = Math.floor(i / this.config.batchSize) + 1;
      const totalBatches = Math.ceil(pendingClaims.length / this.config.batchSize);

      console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} claims)`);

      try {
        const result = await this.processBatch(
          artifact,
          batch,
          distributionPda,
          vaultPda,
          mint
        );

        processed += result.processed;
        failed += result.failed;
        skipped += result.skipped;

        // Small delay between batches to avoid rate limiting
        if (i + this.config.batchSize < pendingClaims.length) {
          await sleep(500);
        }
      } catch (error: any) {
        console.error(`Batch ${batchNum} failed:`, error.message);
        failed += batch.length;
      }
    }

    return { processed, failed, skipped };
  }

  /**
   * Process a single batch of claims
   */
  private async processBatch(
    artifact: DistributionArtifact,
    claims: MerkleProof[],
    distributionPda: PublicKey,
    vaultPda: PublicKey,
    mint: PublicKey
  ): Promise<{ processed: number; failed: number; skipped: number }> {
    const instructions: TransactionInstruction[] = [];
    const claimsToProcess: MerkleProof[] = [];

    // Add compute budget instructions
    instructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: this.config.computeUnitLimit,
      }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: this.config.computeUnitPrice,
      })
    );

    // Check which claims need ATAs and which are already claimed
    for (const claim of claims) {
      const recipient = new PublicKey(claim.wallet);
      const [claimPda] = getClaimPda(
        this.config.programId,
        distributionPda,
        claim.index
      );

      // Check if already claimed on-chain
      const claimAccount = await this.config.connection.getAccountInfo(claimPda);
      if (claimAccount) {
        console.log(`  Claim ${claim.index} already processed (skipping)`);
        await this.updateClaimStatus(
          artifact.distributionId,
          claim.index,
          'confirmed',
          null
        );
        continue;
      }

      // Get or create recipient ATA
      const recipientAta = getAssociatedTokenAddressSync(mint, recipient, true);
      const ataInfo = await this.config.connection.getAccountInfo(recipientAta);

      if (!ataInfo) {
        instructions.push(
          createAssociatedTokenAccountInstruction(
            this.config.payer.publicKey,
            recipientAta,
            recipient,
            mint
          )
        );
      }

      // Add claim instruction
      instructions.push(
        buildClaimInstruction(
          this.config.programId,
          distributionPda,
          claimPda,
          vaultPda,
          recipient,
          recipientAta,
          this.config.payer.publicKey,
          claim.index,
          BigInt(claim.amount),
          claim.proof
        )
      );

      claimsToProcess.push(claim);
    }

    if (claimsToProcess.length === 0) {
      return {
        processed: 0,
        failed: 0,
        skipped: claims.length,
      };
    }

    // Mark as submitted
    for (const claim of claimsToProcess) {
      await this.updateClaimStatus(
        artifact.distributionId,
        claim.index,
        'submitted',
        null
      );
    }

    // Build and send transaction
    const { blockhash, lastValidBlockHeight } =
      await this.config.connection.getLatestBlockhash();

    const tx = new Transaction().add(...instructions);
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.config.payer.publicKey;

    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < this.config.maxRetries) {
      attempts++;
      try {
        const signature = await sendAndConfirmTransaction(
          this.config.connection,
          tx,
          [this.config.payer],
          { commitment: 'confirmed' }
        );

        console.log(`  ✓ Confirmed: ${signature}`);

        // Update all claims in batch as confirmed
        for (const claim of claimsToProcess) {
          await this.updateClaimStatus(
            artifact.distributionId,
            claim.index,
            'confirmed',
            signature
          );
        }

        return {
          processed: claimsToProcess.length,
          failed: 0,
          skipped: claims.length - claimsToProcess.length,
        };
      } catch (error: any) {
        lastError = error;
        console.log(`  Attempt ${attempts} failed: ${error.message}`);

        if (attempts < this.config.maxRetries) {
          await sleep(this.config.retryDelayMs);
        }
      }
    }

    // All retries failed
    console.error(`  ✗ Failed after ${attempts} attempts`);

    for (const claim of claimsToProcess) {
      await this.updateClaimStatus(
        artifact.distributionId,
        claim.index,
        'failed',
        null,
        lastError?.message
      );
    }

    return {
      processed: 0,
      failed: claimsToProcess.length,
      skipped: claims.length - claimsToProcess.length,
    };
  }

  /**
   * Get pending claims from database, matched with artifact proofs
   */
  private async getPendingClaims(
    distributionId: string,
    artifact: DistributionArtifact
  ): Promise<MerkleProof[]> {
    const { rows } = await pool.query<{
      leaf_index: number;
      wallet: string;
      amount: string;
    }>(
      `
      SELECT leaf_index, wallet, amount
      FROM merkle_claims
      WHERE distribution_id = $1
        AND status IN ('pending', 'failed')
        AND attempts < $2
      ORDER BY leaf_index
      `,
      [distributionId, this.config.maxRetries]
    );

    // Create a map of pending claim indices for quick lookup
    const pendingIndices = new Set(rows.map((r) => r.leaf_index));

    // Match with artifact proofs to get the full proof data
    const result: MerkleProof[] = artifact.proofs.filter(
      (proof) => pendingIndices.has(proof.index)
    );

    return result;
  }

  /**
   * Update claim status in database
   */
  private async updateClaimStatus(
    distributionId: string,
    index: number,
    status: string,
    txSignature: string | null,
    errorMessage?: string
  ): Promise<void> {
    await pool.query(
      `
      UPDATE merkle_claims
      SET
        status = $3,
        tx_signature = COALESCE($4, tx_signature),
        attempts = attempts + 1,
        last_attempt = NOW(),
        confirmed_at = CASE WHEN $3 = 'confirmed' THEN NOW() ELSE confirmed_at END,
        error_message = $5
      WHERE distribution_id = $1 AND leaf_index = $2
      `,
      [distributionId, index, status, txSignature, errorMessage || null]
    );
  }

  /**
   * Initialize claims from artifact (first-time setup)
   */
  async initializeClaimsFromArtifact(artifact: DistributionArtifact): Promise<number> {
    let inserted = 0;

    for (const proof of artifact.proofs) {
      try {
        await pool.query(
          `
          INSERT INTO merkle_claims (
            distribution_id,
            leaf_index,
            wallet,
            amount,
            status
          ) VALUES ($1, $2, $3, $4, 'pending')
          ON CONFLICT (distribution_id, leaf_index) DO NOTHING
          `,
          [artifact.distributionId, proof.index, proof.wallet, proof.amount]
        );
        inserted++;
      } catch (error) {
        // Skip duplicates
      }
    }

    return inserted;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

