import { pool } from '../../db';

export interface GlobalStats {
  currentWindow: string;
  totalEligibleHolders: number;
  totalWeight: string;
  weeklyRewardPool: {
    amount: string;
    symbol: string;
    decimals: number;
    displayAmount: string;
  };
  lastSnapshotAt: string | null;
  nextSnapshotAt: string | null;
}

/**
 * Get the most recent window that has weight data
 * This ensures we always show data that exists, regardless of window calculation timing
 */
async function getMostRecentWindowWithWeights(): Promise<string | null> {
  const result = await pool.query<{ window_id: string }>(
    `SELECT window_id FROM weights ORDER BY window_id DESC LIMIT 1`
  );
  return result.rows[0]?.window_id || null;
}

/**
 * Get global statistics for the rewards program
 */
export async function getGlobalStats(): Promise<GlobalStats> {
  // Get the most recent window with weight data
  const currentWindow = await getMostRecentWindowWithWeights() || 'N/A';

  // Get reward pool config from environment
  const weeklyAmount = process.env.WEEKLY_REWARD_AMOUNT || '3750000000';
  const weeklySymbol = process.env.WEEKLY_REWARD_SYMBOL || 'ORE';
  const weeklyDecimals = 9;
  const displayAmount = (Number(weeklyAmount) / 10 ** weeklyDecimals).toString();

  // Run queries in parallel for efficiency
  const [eligibleResult, weightResult, snapshotResult] = await Promise.all([
    // Count eligible holders in current window
    pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT wallet) as count
       FROM snapshots
       WHERE window_id = $1 AND eligible = true`,
      [currentWindow]
    ),

    // Sum of all weights in current window
    pool.query<{ total_weight: string | null }>(
      `SELECT SUM(weight) as total_weight
       FROM weights
       WHERE window_id = $1`,
      [currentWindow]
    ),

    // Last snapshot timestamp
    pool.query<{ last_ts: Date | null }>(
      `SELECT MAX(ts) as last_ts FROM snapshots`
    ),
  ]);

  const totalEligibleHolders = parseInt(eligibleResult.rows[0]?.count || '0', 10);
  const totalWeight = weightResult.rows[0]?.total_weight || '0';
  const lastSnapshotAt = snapshotResult.rows[0]?.last_ts?.toISOString() || null;

  // Calculate next snapshot (every 6 hours: 0, 6, 12, 18 UTC)
  let nextSnapshotAt: string | null = null;
  if (lastSnapshotAt) {
    const lastTs = new Date(lastSnapshotAt);
    const nextTs = new Date(lastTs.getTime() + 6 * 60 * 60 * 1000);
    nextSnapshotAt = nextTs.toISOString();
  }

  return {
    currentWindow,
    totalEligibleHolders,
    totalWeight,
    weeklyRewardPool: {
      amount: weeklyAmount,
      symbol: weeklySymbol,
      decimals: weeklyDecimals,
      displayAmount,
    },
    lastSnapshotAt,
    nextSnapshotAt,
  };
}
