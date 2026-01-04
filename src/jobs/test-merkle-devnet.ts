// src/jobs/test-merkle-devnet.ts
// End-to-end devnet test for Merkle distribution system
//
// Usage:
//   npx ts-node src/jobs/test-merkle-devnet.ts <artifact-path>
//
// Prerequisites:
//   1. MERKLE_PROGRAM_ID deployed to devnet
//   2. Relayer keypair with devnet SOL
//   3. Test token minted and airdropped
//   4. PostgreSQL with merkle schema applied

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import assert from 'assert';

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getMint,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { pool } from '../db';
import { loadArtifact, buildDistributionArtifact, saveArtifact, validateArtifact } from '../merkle/builder';
import { getDistributionPda, getVaultPda, getClaimPda, buildClaimInstruction } from '../merkle/relayer';
import { getTokenByMint, fromRawAmount } from '../config/tokens';

// ============================================================================
// CONFIGURATION
// ============================================================================

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

interface TestConfig {
  connection: Connection;
  payer: Keypair;
  programId: PublicKey;
}

// ============================================================================
// STEP 1: Setup Database
// ============================================================================

async function setupTestRewardConfig(
  rewardId: string,
  windowId: string,
  mint: string,
  totalAmount: string
): Promise<void> {
  console.log('\n📦 Step 1: Setting up test reward config in database...');

  // First ensure the wallets exist
  const csvPath = `exports/DEV_W51_TEST.csv`;
  if (fs.existsSync(csvPath)) {
    const csvContent = fs.readFileSync(csvPath, 'utf8');
    const lines = csvContent.trim().split('\n').slice(1); // Skip header

    for (const line of lines) {
      const [wallet] = line.split(',');
      if (wallet) {
        await pool.query(
          `INSERT INTO wallets (wallet) VALUES ($1) ON CONFLICT (wallet) DO NOTHING`,
          [wallet]
        );
      }
    }
    console.log(`  ✓ Ensured ${lines.length} wallets exist in database`);
  }

  // Check what columns exist in reward_configs
  const { rows: columnInfo } = await pool.query(`
    SELECT column_name 
    FROM information_schema.columns 
    WHERE table_name = 'reward_configs'
  `);
  const columns = columnInfo.map((r: any) => r.column_name);
  console.log(`  Found reward_configs columns: ${columns.join(', ')}`);

  // Check if reward config already exists
  const { rows: existing } = await pool.query(
    `SELECT reward_id FROM reward_configs WHERE reward_id = $1`,
    [rewardId]
  );

  if (existing.length > 0) {
    console.log(`  ✓ Reward config "${rewardId}" already exists`);
    return;
  }

  // Create reward config based on available schema
  if (columns.includes('window_start') && columns.includes('window_end')) {
    // New schema with window range support
    await pool.query(
      `
      INSERT INTO reward_configs (
        reward_id,
        window_start,
        window_end,
        mint,
        total_amount,
        eligibility_mode,
        label
      ) VALUES ($1, $2, $2, $3, $4, 'all_weighted', 'Devnet Test Distribution')
      `,
      [rewardId, windowId, mint, totalAmount]
    );
  } else if (columns.includes('window_id')) {
    // Older schema with single window_id
    await pool.query(
      `
      INSERT INTO reward_configs (
        reward_id,
        window_id,
        mint,
        total_amount,
        eligibility_mode,
        label
      ) VALUES ($1, $2, $3, $4, 'all_weighted', 'Devnet Test Distribution')
      `,
      [rewardId, windowId, mint, totalAmount]
    );
  } else {
    // Minimal schema - just try basic columns
    const insertCols = ['reward_id', 'mint', 'total_amount'];
    const insertVals = [rewardId, mint, totalAmount];
    
    if (columns.includes('eligibility_mode')) {
      insertCols.push('eligibility_mode');
      insertVals.push('all_weighted');
    }
    if (columns.includes('label')) {
      insertCols.push('label');
      insertVals.push('Devnet Test Distribution');
    }

    const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(', ');
    await pool.query(
      `INSERT INTO reward_configs (${insertCols.join(', ')}) VALUES (${placeholders})`,
      insertVals
    );
  }

  console.log(`  ✓ Reward config "${rewardId}" created`);
}

// ============================================================================
// STEP 2: Build Merkle Distribution
// ============================================================================

async function buildMerkleDistribution(csvPath: string): Promise<{
  artifact: ReturnType<typeof buildDistributionArtifact>;
  artifactPath: string;
}> {
  console.log('\n🌳 Step 2: Building Merkle distribution artifact...');

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  const artifact = buildDistributionArtifact(csvPath);
  const validation = validateArtifact(artifact);

  if (!validation.valid) {
    throw new Error(`Invalid artifact: ${validation.errors.join(', ')}`);
  }

  // Save artifact
  const outDir = path.join(process.cwd(), 'distributions');
  const artifactPath = saveArtifact(artifact, outDir);

  console.log(`  ✓ Distribution ID: ${artifact.distributionId}`);
  console.log(`  ✓ Merkle Root: ${artifact.merkleRoot}`);
  console.log(`  ✓ Recipients: ${artifact.numRecipients}`);
  console.log(`  ✓ Artifact saved: ${artifactPath}`);

  // Store in database
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

  console.log(`  ✓ Distribution recorded in database`);

  return { artifact, artifactPath };
}

// ============================================================================
// STEP 3: Initialize Distribution On-Chain
// ============================================================================

function buildInitializeInstruction(
  programId: PublicKey,
  authority: PublicKey,
  distribution: PublicKey,
  mint: PublicKey,
  vault: PublicKey,
  distributionId: Buffer,
  merkleRoot: Buffer,
  totalAmount: bigint,
  numRecipients: number
): TransactionInstruction {
  // Anchor discriminator for "initialize"
  const discriminator = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);

  const data = Buffer.alloc(8 + 32 + 32 + 8 + 8);
  let offset = 0;

  discriminator.copy(data, offset);
  offset += 8;

  distributionId.copy(data, offset);
  offset += 32;

  merkleRoot.copy(data, offset);
  offset += 32;

  data.writeBigUInt64LE(totalAmount, offset);
  offset += 8;

  data.writeBigUInt64LE(BigInt(numRecipients), offset);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: distribution, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function initializeDistribution(
  config: TestConfig,
  artifact: ReturnType<typeof buildDistributionArtifact>
): Promise<{ distributionPda: PublicKey; vaultPda: PublicKey }> {
  console.log('\n🔐 Step 3: Initializing distribution on-chain...');

  // Distribution ID must be exactly 32 bytes for the on-chain program
  let distributionIdBuffer = Buffer.from(artifact.distributionId, 'hex');
  if (distributionIdBuffer.length < 32) {
    // Pad with zeros if shorter (for backward compatibility with old artifacts)
    const padded = Buffer.alloc(32);
    distributionIdBuffer.copy(padded);
    distributionIdBuffer = padded;
    console.log(`  ⚠️ Padded distribution ID from ${artifact.distributionId.length / 2} to 32 bytes`);
  }
  const merkleRootBuffer = Buffer.from(artifact.merkleRoot, 'hex');
  const mint = new PublicKey(artifact.mint);
  const totalAmount = BigInt(artifact.totalAmount);

  const [distributionPda] = getDistributionPda(config.programId, distributionIdBuffer);
  const [vaultPda] = getVaultPda(config.programId, distributionIdBuffer);

  console.log(`  Distribution PDA: ${distributionPda.toBase58()}`);
  console.log(`  Vault PDA: ${vaultPda.toBase58()}`);

  // Check if already initialized
  const existingAccount = await config.connection.getAccountInfo(distributionPda);
  if (existingAccount) {
    console.log(`  ⚠️ Distribution already initialized (skipping)`);
    return { distributionPda, vaultPda };
  }

  const initIx = buildInitializeInstruction(
    config.programId,
    config.payer.publicKey,
    distributionPda,
    mint,
    vaultPda,
    distributionIdBuffer,
    merkleRootBuffer,
    totalAmount,
    artifact.numRecipients
  );

  const { blockhash } = await config.connection.getLatestBlockhash();
  const tx = new Transaction().add(initIx);
  tx.recentBlockhash = blockhash;
  tx.feePayer = config.payer.publicKey;

  const signature = await sendAndConfirmTransaction(
    config.connection,
    tx,
    [config.payer],
    { commitment: 'confirmed' }
  );

  console.log(`  ✓ Initialized: ${signature}`);

  // Update database
  await pool.query(
    `
    UPDATE merkle_distributions
    SET
      on_chain_address = $2,
      vault_ata = $3,
      status = 'pending',
      updated_at = NOW()
    WHERE distribution_id = $1
    `,
    [artifact.distributionId, distributionPda.toBase58(), vaultPda.toBase58()]
  );

  return { distributionPda, vaultPda };
}

// ============================================================================
// STEP 4: Fund Vault
// ============================================================================

async function fundVault(
  config: TestConfig,
  artifact: ReturnType<typeof buildDistributionArtifact>,
  vaultPda: PublicKey
): Promise<void> {
  console.log('\n💰 Step 4: Funding distribution vault...');

  const mint = new PublicKey(artifact.mint);
  const totalAmount = BigInt(artifact.totalAmount);

  // Get source ATA (payer's token account)
  const sourceAta = getAssociatedTokenAddressSync(mint, config.payer.publicKey);

  // Check source balance
  try {
    const sourceAccount = await getAccount(config.connection, sourceAta);
    const sourceBalance = sourceAccount.amount;

    console.log(`  Source balance: ${sourceBalance.toString()}`);
    console.log(`  Required amount: ${totalAmount.toString()}`);

    if (sourceBalance < totalAmount) {
      throw new Error(
        `Insufficient balance. Have ${sourceBalance}, need ${totalAmount}`
      );
    }
  } catch (error: any) {
    if (error.name === 'TokenAccountNotFoundError') {
      throw new Error(
        `Payer has no token account for ${artifact.mint}. Please fund it first.`
      );
    }
    throw error;
  }

  // Check if vault already has tokens
  try {
    const vaultAccount = await getAccount(config.connection, vaultPda);
    if (vaultAccount.amount >= totalAmount) {
      console.log(`  ⚠️ Vault already funded (${vaultAccount.amount} tokens)`);
      return;
    }
  } catch {
    // Vault doesn't exist yet or is empty - that's fine
  }

  // Transfer tokens to vault
  const transferIx = createTransferInstruction(
    sourceAta,
    vaultPda,
    config.payer.publicKey,
    totalAmount
  );

  const { blockhash } = await config.connection.getLatestBlockhash();
  const tx = new Transaction().add(transferIx);
  tx.recentBlockhash = blockhash;
  tx.feePayer = config.payer.publicKey;

  const signature = await sendAndConfirmTransaction(
    config.connection,
    tx,
    [config.payer],
    { commitment: 'confirmed' }
  );

  console.log(`  ✓ Funded: ${signature}`);

  // Update database
  await pool.query(
    `
    UPDATE merkle_distributions
    SET status = 'funded', funded_at = NOW(), updated_at = NOW()
    WHERE distribution_id = $1
    `,
    [artifact.distributionId]
  );
}

// ============================================================================
// STEP 5: Process Claims
// ============================================================================

