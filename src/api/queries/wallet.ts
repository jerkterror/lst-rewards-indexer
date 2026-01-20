import { pool } from '../../db';
import { isWalletIgnored, getIgnoredWalletsArray } from './ignored-wallets';

export interface WalletData {
  wallet: string;
  currentWindow: string;
  isEligible: boolean;
  isIgnored: boolean;
  ignoreMessage?: string;
  weight: string;
  weightPercentage: string;
  rank: number;
  totalHolders: number;
  projectedReward: {
    amount: string;
    symbol: string;
    decimals: number;
    displayAmount: string;
  };
  latestSnapshot: {
    primaryTokenAmount: string;
    eligibilityTokenAmount: string | null;
    eligible: boolean;
    timestamp: string;
  } | null;
}

export interface WalletHistoryEntry {
  rewardId: string;
  windowId: string;
  amount: string;
  symbol: string;
  displayAmount: string;
  distributedAt: string;
}

export interface WalletHistory {
  wallet: string;
  history: WalletHistoryEntry[];
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
    clause: `AND wallet NOT IN (${placeholders})`,
    params: ignoredWallets,
  };
}

/**
 * Get data for a specific wallet
 * Returns isIgnored: true with a message if wallet is in the ignore list
 */
export async function getWalletData(walletAddress: string): Promise<WalletData | null> {
  const currentWindow = await getMostRecentWindowWithWeights() || 'N/A';

  // Check if wallet is ignored/blacklisted
  if (isWalletIgnored(walletAddress)) {
    return {
      wallet: walletAddress,
      currentWindow,
      isEligible: false,
      isIgnored: true,
      ignoreMessage: 'Your wallet is flagged as ineligible. If you think this is a mistake, contact the Layer 33 team.',
      weight: '0',
      weightPercentage: '0',
      rank: 0,
      totalHolders: 0,
      projectedReward: {
        amount: '0',
        symbol: process.env.WEEKLY_REWARD_SYMBOL || 'ORE',
        decimals: 9,
        displayAmount: '0.000000000',
      },
      latestSnapshot: null,
    };
  }

  // Get ignored wallets for exclusion from rank calculations
  const ignoredWallets = getIgnoredWalletsArray();

  // Get reward pool config
  const weeklyAmount = process.env.WEEKLY_REWARD_AMOUNT || '3750000000';
  const weeklySymbol = process.env.WEEKLY_REWARD_SYMBOL || 'ORE';
  const weeklyDecimals = 9;

  // Build ignore filter for ranking query (starts at param $2)
  const rankIgnore = buildIgnoreFilter(ignoredWallets, 2);

  // Build ignore filter for total weight query (starts at param $2)
  const totalIgnore = buildIgnoreFilter(ignoredWallets, 2);

  // Run queries in parallel
  const [walletWeightResult, totalWeightResult, snapshotResult] = await Promise.all([
    // Get wallet's weight and rank (calculated among non-ignored wallets only)
    pool.query<{ wallet: string; weight: string; rank: string; total_count: string }>(
      `WITH filtered AS (
        SELECT wallet, weight
        FROM weights
        WHERE window_id = $1 ${rankIgnore.clause}
      ),
      ranked AS (
        SELECT wallet, weight,
               RANK() OVER (ORDER BY weight DESC) as rank,
               COUNT(*) OVER () as total_count
        FROM filtered
      )
      SELECT wallet, weight::text, rank::text, total_count::text
      FROM ranked
      WHERE wallet = $${2 + rankIgnore.params.length}`,
      [currentWindow, ...rankIgnore.params, walletAddress]
    ),

    // Get total weight for percentage calculation (excluding ignored wallets)
    pool.query<{ total_weight: string | null }>(
      `SELECT COALESCE(SUM(weight), 0) as total_weight
       FROM weights
       WHERE window_id = $1 ${totalIgnore.clause}`,
      [currentWindow, ...totalIgnore.params]
    ),

    // Get latest snapshot for wallet
    pool.query<{
      primary_token_amount: string;
      eligibility_token_amount: string | null;
      eligible: boolean;
      ts: Date;
    }>(
      `SELECT primary_token_amount::text, eligibility_token_amount::text, eligible, ts
       FROM snapshots
       WHERE wallet = $1
       ORDER BY ts DESC
       LIMIT 1`,
      [walletAddress]
    ),
  ]);

  const walletWeight = walletWeightResult.rows[0];
  const totalWeight = totalWeightResult.rows[0]?.total_weight || '0';
  const latestSnapshot = snapshotResult.rows[0];

  // If wallet has no weight data, check if they exist in snapshots at all
  if (!walletWeight && !latestSnapshot) {
    return null; // Wallet not found in system
  }

  const weight = walletWeight?.weight || '0';
  const rank = walletWeight ? parseInt(walletWeight.rank, 10) : 0;
  const totalHolders = walletWeight ? parseInt(walletWeight.total_count, 10) : 0;

  // Calculate weight percentage and projected reward
  const totalWeightNum = parseFloat(totalWeight);
  const walletWeightNum = parseFloat(weight);

  let weightPercentage = '0';
  let projectedAmount = '0';

  if (totalWeightNum > 0 && walletWeightNum > 0) {
    const percentage = (walletWeightNum / totalWeightNum) * 100;
    weightPercentage = percentage.toFixed(4);

    // Calculate projected reward
    const share = walletWeightNum / totalWeightNum;
    projectedAmount = Math.floor(share * Number(weeklyAmount)).toString();
  }

  const projectedDisplayAmount = (Number(projectedAmount) / 10 ** weeklyDecimals).toFixed(weeklyDecimals);

  return {
    wallet: walletAddress,
    currentWindow,
    isEligible: latestSnapshot?.eligible ?? false,
    isIgnored: false,
    weight,
    weightPercentage,
    rank,
    totalHolders,
    projectedReward: {
      amount: projectedAmount,
      symbol: weeklySymbol,
      decimals: weeklyDecimals,
      displayAmount: projectedDisplayAmount,
    },
    latestSnapshot: latestSnapshot
      ? {
          primaryTokenAmount: latestSnapshot.primary_token_amount,
          eligibilityTokenAmount: latestSnapshot.eligibility_token_amount,
          eligible: latestSnapshot.eligible,
          timestamp: latestSnapshot.ts.toISOString(),
        }
      : null,
  };
}

