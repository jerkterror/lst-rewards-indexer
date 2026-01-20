// src/jobs/materialize-weights.ts
// Computes time-weighted stake for each wallet per window
// Can be run standalone or imported as a module

import 'dotenv/config';
import { pool } from '../db';

export interface WeightResult {
  inserted: number;
  windows: string[];
}

export async function materializeWeights(): Promise<WeightResult> {
  console.log('Materializing eligible weights...');

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

  const inserted = result.rowCount ?? 0;
  const windows = [...new Set(result.rows.map(r => r.window_id))];

  console.log(`Inserted ${inserted} weight rows`);

  if (inserted > 0) {
    console.log(`Windows updated: ${windows.join(', ')}`);
  }

  return { inserted, windows };
}

// Run directly if this is the main module
if (require.main === module) {
  materializeWeights()
    .then((result) => {
      console.log(`Result: ${result.inserted} rows inserted for windows: ${result.windows.join(', ') || 'none'}`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
