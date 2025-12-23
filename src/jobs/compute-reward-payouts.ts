// src/jobs/compute-reward-payouts.ts
import 'dotenv/config';
import { pool } from '../db';

async function computeRewardPayouts() {
  console.log('Computing reward payout previews (with dust carry-forward)...');

  // Fetch all rewards in creation order
  const rewards = await pool.query<{
    reward_id: string;
    window_id: string;
    mint: string;
    total_amount: string;
    eligibility_mode: 'eligible_only' | 'all_weighted';
    eligibility_token_mint: string | null;
    eligibility_token_min_amount: string | null;
  }>(`
    SELECT
      reward_id,
      window_id,
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
    // Compute payouts using effective total and per-reward eligibility
    // -----------------------------
    const payouts = await pool.query<{
      payout_amount: string;
    }>(`
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
        r.reward_id,
        r.window_id,
        s.wallet,
        r.mint,
        s.share,
        $1::numeric AS total_amount,
        FLOOR(s.share * $1::numeric) AS payout_amount
      FROM reward_configs r
      JOIN reward_shares s
        ON s.window_id = r.window_id
      WHERE r.reward_id = $2
        AND (
          r.eligibility_mode = 'all_weighted'
          OR (
            r.eligibility_mode = 'eligible_only'
            AND (
              -- If no eligibility requirement, all wallets are eligible
              (r.eligibility_token_mint IS NULL AND r.eligibility_token_min_amount IS NULL)
              OR
              -- Check if wallet met the specific eligibility requirement
              EXISTS (
                SELECT 1
                FROM snapshots snap
                WHERE
                  snap.wallet = s.wallet
                  AND snap.window_id = r.window_id
                  AND snap.eligibility_token_mint = r.eligibility_token_mint
                  AND snap.eligibility_token_amount >= r.eligibility_token_min_amount
              )
            )
          )
        )
      RETURNING payout_amount
    `, [effectiveTotal.toString(), reward.reward_id]);

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
