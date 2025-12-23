// src/runners/process-pipeline.ts
// Runs the data collection and preparation pipeline
// This prepares snapshot data for reward configuration

import 'dotenv/config';
import { runSnapshot } from '../indexers/snapshot';
import { pool } from '../db';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';

const RPC_URL = process.env.SOLANA_RPC_URL!;
if (!RPC_URL) throw new Error('Missing SOLANA_RPC_URL');

const connection = new Connection(RPC_URL, 'confirmed');

// Parse command line flags
const args = process.argv.slice(2);
const skipSnapshot = args.includes('--skip-snapshot');
const force = args.includes('--force');

console.log('🚀 LST Rewards Pipeline Processor\n');
console.log('This will run the data preparation pipeline:');
console.log('  1. Snapshot balances (if needed)');
console.log('  2. Classify wallets');
console.log('  3. Materialize weights');
console.log('  4. Normalize reward shares\n');

async function classifyWallets() {
  console.log('\n📊 Step 2: Classifying Wallets...');
  console.log('━'.repeat(80));

  const { rows } = await pool.query<{
    wallet: string;
  }>(`
    SELECT wallet
    FROM wallets
    WHERE is_system_owned IS NULL
  `);

  if (rows.length === 0) {
    console.log('✅ No new wallets to classify');
    return;
  }

  console.log(`Found ${rows.length} unclassified wallets`);

  // OPTIMIZED: Batch RPC calls (100 wallets per call)
  const BATCH_SIZE = 100;
  const classifications: Array<{ wallet: string; isSystemOwned: boolean }> = [];

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const pubkeys = batch.map(row => new PublicKey(row.wallet));

    console.log(`  Fetching batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} wallets)...`);

    const accountInfos = await connection.getMultipleAccountsInfo(pubkeys);

    for (let j = 0; j < batch.length; j++) {
      const info = accountInfos[j];
      const wallet = batch[j].wallet;
      const isSystemOwned = info !== null && info.owner.equals(SystemProgram.programId);
      classifications.push({ wallet, isSystemOwned });
    }
  }

  // Batch database update
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { wallet, isSystemOwned } of classifications) {
      await client.query(
        `UPDATE wallets SET is_system_owned = $1 WHERE wallet = $2`,
        [isSystemOwned, wallet]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const systemOwned = classifications.filter(c => c.isSystemOwned).length;
  console.log(`✅ Classified ${rows.length} wallets (${systemOwned} system-owned, ${rows.length - systemOwned} program-owned)`);
}

async function materializeWeights() {
  console.log('\n⚖️  Step 3: Materializing Weights...');
  console.log('━'.repeat(80));

  const result = await pool.query(`
    WITH ordered AS (
      SELECT
        s.wallet,
        s.window_id,
        s.primary_token_amount,
        s.ts,
        LEAD(s.ts) OVER (
          PARTITION BY s.wallet, s.window_id
          ORDER BY s.ts
        ) AS next_ts
      FROM snapshots s
      JOIN wallets w ON w.wallet = s.wallet
      WHERE
        w.is_system_owned = true
    ),
    durations AS (
      SELECT
        wallet,
        window_id,
        primary_token_amount,
        ts,
        COALESCE(next_ts, ts + INTERVAL '6 hours') AS end_ts,
        EXTRACT(EPOCH FROM (
          COALESCE(next_ts, ts + INTERVAL '6 hours') - ts
        )) AS seconds_held
      FROM ordered
    ),
    aggregated AS (
      SELECT
        wallet,
        window_id,
        SUM(primary_token_amount * seconds_held) AS raw_weight,
        MAX(end_ts) AS last_ts
      FROM durations
      GROUP BY wallet, window_id
    )
    INSERT INTO weights (window_id, wallet, weight, last_ts)
    SELECT
      window_id,
      wallet,
      raw_weight,
      last_ts
    FROM aggregated
    ON CONFLICT (window_id, wallet) DO NOTHING
    RETURNING window_id, wallet, weight;
  `);

  const count = result.rowCount ?? 0;
  if (count > 0) {
    const windows = [...new Set(result.rows.map(r => r.window_id))];
    console.log(`✅ Computed ${count} weight entries for ${windows.length} window(s): ${windows.join(', ')}`);
  } else {
    console.log('✅ No new weights to compute (already up to date)');
  }
}

async function normalizeShares() {
  console.log('\n📈 Step 4: Normalizing Reward Shares...');
  console.log('━'.repeat(80));

  const result = await pool.query(`
    WITH totals AS (
      SELECT
        window_id,
        SUM(weight) AS total_weight
      FROM weights
      GROUP BY window_id
    )
    INSERT INTO reward_shares (
      window_id,
      wallet,
      share,
      weight,
      total_weight
    )
    SELECT
      w.window_id,
      w.wallet,
      w.weight / t.total_weight AS share,
      w.weight,
      t.total_weight
    FROM weights w
    JOIN totals t
      ON t.window_id = w.window_id
    ON CONFLICT (window_id, wallet) DO NOTHING
    RETURNING window_id, wallet, share;
  `);

  const count = result.rowCount ?? 0;
  if (count > 0) {
    const windows = [...new Set(result.rows.map(r => r.window_id))];
    console.log(`✅ Normalized ${count} share entries for ${windows.length} window(s): ${windows.join(', ')}`);
  } else {
    console.log('✅ No new shares to normalize (already up to date)');
  }
}

async function main() {
  try {
    // Step 1: Snapshot (optional)
    if (!skipSnapshot) {
      console.log('\n📸 Step 1: Taking Snapshot...');
      console.log('━'.repeat(80));
      await runSnapshot();
    } else {
      console.log('\n📸 Step 1: Skipping Snapshot (--skip-snapshot flag)');
      console.log('━'.repeat(80));
    }

    // Step 2: Classify wallets
    await classifyWallets();

    // Step 3: Materialize weights
    await materializeWeights();

    // Step 4: Normalize shares
    await normalizeShares();

    // Summary
    console.log('\n✅ Pipeline Complete!');
    console.log('━'.repeat(80));
    console.log('\nYour data is ready for reward configuration.');
    console.log('\nNext steps:');
    console.log('  1. Create reward: npx ts-node src/jobs/create-reward.ts');
    console.log('  2. Compute payouts: npx ts-node src/jobs/compute-reward-payouts.ts');
    console.log('  3. Export CSV: npx ts-node src/jobs/export-reward-csv.ts <REWARD_ID>');

  } catch (error) {
    console.error('\n❌ Pipeline failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
