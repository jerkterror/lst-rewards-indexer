import { pool } from '../../db';

export interface LeaderboardEntry {
  rank: number;
  wallet: string;
  walletFull: string;
  weight: string;
  weightPercentage: string;
  projectedReward: {
    amount: string;
    symbol: string;
    displayAmount: string;
  };
}

export interface LeaderboardResponse {
  currentWindow: string;
  totalParticipants: number;
  entries: LeaderboardEntry[];
  pagination: {
    page: number;
    limit: number;
    totalItems: number;
    totalPages: number;
  };
}

/**
 * Get the most recent window that has weight data
 */
async function getMostRecentWindowWithWeights(): Promise<string | null> {
  const result = await pool.query<{ window_id: string }>(
    `SELECT window_id FROM weights ORDER BY window_id DESC LIMIT 1`
  );
  return result.rows[0]?.window_id || null;
}

/**
 * Truncate wallet address for display (e.g., "ABC123...XYZ789")
 */
function truncateWallet(wallet: string): string {
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 6)}...${wallet.slice(-6)}`;
}

/**
 * Get paginated leaderboard of top holders by weight
 */
export async function getLeaderboard(
  page: number = 1,
  limit: number = 25
): Promise<LeaderboardResponse> {
  const currentWindow = await getMostRecentWindowWithWeights() || 'N/A';
  const offset = (page - 1) * limit;

  // Get reward pool config
  const weeklyAmount = process.env.WEEKLY_REWARD_AMOUNT || '3750000000';
  const weeklySymbol = process.env.WEEKLY_REWARD_SYMBOL || 'ORE';
  const weeklyDecimals = 9;

  // Get total count and total weight
  const totalsResult = await pool.query<{ total_count: string; total_weight: string }>(
    `SELECT COUNT(*) as total_count, SUM(weight) as total_weight
     FROM weights
     WHERE window_id = $1`,
    [currentWindow]
  );

  const totalCount = parseInt(totalsResult.rows[0]?.total_count || '0', 10);
  const totalWeight = parseFloat(totalsResult.rows[0]?.total_weight || '0');
  const totalPages = Math.ceil(totalCount / limit);

  // Get paginated leaderboard entries
  // Order by weight DESC to ensure numeric ordering (not string ordering of rank)
  const entriesResult = await pool.query<{
    wallet: string;
    weight: string;
    rank: string;
  }>(
    `WITH ranked AS (
      SELECT wallet, weight,
             RANK() OVER (ORDER BY weight DESC) as rank
      FROM weights
      WHERE window_id = $1
    )
    SELECT wallet, weight::text, rank::text
    FROM ranked
    ORDER BY weight DESC
    LIMIT $2 OFFSET $3`,
    [currentWindow, limit, offset]
  );

  const entries: LeaderboardEntry[] = entriesResult.rows.map((row) => {
    const walletWeightNum = parseFloat(row.weight);

    // Calculate weight percentage
    let weightPercentage = '0';
    let projectedAmount = '0';

    if (totalWeight > 0 && walletWeightNum > 0) {
      const percentage = (walletWeightNum / totalWeight) * 100;
      weightPercentage = percentage.toFixed(4);

      // Calculate projected reward
      const share = walletWeightNum / totalWeight;
      projectedAmount = Math.floor(share * Number(weeklyAmount)).toString();
    }

    const projectedDisplayAmount = (Number(projectedAmount) / 10 ** weeklyDecimals).toFixed(weeklyDecimals);

    return {
      rank: parseInt(row.rank, 10),
      wallet: truncateWallet(row.wallet),
      walletFull: row.wallet,
      weight: row.weight,
      weightPercentage,
      projectedReward: {
        amount: projectedAmount,
        symbol: weeklySymbol,
        displayAmount: projectedDisplayAmount,
      },
    };
  });

  return {
    currentWindow,
    totalParticipants: totalCount,
    entries,
    pagination: {
      page,
      limit,
      totalItems: totalCount,
      totalPages,
    },
  };
}
