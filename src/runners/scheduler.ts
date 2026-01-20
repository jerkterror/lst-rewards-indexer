// src/runners/scheduler.ts
// Runs snapshots every 6 hours, then processes weights automatically

import cron from 'node-cron';
import { runSnapshot } from '../indexers/snapshot';
import { classifyWallets } from '../jobs/classify-wallets';
import { materializeWeights } from '../jobs/materialize-weights';

console.log('='.repeat(60));
console.log('LST Rewards Scheduler');
console.log('Schedule: Snapshots every 6 hours (0, 6, 12, 18 UTC)');
console.log('Post-snapshot: Classify wallets + Materialize weights');
console.log('='.repeat(60));

async function runScheduledTasks() {
  const startTime = new Date();
  console.log(`\n[${startTime.toISOString()}] Starting scheduled tasks...`);

  // Step 1: Take snapshot (critical - must succeed)
  console.log('\n📸 Step 1: Taking snapshot...');
  try {
    await runSnapshot();
    console.log('✅ Snapshot complete');
  } catch (e) {
    console.error('❌ Snapshot failed:', e);
    // Don't continue if snapshot fails - this is the critical data
    return;
  }

  // Step 2: Classify any new wallets (safe to fail - doesn't affect snapshot data)
  console.log('\n👛 Step 2: Classifying new wallets...');
  try {
    const classifyResult = await classifyWallets();
    console.log(`✅ Classified ${classifyResult.classified} wallets (${classifyResult.systemOwned} system-owned)`);
  } catch (e) {
    console.error('⚠️  Wallet classification failed (non-critical):', e);
    // Continue anyway - weights can still be computed for already-classified wallets
  }

  // Step 3: Materialize weights (safe to fail - can be recomputed later)
  console.log('\n⚖️  Step 3: Materializing weights...');
  try {
    const weightsResult = await materializeWeights();
    if (weightsResult.inserted > 0) {
      console.log(`✅ Computed ${weightsResult.inserted} weight entries for: ${weightsResult.windows.join(', ')}`);
    } else {
      console.log('✅ Weights up to date (no new entries)');
    }
  } catch (e) {
    console.error('⚠️  Weight materialization failed (non-critical):', e);
  }

  const endTime = new Date();
  const duration = (endTime.getTime() - startTime.getTime()) / 1000;
  console.log(`\n[${endTime.toISOString()}] Scheduled tasks complete (${duration.toFixed(1)}s)\n`);
}

// Schedule: every 6 hours at minute 0
cron.schedule('0 */6 * * *', async () => {
  await runScheduledTasks();
});

// Uncomment for testing (runs every minute):
// cron.schedule('* * * * *', async () => {
//   await runScheduledTasks();
// });
