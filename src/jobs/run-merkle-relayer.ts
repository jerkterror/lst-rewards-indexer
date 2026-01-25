// src/jobs/run-merkle-relayer.ts
// CLI to run the Merkle distribution relayer

import 'dotenv/config';
import fs from 'fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { pool } from '../db';
import { loadArtifact, validateArtifact } from '../merkle/builder';
import { MerkleRelayer, RelayerConfig } from '../merkle/relayer';
import { MERKLE_DISTRIBUTOR_PROGRAM_ID } from '../merkle/types';
import { FailoverConnection, getRpcConfigFromEnv } from '../utils/rpc';

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const artifactPath = process.argv[2];

  if (!artifactPath) {
    console.log('Usage: npx ts-node src/jobs/run-merkle-relayer.ts <artifact-path>');
    console.log('');
    console.log('This runs the relayer to process claims for a Merkle distribution.');
    console.log('');
    console.log('Example:');
    console.log('  npx ts-node src/jobs/run-merkle-relayer.ts distributions/ORE_W51_TEST_merkle.json');
    console.log('');
    console.log('Required environment variables:');
    console.log('  SOLANA_RPC_URL        - Solana RPC endpoint');
    console.log('  RELAYER_KEYPAIR       - Path to relayer keypair JSON');
    console.log('  MERKLE_PROGRAM_ID     - Deployed distributor program ID (optional)');
    process.exit(1);
  }

  // Load configuration
  let rpcConfig;
  try {
    rpcConfig = getRpcConfigFromEnv();
  } catch (e: any) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
  const rpc = new FailoverConnection(rpcConfig);

  const keypairPath = process.env.RELAYER_KEYPAIR;
  const programIdStr = process.env.MERKLE_PROGRAM_ID;

  if (!keypairPath) {
    console.error('❌ Missing RELAYER_KEYPAIR environment variable');
    process.exit(1);
  }

  // Load artifact
  if (!fs.existsSync(artifactPath)) {
    console.error(`❌ Artifact not found: ${artifactPath}`);
    process.exit(1);
  }

  const artifact = loadArtifact(artifactPath);

  // Validate
  const validation = validateArtifact(artifact);
  if (!validation.valid) {
    console.error('❌ Invalid artifact:');
    validation.errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  console.log('🚀 Merkle Distribution Relayer\n');
  console.log('Configuration:');
  console.log(`  Distribution ID: ${artifact.distributionId}`);
  console.log(`  Reward ID:       ${artifact.rewardId}`);
  console.log(`  Recipients:      ${artifact.numRecipients}`);
  console.log(`  Total Amount:    ${artifact.totalAmount}`);
  console.log('');

  // Initialize connection and keypair
  const payer = loadKeypair(keypairPath);
  const programId = programIdStr
    ? new PublicKey(programIdStr)
    : MERKLE_DISTRIBUTOR_PROGRAM_ID;

  console.log(`  RPC:             ${rpc.getCurrentUrl()}${rpc.hasBackup() ? ' (backup configured)' : ''}`);
  console.log(`  Payer:           ${payer.publicKey.toBase58()}`);
  console.log(`  Program:         ${programId.toBase58()}`);
  console.log('');

  // Check payer balance
  const balance = await rpc.execute(
    (connection) => connection.getBalance(payer.publicKey),
    'getPayerBalance'
  );
  console.log(`  Payer Balance:   ${(balance / 1e9).toFixed(4)} SOL`);

  if (balance < 0.1 * 1e9) {
    console.error('❌ Insufficient balance for relayer operations');
    process.exit(1);
  }

  console.log('');
  console.log('-'.repeat(60));

  // Configure relayer (uses current active RPC connection)
  const config: RelayerConfig = {
    connection: rpc.connection,
    payer,
    programId,
    batchSize: parseInt(process.env.RELAYER_BATCH_SIZE || '5', 10),
    maxRetries: parseInt(process.env.RELAYER_MAX_RETRIES || '3', 10),
    retryDelayMs: parseInt(process.env.RELAYER_RETRY_DELAY || '2000', 10),
    computeUnitLimit: parseInt(process.env.RELAYER_COMPUTE_UNITS || '400000', 10),
    computeUnitPrice: parseInt(process.env.RELAYER_COMPUTE_PRICE || '1000', 10),
  };

  const relayer = new MerkleRelayer(config);

  // Initialize claims in database if needed
  console.log('\nInitializing claims from artifact...');
  const initialized = await relayer.initializeClaimsFromArtifact(artifact);
  console.log(`  Initialized ${initialized} new claims`);

  // Process claims
  console.log('\nProcessing claims...');
  const result = await relayer.processDistribution(artifact);

  console.log('');
  console.log('-'.repeat(60));
  console.log('Results:');
  console.log(`  ✓ Processed:  ${result.processed}`);
  console.log(`  ✗ Failed:     ${result.failed}`);
  console.log(`  ○ Skipped:    ${result.skipped}`);

  // Update distribution status if complete
  if (result.processed > 0 || result.skipped > 0) {
    const { rows } = await pool.query<{ pending: string }>(
      `
      SELECT COUNT(*) as pending
      FROM merkle_claims
      WHERE distribution_id = $1
        AND status NOT IN ('confirmed')
      `,
      [artifact.distributionId]
    );

    const pending = parseInt(rows[0]?.pending || '0', 10);

    if (pending === 0) {
      await pool.query(
        `
        UPDATE merkle_distributions
        SET status = 'completed', completed_at = NOW()
        WHERE distribution_id = $1
        `,
        [artifact.distributionId]
      );
      console.log('\n✅ Distribution complete!');
    } else {
      console.log(`\n${pending} claims remaining`);
    }
  }
}

main()
  .catch((e) => {
    console.error('Error:', e.message);
    console.error(e.stack);
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });

