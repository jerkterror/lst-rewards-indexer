// src/jobs/init-merkle-distribution.ts
// Initialize a Merkle distribution via Squads multisig

import 'dotenv/config';
import fs from 'fs';
import assert from 'assert';

import * as multisig from '@sqds/multisig';
import {
  PublicKey,
  Keypair,
  TransactionMessage,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
  getMint,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

import { pool } from '../db';
import { loadArtifact, validateArtifact } from '../merkle/builder';
import { getDistributionPda, getVaultPda } from '../merkle/relayer';
import { getTokenByMint, fromRawAmount } from '../config/tokens';
import { FailoverConnection, getRpcConfigFromEnv } from '../utils/rpc';

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/**
 * Build the initialize instruction for the Merkle distributor program
 */
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

  // Encode instruction data
  // [discriminator (8)] [distribution_id (32)] [merkle_root (32)] [total_amount (8)] [num_recipients (8)]
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

async function main() {
  const artifactPath = process.argv[2];

  if (!artifactPath) {
    console.log('Usage: npx ts-node src/jobs/init-merkle-distribution.ts <artifact-path>');
    console.log('');
    console.log('Creates a single Squads multisig proposal that:');
    console.log('  1. Initializes the on-chain distribution with Merkle root');
    console.log('  2. Funds the distribution vault');
    console.log('');
    console.log('Example:');
    console.log('  npx ts-node src/jobs/init-merkle-distribution.ts distributions/ORE_W51_TEST_merkle.json');
    process.exit(1);
  }

  // Load environment
  const rpcConfig = getRpcConfigFromEnv();
  const rpc = new FailoverConnection(rpcConfig);

  const multisigAddr = process.env.SQUADS_MULTISIG!;
  const vaultAddr = process.env.SQUAD_VAULT_ADDRESS!;
  const keypairPath = process.env.SQUADS_MEMBER_KEYPAIR!;
  const programIdStr = process.env.MERKLE_PROGRAM_ID;

  assert(multisigAddr, 'Missing SQUADS_MULTISIG');
  assert(vaultAddr, 'Missing SQUAD_VAULT_ADDRESS');
  assert(keypairPath, 'Missing SQUADS_MEMBER_KEYPAIR');

  // Load artifact
  if (!fs.existsSync(artifactPath)) {
    console.error(`❌ Artifact not found: ${artifactPath}`);
    process.exit(1);
  }

  const artifact = loadArtifact(artifactPath);
  const validation = validateArtifact(artifact);

  if (!validation.valid) {
    console.error('❌ Invalid artifact:');
    validation.errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  console.log('🔐 Merkle Distribution Initialization\n');
  console.log(`RPC: ${rpc.getCurrentUrl()}${rpc.hasBackup() ? ' (backup configured)' : ''}\n`);

  // Setup
  const multisigPda = new PublicKey(multisigAddr);
  const vaultAuthority = new PublicKey(vaultAddr);
  const member = loadKeypair(keypairPath);
  const programId = programIdStr
    ? new PublicKey(programIdStr)
    : new PublicKey('11111111111111111111111111111111'); // Placeholder

  const mint = new PublicKey(artifact.mint);
  const totalAmount = BigInt(artifact.totalAmount);

  // Get token info
  const mintInfo = await rpc.execute(
    (connection) => getMint(connection, mint),
    'getMint'
  );
  const decimals = mintInfo.decimals;
  const tokenInfo = getTokenByMint(artifact.mint);
  const symbol = tokenInfo?.symbol || 'UNKNOWN';

  console.log('Distribution Details:');
  console.log(`  ID:           ${artifact.distributionId}`);
  console.log(`  Reward:       ${artifact.rewardId}`);
  console.log(`  Token:        ${symbol} (${mint.toBase58()})`);
  console.log(`  Amount:       ${fromRawAmount(totalAmount, decimals)} ${symbol}`);
  console.log(`  Recipients:   ${artifact.numRecipients}`);
  console.log(`  Merkle Root:  ${artifact.merkleRoot}`);
  console.log('');

  // Derive PDAs
  const distributionIdBuffer = Buffer.from(artifact.distributionId, 'hex');
  const merkleRootBuffer = Buffer.from(artifact.merkleRoot, 'hex');

  const [distributionPda] = getDistributionPda(programId, distributionIdBuffer);
  const [vaultPda] = getVaultPda(programId, distributionIdBuffer);

  console.log('On-Chain Addresses:');
  console.log(`  Distribution: ${distributionPda.toBase58()}`);
  console.log(`  Vault:        ${vaultPda.toBase58()}`);
  console.log('');

  // Get source vault ATA
  const sourceAta = getAssociatedTokenAddressSync(mint, vaultAuthority, true);

  // Check source balance
  const sourceInfo = await rpc.execute(
    (connection) => connection.getParsedAccountInfo(sourceAta),
    'getSourceInfo'
  );
  if (!sourceInfo.value) {
    console.error(`❌ Squad vault has no ATA for ${symbol}`);
    process.exit(1);
  }

  const sourceBalance = BigInt(
    (sourceInfo.value.data as any).parsed.info.tokenAmount.amount
  );
  const humanBalance = fromRawAmount(sourceBalance, decimals);

  console.log(`Squad Vault Balance: ${humanBalance} ${symbol}`);

  if (sourceBalance < totalAmount) {
    console.error(`❌ Insufficient balance. Need ${fromRawAmount(totalAmount, decimals)} ${symbol}`);
    process.exit(1);
  }

  console.log('');
  console.log('-'.repeat(60));

  // Fetch current multisig transaction index
  const multisigInfo = await rpc.execute(
    (connection) => multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda),
    'getMultisigInfo'
  );

  const nextTransactionIndex = BigInt(Number(multisigInfo.transactionIndex)) + 1n;

  // Build both instructions
  const initIx = buildInitializeInstruction(
    programId,
    vaultAuthority,
    distributionPda,
    mint,
    vaultPda,
    distributionIdBuffer,
    merkleRootBuffer,
    totalAmount,
    artifact.numRecipients
  );

  const fundIx = createTransferCheckedInstruction(
    sourceAta,
    mint,
    vaultPda,
    vaultAuthority,
    totalAmount,
    decimals
  );

  // === SINGLE PROPOSAL: Initialize + Fund Distribution ===
  console.log('\n📝 Creating Proposal: Initialize + Fund Distribution');
  console.log('   Instructions:');
  console.log('     1. Initialize Merkle distribution (set Merkle root on-chain)');
  console.log(`     2. Fund vault with ${fromRawAmount(totalAmount, decimals)} ${symbol}`);

  const { blockhash } = await rpc.execute(
    (connection) => connection.getLatestBlockhash(),
    'getLatestBlockhash'
  );

  const combinedMessage = new TransactionMessage({
    payerKey: vaultAuthority,
    recentBlockhash: blockhash,
    instructions: [initIx, fundIx],  // Initialize first, then fund
  });

  // Use current connection for multisig operations
  const connection = rpc.connection;

  const vaultTxSig = await multisig.rpc.vaultTransactionCreate({
    connection,
    feePayer: member,
    multisigPda,
    transactionIndex: nextTransactionIndex,
    creator: member.publicKey,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage: combinedMessage,
    memo: `Merkle distribution: ${artifact.rewardId} (${fromRawAmount(totalAmount, decimals)} ${symbol} to ${artifact.numRecipients} recipients)`,
  });

  await connection.confirmTransaction(vaultTxSig, 'confirmed');

  const proposalSig = await multisig.rpc.proposalCreate({
    connection,
    feePayer: member,
    multisigPda,
    transactionIndex: nextTransactionIndex,
    creator: member,
  });

  await connection.confirmTransaction(proposalSig, 'confirmed');

  console.log(`  ✓ Created (txIndex=${nextTransactionIndex})`);

  // Update database
  try {
    await pool.query(
      `
      UPDATE merkle_distributions
      SET
        on_chain_address = $2,
        vault_ata = $3,
        status = 'funded',
        funded_at = NOW()
      WHERE distribution_id = $1
      `,
      [artifact.distributionId, distributionPda.toBase58(), vaultPda.toBase58()]
    );
    console.log('\n✓ Database updated');
  } catch (error: any) {
    console.log('\n⚠️  Database update skipped:', error.message);
  }

  console.log('');
  console.log('-'.repeat(60));
  console.log('\n✅ Proposal created successfully!');
  console.log('');
  console.log('Next Steps:');
  console.log('  1. Review and approve the proposal in Squads UI');
  console.log('  2. Execute the proposal (initializes distribution + funds vault)');
  console.log('  3. Run relayer to process claims:');
  console.log(`     npx ts-node src/jobs/run-merkle-relayer.ts ${artifactPath}`);
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

