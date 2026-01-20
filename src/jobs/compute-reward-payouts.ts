// src/jobs/compute-reward-payouts.ts
import 'dotenv/config';
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
    clause: `AND w.wallet NOT IN (${placeholders})`,
    params: ignoredWallets,
  };
}

async function computeRewardPayouts() {
  console.log('Computing reward payout previews (with dust carry-forward)...');

  // Get ignored wallets - these are excluded from all payout calculations
  const ignoredWallets = getIgnoredWalletsArray();
  if (ignoredWallets.length > 0) {
    console.log(`Excluding ${ignoredWallets.length} ignored wallet(s) from payouts`);
  }

  // Fetch all rewards in creation order
  const rewards = await pool.query<{
    reward_id: string;
    window_start: string;
    window_end: string;
    mint: string;
    total_amount: string;
    eligibility_mode: 'eligible_only' | 'all_weighted';
    eligibility_token_mint: string | null;
    eligibility_token_min_amount: string | null;
  }>(`
    SELECT
      reward_id,
      window_start,
      window_end,
      mint,
      total_amount,
      eligibility_mode,
      eligibility_token_mint,
      eligibility_token_min_amount
    FROM reward_configs
    ORDER BY created_at
  `);

  for (const reward of rewards.rows) {
    // -----------------------------
    // Idempotency: skip if dust ledger already exists
    // -----------------------------
    const existingLedger = await pool.query(
      `SELECT 1 FROM reward_dust_ledger WHERE reward_id = $1`,
      [reward.reward_id]
    );

    if ((existingLedger.rowCount ?? 0) > 0) {
      console.log(`Skipping ${reward.reward_id} (already processed)`);
      continue;
    }

    // -----------------------------
    // Determine carry-in dust (same mint, most recent prior reward)
    // -----------------------------
    const priorDust = await pool.query<{
      carry_out: string;
    }>(`
      SELECT carry_out
      FROM reward_dust_ledger
      WHERE mint = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [reward.mint]);

    const carryIn =
      priorDust.rows.length > 0
        ? BigInt(priorDust.rows[0].carry_out)
        : 0n;

    const configuredTotal = BigInt(reward.total_amount);
    const effectiveTotal = configuredTotal + carryIn;

    console.log(
      `Reward ${reward.reward_id}: configured=${configuredTotal} carry_in=${carryIn} effective=${effectiveTotal}`
    );

    // -----------------------------
    // Clear existing preview payouts (safe to recompute)
    // -----------------------------
    await pool.query(
      `DELETE FROM reward_payouts_preview WHERE reward_id = $1`,
      [reward.reward_id]
    );

    // -----------------------------
    // Compute payouts by aggregating weights across window range
    // -----------------------------
    const windowDisplay = reward.window_start === reward.window_end
      ? reward.window_start
      : `${reward.window_start}-${reward.window_end}`;

    // Build ignore filter for this query (params start at $10)
    const ignoreFilter = buildIgnoreFilter(ignoredWallets, 10);

    const payouts = await pool.query<{
      payout_amount: string;
    }>(`
      -- Aggregate weights across window range (excluding ignored wallets)
      WITH wallet_weights AS (
        SELECT
          w.wallet,
          SUM(w.weight) as total_weight
        FROM weights w
        JOIN wallets wl ON wl.wallet = w.wallet
        WHERE wl.is_system_owned = true
          AND w.window_id >= $3  -- window_start
          AND w.window_id <= $4  -- window_end
          ${ignoreFilter.clause}
        GROUP BY w.wallet
      ),
      -- Apply eligibility filter based on snapshots in the window range
      eligible_wallets AS (
        SELECT DISTINCT snap.wallet
        FROM snapshots snap
        WHERE snap.window_id >= $3
          AND snap.window_id <= $4
          AND (
            -- No eligibility requirement = all wallets eligible
            ($5::text IS NULL AND $6::numeric IS NULL)
            OR
            -- Check specific requirement
            (
              snap.eligibility_token_mint = $5
              AND snap.eligibility_token_amount >= $6
            )
          )
      ),
      -- Compute total weight for share calculation
      total_weight_sum AS (
        SELECT SUM(total_weight) as grand_total
        FROM wallet_weights ww
        WHERE $7 = 'all_weighted'
          OR ww.wallet IN (SELECT wallet FROM eligible_wallets)
      ),
      -- Compute shares
      wallet_shares AS (
        SELECT
          ww.wallet,
          ww.total_weight / tws.grand_total AS share
        FROM wallet_weights ww
        CROSS JOIN total_weight_sum tws
        WHERE tws.grand_total > 0
          AND (
            $7 = 'all_weighted'
            OR ww.wallet IN (SELECT wallet FROM eligible_wallets)
          )
      )
      INSERT INTO reward_payouts_preview (
        reward_id,
        window_id,
        wallet,
        mint,
        share,
        total_amount,
        payout_amount
      )
      SELECT
        $1::text,
        $8::text,  -- window_display
        ws.wallet,
        $9::text,  -- mint
        ws.share,
        $2::numeric,  -- effective_total
        FLOOR(ws.share * $2::numeric) AS payout_amount
      FROM wallet_shares ws
      RETURNING payout_amount
    `, [
      reward.reward_id,           // $1
      effectiveTotal.toString(),  // $2
      reward.window_start,        // $3
      reward.window_end,          // $4
      reward.eligibility_token_mint,        // $5
      reward.eligibility_token_min_amount,  // $6
      reward.eligibility_mode,    // $7
      windowDisplay,              // $8
      reward.mint,                // $9
      ...ignoreFilter.params,     // $10+ ignored wallets
    ]);

    // -----------------------------
    // Sum distributed amount
    // -----------------------------
    const distributed = payouts.rows.reduce(
      (sum, row) => sum + BigInt(row.payout_amount),
      0n
    );

    const carryOut = effectiveTotal - distributed;

    // -----------------------------
    // Record dust accounting (authoritative)
    // -----------------------------
    await pool.query(
      `
      INSERT INTO reward_dust_ledger (
        reward_id,
        mint,
        configured_total,
        carry_in,
        distributed,
        carry_out
      ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        reward.reward_id,
        reward.mint,
        configuredTotal.toString(),
        carryIn.toString(),
        distributed.toString(),
        carryOut.toString(),
      ]
    );

    console.log(
      `Reward ${reward.reward_id}: distributed=${distributed} carry_out=${carryOut}`
    );
  }

  console.log('Reward payout preview computation complete');
}

computeRewardPayouts().catch((e) => {
  console.error(e);
  process.exit(1);
});
