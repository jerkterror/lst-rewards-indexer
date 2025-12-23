// src/jobs/create-reward.ts
import 'dotenv/config';
import { pool } from '../db';
import { getTokenBySymbol, toRawAmount, KNOWN_TOKENS } from '../config/tokens';
import * as readline from 'readline';

// Parse command line arguments
function parseArgs(): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) {
      const key = process.argv[i].slice(2);
      const value = process.argv[i + 1];
      if (value && !value.startsWith('--')) {
        args[key] = value;
        i++;
      }
    }
  }
  return args;
}

// Compute current ISO week window ID
function computeCurrentWindowId(): string {
  const now = new Date();
  const date = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));

  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    (((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7
  );

  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// Prompt user for input
async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// List existing rewards
async function listRewards() {
  const { rows } = await pool.query(`
    SELECT
      r.reward_id,
      r.window_id,
      r.mint,
      r.total_amount,
      r.eligibility_mode,
      r.label,
      CASE
        WHEN EXISTS (SELECT 1 FROM reward_dust_ledger WHERE reward_id = r.reward_id)
        THEN 'processed'
        ELSE 'pending'
      END as status
    FROM reward_configs r
    ORDER BY r.created_at DESC
    LIMIT 10
  `);

  console.log('\n📋 Recent Rewards:');
  console.log('━'.repeat(80));

  if (rows.length === 0) {
    console.log('No rewards configured yet');
  } else {
    for (const row of rows) {
      console.log(`${row.reward_id.padEnd(20)} ${row.window_id.padEnd(12)} ${row.status.padEnd(12)} ${row.label || ''}`);
    }
  }

  console.log('━'.repeat(80));
}

// Main function
async function main() {
  const args = parseArgs();

  // Handle --list flag
  if (args.list !== undefined) {
    await listRewards();
    process.exit(0);
  }

  console.log('\n🎁 Reward Configuration Tool\n');

  // Get token symbol (required)
  let tokenSymbol = args.token;
  if (!tokenSymbol) {
    console.log('Available tokens:', Object.keys(KNOWN_TOKENS).join(', '));
    tokenSymbol = await prompt('Reward token symbol (e.g., ORE, USDC): ');
  }

  const tokenInfo = getTokenBySymbol(tokenSymbol);
  if (!tokenInfo) {
    console.error(`❌ Unknown token: ${tokenSymbol}`);
    console.log('Known tokens:', Object.keys(KNOWN_TOKENS).join(', '));
    console.log('Or provide full mint address with --mint flag');
    process.exit(1);
  }

  // Get reward amount (required)
  let amountStr = args.amount;
  if (!amountStr) {
    amountStr = await prompt(`Reward amount (in ${tokenSymbol}, e.g., 7): `);
  }

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount <= 0) {
    console.error('❌ Invalid amount');
    process.exit(1);
  }

  const rawAmount = toRawAmount(amount, tokenInfo.decimals);

  // Get window ID (default: current)
  let windowId = args.window;
  if (!windowId) {
    const currentWindow = computeCurrentWindowId();
    const useCurrentStr = await prompt(`Use current window ${currentWindow}? (Y/n): `);
    windowId = useCurrentStr.toLowerCase() === 'n'
      ? await prompt('Window ID (YYYY-WNN): ')
      : currentWindow;
  }

  // Get eligibility mode (default: all-weighted)
  let eligibilityMode = args.eligibility || args['eligibility-mode'];
  if (!eligibilityMode) {
    const modeStr = await prompt('Eligibility mode (all-weighted / eligible-only) [all-weighted]: ');
    eligibilityMode = modeStr || 'all-weighted';
  }

  if (!['all-weighted', 'all_weighted', 'eligible-only', 'eligible_only'].includes(eligibilityMode)) {
    console.error('❌ Invalid eligibility mode. Use "all-weighted" or "eligible-only"');
    process.exit(1);
  }

  // Normalize to underscore format for database
  eligibilityMode = eligibilityMode.replace('-', '_');

  // Get eligibility token requirements (optional)
  let eligibilityTokenMint: string | null = null;
  let eligibilityTokenMinAmount: bigint | null = null;

  if (eligibilityMode === 'eligible_only') {
    let eligTokenSymbol = args['eligibility-token'];
    if (!eligTokenSymbol) {
      eligTokenSymbol = await prompt('Eligibility token symbol (e.g., ORE) [none]: ');
    }

    if (eligTokenSymbol && eligTokenSymbol !== 'none') {
      const eligTokenInfo = getTokenBySymbol(eligTokenSymbol);
      if (!eligTokenInfo) {
        console.error(`❌ Unknown eligibility token: ${eligTokenSymbol}`);
        process.exit(1);
      }

      eligibilityTokenMint = eligTokenInfo.mint;

      let eligAmountStr = args['eligibility-amount'];
      if (!eligAmountStr) {
        eligAmountStr = await prompt(`Minimum ${eligTokenSymbol} required (e.g., 1): `);
      }

      const eligAmount = parseFloat(eligAmountStr);
      if (isNaN(eligAmount) || eligAmount < 0) {
        console.error('❌ Invalid eligibility amount');
        process.exit(1);
      }

      eligibilityTokenMinAmount = toRawAmount(eligAmount, eligTokenInfo.decimals);
    }
  }

  // Get label (optional)
  let label = args.label;
  if (!label) {
    const defaultLabel = `${tokenSymbol} rewards - ${windowId}`;
    label = await prompt(`Label [${defaultLabel}]: `) || defaultLabel;
  }

  // Generate reward ID (or use provided one)
  let rewardId = args['reward-id'];
  if (!rewardId) {
    const defaultRewardId = `${tokenSymbol}_${windowId.replace('-', '_')}`;
    rewardId = await prompt(`Reward ID [${defaultRewardId}]: `) || defaultRewardId;
  }

  // Show preview
  console.log('\n🎁 Reward Configuration Preview:');
  console.log('━'.repeat(80));
  console.log(`Reward ID:       ${rewardId}`);
  console.log(`Window:          ${windowId}`);
  console.log(`Token:           ${tokenSymbol} (${tokenInfo.mint})`);
  console.log(`Amount:          ${amount} ${tokenSymbol} (${rawAmount} raw units)`);
  console.log(`Eligibility:     ${eligibilityMode.replace('_', '-')}`);

  if (eligibilityTokenMint && eligibilityTokenMinAmount) {
    const eligTokenInfo = getTokenBySymbol(Object.keys(KNOWN_TOKENS).find(
      k => KNOWN_TOKENS[k].mint === eligibilityTokenMint
    ) || '');
    console.log(`Requires:        ${eligibilityTokenMinAmount} raw units (${eligTokenInfo?.symbol || 'unknown'})`);
  }

  console.log(`Label:           ${label}`);
  console.log('━'.repeat(80));

  // Confirm
  if (!args['dry-run']) {
    const confirm = await prompt('\n✅ Create this reward? (y/N): ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('❌ Cancelled');
      process.exit(0);
    }

    // Insert into database
    await pool.query(
      `
      INSERT INTO reward_configs (
        reward_id,
        window_id,
        mint,
        total_amount,
        eligibility_mode,
        eligibility_token_mint,
        eligibility_token_min_amount,
        label
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        rewardId,
        windowId,
        tokenInfo.mint,
        rawAmount.toString(),
        eligibilityMode,
        eligibilityTokenMint,
        eligibilityTokenMinAmount?.toString() || null,
        label,
      ]
    );

    console.log('\n✅ Reward created successfully!');
    console.log(`\nNext steps:`);
    console.log(`  1. Run: npx ts-node src/jobs/compute-reward-payouts.ts`);
    console.log(`  2. Export: npx ts-node src/jobs/export-reward-csv.ts ${rewardId}`);
  } else {
    console.log('\n✅ Dry run - no changes made');
  }
}

main()
  .catch((e) => {
    console.error('❌ Error:', e.message);
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
