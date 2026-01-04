// src/jobs/build-merkle-distribution.ts
// CLI tool to build Merkle distribution artifacts from CSV payouts

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { pool } from '../db';
import {
  buildDistributionArtifact,
  saveArtifact,
  validateArtifact,
} from '../merkle/builder';
import { MerkleTree, constructLeaf } from '../merkle/tree';
import { getTokenByMint, fromRawAmount } from '../config/tokens';

async function main() {
  const csvPath = process.argv[2];

  if (!csvPath) {
    console.log('Usage: npx ts-node src/jobs/build-merkle-distribution.ts <csv-path>');
    console.log('');
    console.log('This tool builds a Merkle distribution artifact from a payout CSV.');
    console.log('The artifact contains the Merkle root and proofs for all recipients.');
    console.log('');
    console.log('Example:');
    console.log('  npx ts-node src/jobs/build-merkle-distribution.ts exports/ORE_W51_TEST.csv');
    process.exit(1);
  }

  if (!fs.existsSync(csvPath)) {
    console.error(`❌ File not found: ${csvPath}`);
    process.exit(1);
  }

  console.log('🌳 Building Merkle Distribution\n');
  console.log(`Source: ${csvPath}`);
  console.log('-'.repeat(60));

  // Build the artifact
  const artifact = buildDistributionArtifact(csvPath);

  // Validate
  const validation = validateArtifact(artifact);
  if (!validation.valid) {
    console.error('❌ Artifact validation failed:');
    validation.errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  // Get token info for display
  const tokenInfo = getTokenByMint(artifact.mint);
  const tokenSymbol = tokenInfo?.symbol || 'UNKNOWN';
  const decimals = tokenInfo?.decimals || 9;
  const humanAmount = fromRawAmount(BigInt(artifact.totalAmount), decimals);

  // Display summary
  console.log('');
  console.log('Distribution Summary:');
  console.log(`  Distribution ID: ${artifact.distributionId}`);
  console.log(`  Reward ID:       ${artifact.rewardId}`);
  console.log(`  Window:          ${artifact.windowId}`);
  console.log(`  Token:           ${tokenSymbol} (${artifact.mint})`);
  console.log(`  Total Amount:    ${humanAmount.toLocaleString()} ${tokenSymbol}`);
  console.log(`  Recipients:      ${artifact.numRecipients}`);
  console.log('');
  console.log('Merkle Data:');
  console.log(`  Root:            ${artifact.merkleRoot}`);
  console.log(`  CSV Hash:        ${artifact.csvHash}`);
  console.log('');

  // Verify a sample proof
  console.log('Proof Verification:');
  const sampleProof = artifact.proofs[0];
  const sampleLeaf = constructLeaf(
    artifact.distributionId,
    sampleProof.wallet,
    BigInt(sampleProof.amount)
  );
  const verified = MerkleTree.verifyHex(
    artifact.merkleRoot,
    sampleLeaf.toString('hex'),
    sampleProof.proof
  );
  console.log(`  Sample proof (${sampleProof.wallet.slice(0, 8)}...): ${verified ? '✓ Valid' : '✗ Invalid'}`);

  if (!verified) {
    console.error('❌ Proof verification failed!');
    process.exit(1);
  }

  // Save artifact
  const outDir = path.join(process.cwd(), 'distributions');
  const artifactPath = saveArtifact(artifact, outDir);

  console.log('');
  console.log(`✅ Artifact saved: ${artifactPath}`);

  // Store in database
  try {
    await pool.query(
      `
      INSERT INTO merkle_distributions (
        distribution_id,
        reward_id,
        window_id,
        mint,
        total_amount,
        merkle_root,
        num_recipients,
        csv_hash,
        artifact_path,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
      ON CONFLICT (distribution_id) DO UPDATE SET
        artifact_path = EXCLUDED.artifact_path,
        updated_at = NOW()
      `,
      [
        artifact.distributionId,
        artifact.rewardId,
        artifact.windowId,
        artifact.mint,
        artifact.totalAmount,
        artifact.merkleRoot,
        artifact.numRecipients,
        artifact.csvHash,
        artifactPath,
      ]
    );

    console.log('✅ Distribution recorded in database');
  } catch (error: any) {
    // Table might not exist yet - that's okay
    if (error.code === '42P01') {
      console.log('⚠️  Database table not found (run schema migration)');
    } else {
      console.error('⚠️  Database error:', error.message);
    }
  }

  console.log('');
  console.log('Next Steps:');
  console.log('  1. Review the artifact file');
  console.log('  2. Initialize distribution via multisig:');
  console.log(`     npx ts-node src/jobs/init-merkle-distribution.ts ${artifactPath}`);
  console.log('  3. Run relayer to process claims:');
  console.log(`     npx ts-node src/jobs/run-merkle-relayer.ts ${artifact.distributionId}`);
}

main()
  .catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });

