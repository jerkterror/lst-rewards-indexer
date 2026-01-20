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
 * Get the current ISO week ID (format: YYYY-WNN)
 * Weeks start on Wednesday at 00:00 UTC (shifted by 2 days from ISO standard)
 */
function getCurrentWindowId(): string {
  const now = new Date();
  // Shift by 2 days so week starts Wednesday
  const shifted = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();

  // Calculate ISO week number
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const days = Math.floor((shifted.getTime() - jan1.getTime()) / (24 * 60 * 60 * 1000));
  const weekNum = Math.ceil((days + jan1.getUTCDay() + 1) / 7);

  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Get global statistics for the rewards program
 */
export async function getGlobalStats(): Promise<GlobalStats> {
  const currentWindow = getCurrentWindowId();

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
