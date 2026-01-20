// src/jobs/export-reward-csv.ts
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { pool } from '../db';
import { getIgnoredWalletsArray } from '../api/queries/ignored-wallets';

/**
 * Build SQL clause and params for excluding ignored wallets
 */
function buildIgnoreFilter(ignoredWallets: string[], startParam: number): {
  clause: string;
  params: string[];
} {
  if (ignoredWallets.length === 0) {
    return { clause: '', params: [] };
  }
  const placeholders = ignoredWallets.map((_, i) => `$${startParam + i}`).join(', ');
  return {
    clause: `AND p.wallet NOT IN (${placeholders})`,
    params: ignoredWallets,
  };
}

async function exportRewardCsv() {
  const rewardId = process.argv[2];
  if (!rewardId) {
    throw new Error('Usage: ts-node export-reward-csv.ts <REWARD_ID>');
  }

  // Get ignored wallets - exclude from CSV export as safety net
  const ignoredWallets = getIgnoredWalletsArray();
  const ignoreFilter = buildIgnoreFilter(ignoredWallets, 2);

  if (ignoredWallets.length > 0) {
    console.log(`Excluding ${ignoredWallets.length} ignored wallet(s) from CSV`);
  }

  const { rows } = await pool.query(`
    SELECT
      p.wallet,
      p.mint,
      p.payout_amount,
      p.reward_id,
      p.window_id
    FROM reward_payouts_preview p
    WHERE p.reward_id = $1
      AND p.payout_amount > 0
      ${ignoreFilter.clause}
    ORDER BY p.payout_amount DESC
  `, [rewardId, ...ignoreFilter.params]);

  if (rows.length === 0) {
    console.log('No payouts found for reward:', rewardId);
    return;
  }

  const header = [
    'wallet',
    'mint',
    'amount',
    'reward_id',
    'window_id',
  ];

  const lines = [
    header.join(','),
    ...rows.map(r =>
      [
        r.wallet,
        r.mint,
        r.payout_amount.toString(),
        r.reward_id,
        r.window_id,
      ].join(',')
    ),
  ];

  const outDir = path.join(process.cwd(), 'exports');
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, `${rewardId}.csv`);
  fs.writeFileSync(outPath, lines.join('\n'));

  console.log(`CSV exported to ${outPath}`);
}

exportRewardCsv().catch((e) => {
  console.error(e);
  process.exit(1);
});
