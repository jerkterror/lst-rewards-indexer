// src/merkle/builder.ts
// Builds Merkle distribution artifacts from CSV payouts

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { buildMerkleData } from './tree';
import { DistributionArtifact, PayoutEntry } from './types';

/**
 * Parse CSV file into payout entries
 */
export function parseCsv(csvPath: string): PayoutEntry[] {
  const text = fs.readFileSync(csvPath, 'utf8').trim();
  const [header, ...lines] = text.split(/\r?\n/);
  const headers = header.split(',').map((h) => h.trim().toLowerCase());

  const walletIdx = headers.indexOf('wallet');
  const mintIdx = headers.indexOf('mint');
  const amountIdx = headers.indexOf('amount');
  const rewardIdIdx = headers.indexOf('reward_id');
  const windowIdIdx = headers.indexOf('window_id');

  if (walletIdx === -1 || mintIdx === -1 || amountIdx === -1) {
    throw new Error('CSV must include wallet, mint, amount columns');
  }

  return lines
    .map((line) => {
      const cols = line.split(',').map((c) => c.trim());
      return {
        wallet: cols[walletIdx],
        mint: cols[mintIdx],
        amount: BigInt(cols[amountIdx] || '0'),
        rewardId: cols[rewardIdIdx] || '',
        windowId: cols[windowIdIdx] || '',
      };
    })
    .filter((entry) => entry.wallet && entry.amount > 0n);
}

/**
 * Compute SHA-256 hash of file contents
 */
export function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Generate distribution ID from components
 * 
 * distribution_id = hash(domain || reward_id || window_id || mint || total_amount)
 * 
 * This ensures each distribution has a unique, deterministic identifier.
 * Returns full 32-byte hash as 64 hex characters (required by on-chain program).
 */
export function generateDistributionId(
  rewardId: string,
  windowId: string,
  mint: string,
  totalAmount: bigint
): string {
  const data = Buffer.concat([
    Buffer.from('L33_DIST_V1'),
    Buffer.from(rewardId),
    Buffer.from(windowId),
    Buffer.from(mint),
    (() => {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(totalAmount);
      return buf;
    })(),
  ]);

  // Return full 32-byte hash (64 hex chars) - required by on-chain program
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Build complete distribution artifact from CSV
 */
export function buildDistributionArtifact(csvPath: string): DistributionArtifact {
  // Parse CSV
  const entries = parseCsv(csvPath);

  if (entries.length === 0) {
    throw new Error('No valid payout entries in CSV');
  }

  // Validate single mint
  const mints = [...new Set(entries.map((e) => e.mint))];
  if (mints.length !== 1) {
    throw new Error(`Expected single mint, found: ${mints.join(', ')}`);
  }

  // Extract metadata from first entry
  const { mint, rewardId, windowId } = entries[0];

  // Compute total amount
  const totalAmount = entries.reduce((sum, e) => sum + e.amount, 0n);

  // Generate distribution ID
  const distributionId = generateDistributionId(rewardId, windowId, mint, totalAmount);

  // Build Merkle tree and proofs
  const { root, proofs } = buildMerkleData(
    distributionId,
    entries.map((e) => ({ wallet: e.wallet, amount: e.amount }))
  );

  // Hash source CSV for verification
  const csvHash = hashFile(csvPath);

  return {
    distributionId,
    rewardId,
    windowId,
    mint,
    totalAmount: totalAmount.toString(),
    merkleRoot: root,
    numRecipients: entries.length,
    csvHash,
    proofs,
    createdAt: new Date().toISOString(),
    version: '1.0.0',
  };
}

/**
 * Save distribution artifact to file
 */
export function saveArtifact(artifact: DistributionArtifact, outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true });

  const filename = `${artifact.rewardId}_merkle.json`;
  const outPath = path.join(outDir, filename);

  fs.writeFileSync(outPath, JSON.stringify(artifact, null, 2));

  return outPath;
}

/**
 * Load distribution artifact from file
 */
export function loadArtifact(artifactPath: string): DistributionArtifact {
  const content = fs.readFileSync(artifactPath, 'utf8');
  return JSON.parse(content) as DistributionArtifact;
}

/**
 * Validate artifact integrity
 */
export function validateArtifact(artifact: DistributionArtifact): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check required fields
  if (!artifact.distributionId) errors.push('Missing distributionId');
  if (!artifact.merkleRoot) errors.push('Missing merkleRoot');
  if (!artifact.mint) errors.push('Missing mint');
  if (!artifact.proofs || artifact.proofs.length === 0) {
    errors.push('Missing or empty proofs');
  }

  // Validate total matches sum of proofs
  if (artifact.proofs) {
    const proofTotal = artifact.proofs.reduce(
      (sum, p) => sum + BigInt(p.amount),
      0n
    );
    if (proofTotal.toString() !== artifact.totalAmount) {
      errors.push(
        `Total mismatch: artifact says ${artifact.totalAmount}, proofs sum to ${proofTotal}`
      );
    }
  }

  // Validate recipient count
  if (artifact.proofs && artifact.proofs.length !== artifact.numRecipients) {
    errors.push(
      `Recipient count mismatch: ${artifact.numRecipients} vs ${artifact.proofs.length} proofs`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

