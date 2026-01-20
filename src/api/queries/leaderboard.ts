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
 * Get the current ISO week ID (format: YYYY-WNN)
 */
function getCurrentWindowId(): string {
  const now = new Date();
  const shifted = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const days = Math.floor((shifted.getTime() - jan1.getTime()) / (24 * 60 * 60 * 1000));
  const weekNum = Math.ceil((days + jan1.getUTCDay() + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
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
  const currentWindow = getCurrentWindowId();
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
    ORDER BY rank
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
