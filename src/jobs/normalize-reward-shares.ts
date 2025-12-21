// src/jobs/normalize-reward-shares.ts
import 'dotenv/config';
import { pool } from '../db';

async function normalizeRewardShares() {
  console.log('Normalizing reward shares...');

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

  console.log(`Inserted ${result.rowCount ?? 0} reward share rows`);

  if ((result.rowCount ?? 0) > 0) {
    console.table(result.rows.map(r => ({
      window: r.window_id,
      wallet: r.wallet,
      share: r.share.toString(),
    })));
  }
}

normalizeRewardShares().catch((e) => {
  console.error(e);
  process.exit(1);
});
