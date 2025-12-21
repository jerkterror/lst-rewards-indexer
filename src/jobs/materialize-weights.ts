// src/jobs/materialize-weights.ts
import 'dotenv/config';
import { pool } from '../db';

async function materializeWeights() {
  console.log('Materializing eligible weights...');

  const result = await pool.query(`
    WITH ordered AS (
      SELECT
        s.wallet,
        s.window_id,
        s.amount,
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
        amount,
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
        SUM(amount * seconds_held) AS raw_weight,
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

  console.log(`Inserted ${result.rowCount ?? 0} weight rows`);

  if ((result.rowCount ?? 0) > 0) {
    console.table(result.rows.map(r => ({
      window: r.window_id,
      wallet: r.wallet,
      weight: r.weight.toString(),
    })));
  }
}

materializeWeights().catch((e) => {
  console.error(e);
  process.exit(1);
});