/**
 * Get paginated reward history for a wallet
 */
export async function getWalletHistory(
  walletAddress: string,
  page: number = 1,
  limit: number = 10
): Promise<WalletHistory> {
  const offset = (page - 1) * limit;

  // Get total count first
  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM reward_payouts_preview
     WHERE wallet = $1 AND payout_amount > 0`,
    [walletAddress]
  );

  const totalItems = parseInt(countResult.rows[0]?.count || '0', 10);
  const totalPages = Math.ceil(totalItems / limit);

  // Get paginated history
  const historyResult = await pool.query<{
    reward_id: string;
    window_id: string;
    payout_amount: string;
    mint: string;
    created_at: Date;
  }>(
    `SELECT rpp.reward_id, rpp.window_id, rpp.payout_amount::text, rpp.mint,
            rc.created_at
     FROM reward_payouts_preview rpp
     JOIN reward_configs rc ON rpp.reward_id = rc.reward_id
     WHERE rpp.wallet = $1 AND rpp.payout_amount > 0
     ORDER BY rc.created_at DESC
     LIMIT $2 OFFSET $3`,
    [walletAddress, limit, offset]
  );

  const history: WalletHistoryEntry[] = historyResult.rows.map((row) => {
    // Determine decimals based on mint (default to 9 for ORE)
    const decimals = 9;
    const displayAmount = (Number(row.payout_amount) / 10 ** decimals).toFixed(decimals);

    return {
      rewardId: row.reward_id,
      windowId: row.window_id,
      amount: row.payout_amount,
      symbol: process.env.WEEKLY_REWARD_SYMBOL || 'ORE',
      displayAmount,
      distributedAt: row.created_at.toISOString(),
    };
  });

  return {
    wallet: walletAddress,
    history,
    pagination: {
      page,
      limit,
      totalItems,
      totalPages,
    },
  };
}
