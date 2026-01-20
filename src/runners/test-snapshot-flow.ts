// src/runners/test-snapshot-flow.ts
// Test runner for the integrated snapshot + classify + weights flow
// Use this to verify the full flow works before relying on the scheduler
//
// Usage:
//   npx ts-node src/runners/test-snapshot-flow.ts
//
// This runs the same tasks as the scheduler but immediately (not on cron)

import 'dotenv/config';
import { runSnapshot } from '../indexers/snapshot';
import { classifyWallets } from '../jobs/classify-wallets';
import { materializeWeights } from '../jobs/materialize-weights';
import { pool } from '../db';

async function testSnapshotFlow() {
  console.log('='.repeat(60));
  console.log('TEST: Integrated Snapshot Flow');
  console.log('This will run snapshot + classify + materialize weights');
  console.log('='.repeat(60));

  const startTime = new Date();
  console.log(`\nStarted at: ${startTime.toISOString()}\n`);

  // Get counts before
  const beforeSnapshots = await pool.query('SELECT COUNT(*) as count FROM snapshots');
  const beforeWeights = await pool.query('SELECT COUNT(*) as count FROM weights');
  console.log(`Before: ${beforeSnapshots.rows[0].count} snapshots, ${beforeWeights.rows[0].count} weights\n`);

  // Step 1: Take snapshot
  console.log('📸 Step 1: Taking snapshot...');
  console.log('-'.repeat(40));
  try {
    await runSnapshot();
    console.log('✅ Snapshot complete\n');
  } catch (e) {
    console.error('❌ Snapshot failed:', e);
    await pool.end();
    process.exit(1);
  }

  // Step 2: Classify wallets
  console.log('👛 Step 2: Classifying wallets...');
  console.log('-'.repeat(40));
  try {
    const classifyResult = await classifyWallets();
    console.log(`✅ Classified ${classifyResult.classified} wallets (${classifyResult.systemOwned} system-owned)\n`);
  } catch (e) {
    console.error('⚠️  Classification failed:', e);
    console.log('Continuing anyway...\n');
  }

  // Step 3: Materialize weights
  console.log('⚖️  Step 3: Materializing weights...');
  console.log('-'.repeat(40));
  try {
    const weightsResult = await materializeWeights();
    if (weightsResult.inserted > 0) {
      console.log(`✅ Inserted ${weightsResult.inserted} weights for windows: ${weightsResult.windows.join(', ')}\n`);
    } else {
      console.log('✅ Weights up to date (no new entries needed)\n');
    }
  } catch (e) {
    console.error('⚠️  Weight materialization failed:', e);
    console.log('');
  }

  // Get counts after
  const afterSnapshots = await pool.query('SELECT COUNT(*) as count FROM snapshots');
  const afterWeights = await pool.query('SELECT COUNT(*) as count FROM weights');

  const endTime = new Date();
  const duration = (endTime.getTime() - startTime.getTime()) / 1000;

  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Duration: ${duration.toFixed(1)} seconds`);
  console.log(`Snapshots: ${beforeSnapshots.rows[0].count} → ${afterSnapshots.rows[0].count} (+${afterSnapshots.rows[0].count - beforeSnapshots.rows[0].count})`);
  console.log(`Weights: ${beforeWeights.rows[0].count} → ${afterWeights.rows[0].count} (+${afterWeights.rows[0].count - beforeWeights.rows[0].count})`);
  console.log('='.repeat(60));

  await pool.end();
}

testSnapshotFlow().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