async function processClaims(
  config: TestConfig,
  artifact: ReturnType<typeof buildDistributionArtifact>,
  distributionPda: PublicKey,
  vaultPda: PublicKey
): Promise<{ processed: number; failed: number; skipped: number }> {
  console.log('\n📤 Step 5: Processing claims...');

  const mint = new PublicKey(artifact.mint);

  let processed = 0;
  let failed = 0;
  let skipped = 0;

  // Process each claim
  for (const proof of artifact.proofs) {
    const recipient = new PublicKey(proof.wallet);
    const [claimPda] = getClaimPda(config.programId, distributionPda, proof.index);

    console.log(`\n  Claim ${proof.index + 1}/${artifact.proofs.length}:`);
    console.log(`    Wallet: ${proof.wallet.slice(0, 8)}...${proof.wallet.slice(-4)}`);
    console.log(`    Amount: ${proof.amount}`);

    // Check if already claimed
    const existingClaim = await config.connection.getAccountInfo(claimPda);
    if (existingClaim) {
      console.log(`    ⚠️ Already claimed (skipping)`);
      skipped++;
      continue;
    }

    // Get or create recipient ATA
    const recipientAta = getAssociatedTokenAddressSync(mint, recipient, true);
    const ataInfo = await config.connection.getAccountInfo(recipientAta);

    const instructions: TransactionInstruction[] = [];

    if (!ataInfo) {
      console.log(`    Creating ATA for recipient...`);
      instructions.push(
        createAssociatedTokenAccountInstruction(
          config.payer.publicKey,
          recipientAta,
          recipient,
          mint
        )
      );
    }

    // Add claim instruction
    instructions.push(
      buildClaimInstruction(
        config.programId,
        distributionPda,
        claimPda,
        vaultPda,
        recipient,
        recipientAta,
        config.payer.publicKey,
        proof.index,
        BigInt(proof.amount),
        proof.proof
      )
    );

    try {
      const { blockhash } = await config.connection.getLatestBlockhash();
      const tx = new Transaction().add(...instructions);
      tx.recentBlockhash = blockhash;
      tx.feePayer = config.payer.publicKey;

      const signature = await sendAndConfirmTransaction(
        config.connection,
        tx,
        [config.payer],
        { commitment: 'confirmed' }
      );

      console.log(`    ✓ Claimed: ${signature}`);
      processed++;
    } catch (error: any) {
      console.log(`    ✗ Failed: ${error.message}`);
      failed++;
    }

    // Small delay to avoid rate limiting
    await sleep(500);
  }

  // Update database distribution stats
  await pool.query(
    `
    UPDATE merkle_distributions
    SET
      claimed_count = $2,
      claimed_amount = $3,
      status = CASE WHEN $2 >= num_recipients THEN 'completed' ELSE 'active' END,
      activated_at = COALESCE(activated_at, NOW()),
      completed_at = CASE WHEN $2 >= num_recipients THEN NOW() ELSE NULL END,
      updated_at = NOW()
    WHERE distribution_id = $1
    `,
    [artifact.distributionId, processed, processed > 0 ? artifact.totalAmount : 0]
  );

  return { processed, failed, skipped };
}

// ============================================================================
// STEP 6: Verify Results
// ============================================================================

