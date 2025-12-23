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

// Calculate number of weeks in range (inclusive)
function getWeekCount(start: string, end: string): number {
  // Parse YYYY-WNN format
  const parseWeek = (w: string) => {
    const [year, week] = w.split('-W').map(Number);
    return year * 100 + week;
  };

  const startNum = parseWeek(start);
  const endNum = parseWeek(end);

  // Simple approximation - works for most cases within same year
  return Math.abs(endNum - startNum) + 1;
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
      r.window_start,
      r.window_end,
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

  console.log('\nRecent Rewards:');
  console.log('-'.repeat(80));

  if (rows.length === 0) {
    console.log('No rewards configured yet');
  } else {
    for (const row of rows) {
      const windowDisplay = row.window_start === row.window_end
        ? row.window_start
        : `${row.window_start}-${row.window_end}`;
      console.log(`${row.reward_id.padEnd(30)} ${windowDisplay.padEnd(20)} ${row.status.padEnd(12)} ${row.label || ''}`);
    }
  }

  console.log('-'.repeat(80));
}

// Main function
async function main() {
  const args = parseArgs();

  // Handle --list flag
  if (args.list !== undefined) {
    await listRewards();
    process.exit(0);
  }

  console.log('\nReward Configuration Tool\n');

  // Get token symbol (required)
  let tokenSymbol = args.token;
  if (!tokenSymbol) {
    console.log('Available tokens:', Object.keys(KNOWN_TOKENS).join(', '));
    tokenSymbol = await prompt('Reward token symbol (e.g., ORE, USDC): ');
  }

  const tokenInfo = getTokenBySymbol(tokenSymbol);
  if (!tokenInfo) {
    console.error(`Unknown token: ${tokenSymbol}`);
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
    console.error('Invalid amount');
    process.exit(1);
  }

  const rawAmount = toRawAmount(amount, tokenInfo.decimals);

  // Get window range (default: current week only)
  let windowStart = args['window-start'];
  let windowEnd = args['window-end'];

  if (!windowStart && !windowEnd) {
    const currentWindow = computeCurrentWindowId();
    console.log(`\nWindow configuration:`);
    console.log(`  1. Current week only (${currentWindow})`);
    console.log(`  2. Custom range`);
    const choice = await prompt('Choice [1]: ') || '1';

    if (choice === '2') {
      windowStart = await prompt('Start window (YYYY-WNN): ');
      windowEnd = await prompt('End window (YYYY-WNN): ');
    } else {
      windowStart = currentWindow;
      windowEnd = currentWindow;
    }
  } else if (windowStart && !windowEnd) {
    // Only start provided, use it for both (single week)
    windowEnd = windowStart;
  } else if (!windowStart && windowEnd) {
    // Only end provided, use it for both (single week)
    windowStart = windowEnd;
  }

  // Validate window range
  if (windowStart > windowEnd) {
    console.error('❌ Invalid range: window-start must be <= window-end');
    process.exit(1);
  }

  // Get eligibility mode (default: all-weighted)
  let eligibilityMode = args.eligibility || args['eligibility-mode'];
  if (!eligibilityMode) {
    const modeStr = await prompt('Eligibility mode - (a)ll-weighted / (e)ligible-only [a]: ');
    if (modeStr.toLowerCase() === 'e') {
      eligibilityMode = 'eligible-only';
    } else {
      eligibilityMode = 'all-weighted';
    }
  }

  if (!['all-weighted', 'all_weighted', 'eligible-only', 'eligible_only'].includes(eligibilityMode)) {
    console.error('Invalid eligibility mode. Use "a" for all-weighted or "e" for eligible-only');
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
        console.error(`Unknown eligibility token: ${eligTokenSymbol}`);
        process.exit(1);
      }

      eligibilityTokenMint = eligTokenInfo.mint;

      let eligAmountStr = args['eligibility-amount'];
      if (!eligAmountStr) {
        eligAmountStr = await prompt(`Minimum ${eligTokenSymbol} required (e.g., 1): `);
      }

      const eligAmount = parseFloat(eligAmountStr);
      if (isNaN(eligAmount) || eligAmount < 0) {
        console.error('Invalid eligibility amount');
        process.exit(1);
      }

      eligibilityTokenMinAmount = toRawAmount(eligAmount, eligTokenInfo.decimals);
    }
  }

  // Get label (optional)
  let label = args.label;
  if (!label) {
    const windowDisplay = windowStart === windowEnd ? windowStart : `${windowStart} to ${windowEnd}`;
    const defaultLabel = `${tokenSymbol} rewards - ${windowDisplay}`;
    label = await prompt(`Label [${defaultLabel}]: `) || defaultLabel;
  }

  // Generate reward ID (or use provided one)
  let rewardId = args['reward-id'];
  if (!rewardId) {
    const windowPart = windowStart === windowEnd
      ? windowStart.replace(/-/g, '_')
      : `${windowStart.replace(/-/g, '_')}_to_${windowEnd.replace(/-/g, '_')}`;
    const defaultRewardId = `${tokenSymbol}_${windowPart}`;
    rewardId = await prompt(`Reward ID [${defaultRewardId}]: `) || defaultRewardId;
  }

  // Show preview
  console.log('\nReward Configuration Preview:');
  console.log('-'.repeat(80));
  console.log(`Reward ID:       ${rewardId}`);
  const windowDisplay = windowStart === windowEnd
    ? `${windowStart} (single week)`
    : `${windowStart} to ${windowEnd} (${getWeekCount(windowStart, windowEnd)} weeks)`;
  console.log(`Window Range:    ${windowDisplay}`);
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
  console.log('-'.repeat(80));

  // Confirm
  if (!args['dry-run']) {
    const confirm = await prompt('\nCreate this reward? (y/n): ');
    if (confirm.toLowerCase() !== 'y') {
      console.log('Cancelled');
      process.exit(0);
    }

    // Insert into database
    await pool.query(
      `
      INSERT INTO reward_configs (
        reward_id,
        window_start,
        window_end,
        mint,
        total_amount,
        eligibility_mode,
        eligibility_token_mint,
        eligibility_token_min_amount,
        label
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        rewardId,
        windowStart,
        windowEnd,
        tokenInfo.mint,
        rawAmount.toString(),
        eligibilityMode,
        eligibilityTokenMint,
        eligibilityTokenMinAmount?.toString() || null,
        label,
      ]
    );

    console.log('\nReward created successfully!');
    console.log(`\nNext steps:`);
    console.log(`  1. Run: npx ts-node src/jobs/compute-reward-payouts.ts`);
    console.log(`  2. Export: npx ts-node src/jobs/export-reward-csv.ts ${rewardId}`);
  } else {
    console.log('\nDry run - no changes made');
  }
}

main()
  .catch((e) => {
    console.error('Error:', e.message);
    process.exit(1);
  })
  .finally(() => {
    pool.end();
  });