async function verifyResults(
  config: TestConfig,
  artifact: ReturnType<typeof buildDistributionArtifact>,
  distributionPda: PublicKey,
  vaultPda: PublicKey
): Promise<void> {
  console.log('\n🔍 Step 6: Verifying results...');

  const mint = new PublicKey(artifact.mint);

  // Check vault balance (should be 0 or remaining)
  try {
    const vaultAccount = await getAccount(config.connection, vaultPda);
    console.log(`  Vault remaining: ${vaultAccount.amount.toString()}`);
  } catch {
    console.log(`  Vault: (account closed or empty)`);
  }

  // Check recipient balances
  console.log('\n  Recipient balances:');
  for (const proof of artifact.proofs) {
    const recipient = new PublicKey(proof.wallet);
    const recipientAta = getAssociatedTokenAddressSync(mint, recipient, true);

    try {
      const account = await getAccount(config.connection, recipientAta);
      const verified = account.amount >= BigInt(proof.amount) ? '✓' : '✗';
      console.log(`    ${proof.wallet.slice(0, 8)}...: ${account.amount.toString()} ${verified}`);
    } catch {
      console.log(`    ${proof.wallet.slice(0, 8)}...: (no account)`);
    }
  }

  // Check distribution account
  const distAccount = await config.connection.getAccountInfo(distributionPda);
  if (distAccount) {
    console.log(`\n  Distribution account exists: ${distAccount.data.length} bytes`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const csvPath = process.argv[2] || 'exports/DEV_W51_TEST.csv';

  console.log('═'.repeat(60));
  console.log('🧪 MERKLE DISTRIBUTION DEVNET TEST');
  console.log('═'.repeat(60));
  console.log(`\nCSV: ${csvPath}`);

  // Load config
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const keypairPath = process.env.RELAYER_KEYPAIR;
  const programIdStr = process.env.MERKLE_PROGRAM_ID;

  assert(rpcUrl, 'Missing SOLANA_RPC_URL in .env');
  assert(keypairPath, 'Missing RELAYER_KEYPAIR in .env');
  assert(programIdStr, 'Missing MERKLE_PROGRAM_ID in .env');

  const config: TestConfig = {
    connection: new Connection(rpcUrl, 'confirmed'),
    payer: loadKeypair(keypairPath),
    programId: new PublicKey(programIdStr),
  };

  console.log(`\nConfig:`);
  console.log(`  RPC: ${rpcUrl}`);
  console.log(`  Program: ${config.programId.toBase58()}`);
  console.log(`  Payer: ${config.payer.publicKey.toBase58()}`);

  // Check payer SOL balance
  const solBalance = await config.connection.getBalance(config.payer.publicKey);
  console.log(`  Payer SOL: ${(solBalance / 1e9).toFixed(4)} SOL`);

  if (solBalance < 0.1 * 1e9) {
    throw new Error('Payer needs at least 0.1 SOL for transaction fees');
  }

  // Parse CSV to get metadata
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  const csvContent = fs.readFileSync(csvPath, 'utf8');
  const lines = csvContent.trim().split('\n');
  const [, firstDataLine] = lines;
  const [, mint, , rewardId, windowId] = firstDataLine.split(',');

  // Calculate total
  let totalAmount = 0n;
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    totalAmount += BigInt(parts[2]);
  }

  console.log(`\nCSV Data:`);
  console.log(`  Reward ID: ${rewardId}`);
  console.log(`  Window: ${windowId}`);
  console.log(`  Mint: ${mint}`);
  console.log(`  Total: ${totalAmount.toString()}`);
  console.log(`  Recipients: ${lines.length - 1}`);

  // Execute test steps
  try {
    // Step 1: Setup database
    await setupTestRewardConfig(rewardId, windowId, mint, totalAmount.toString());

    // Step 2: Build Merkle distribution
    const { artifact, artifactPath } = await buildMerkleDistribution(csvPath);

    // Step 3: Initialize on-chain
    const { distributionPda, vaultPda } = await initializeDistribution(config, artifact);

    // Step 4: Fund vault
    await fundVault(config, artifact, vaultPda);

    // Step 5: Process claims
    const claimResults = await processClaims(config, artifact, distributionPda, vaultPda);

    // Step 6: Verify
    await verifyResults(config, artifact, distributionPda, vaultPda);

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('✅ TEST COMPLETE');
    console.log('═'.repeat(60));
    console.log(`\nResults:`);
    console.log(`  Distribution ID: ${artifact.distributionId}`);
    console.log(`  Claims processed: ${claimResults.processed}`);
    console.log(`  Claims failed: ${claimResults.failed}`);
    console.log(`  Claims skipped: ${claimResults.skipped}`);
    console.log(`\nArtifact: ${artifactPath}`);
    console.log(`\nExplorer links:`);
    console.log(`  Program: https://explorer.solana.com/address/${config.programId.toBase58()}?cluster=devnet`);
    console.log(`  Distribution: https://explorer.solana.com/address/${distributionPda.toBase58()}?cluster=devnet`);
  } catch (error: any) {
    console.error('\n❌ TEST FAILED');
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error('Fatal error:', e);
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });

