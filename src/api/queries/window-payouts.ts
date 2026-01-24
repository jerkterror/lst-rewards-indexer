import { pool } from '../../db';
import { getTokenBySymbol } from '../../config/tokens';

export interface WindowPayoutEntry {
  rank: number;
  wallet: string;
  walletFull: string;
  payoutAmount: string;
  displayAmount: string;
  sharePercentage: string;
}

export interface WindowPayoutsData {
  windowId: string;
  rewardId: string;
  distributedAt: string;
  totalPool: {
    amount: string;
    symbol: string;
    displayAmount: string;
  };
  totalRecipients: number;
  recipients: WindowPayoutEntry[];
  pagination: {
    page: number;
    limit: number;
    totalItems: number;
    totalPages: number;
  };
}

export interface AvailableWindow {
  windowId: string;
  rewardId: string;
  distributedAt: string;
  totalAmount: string;
  displayAmount: string;
  recipientCount: number;
}

export interface AvailableWindowsData {
  windows: AvailableWindow[];
  totalWindows: number;
}

/**
 * Shorten wallet address for display
 */
function shortenWallet(wallet: string): string {
  if (wallet.length <= 12) return wallet;
  return `${wallet.slice(0, 6)}...${wallet.slice(-6)}`;
}

/**
 * Check if reward_id matches production pattern (e.g., ORE_2026_W03)
 * Excludes test rewards like FRONK_TEST_2026W01_v2
 */
function isProductionReward(rewardId: string): boolean {
  // Pattern: TOKEN_YYYY_WNN (e.g., ORE_2026_W03)
  const pattern = /^[A-Z]+_\d{4}_W\d{2}$/;
  return pattern.test(rewardId);
}

/**
 * Get list of available windows with payout data
 * Returns most recent windows first (up to limit)
 */
export async function getAvailableWindows(limit: number = 5): Promise<AvailableWindowsData> {
  const result = await pool.query<{
    window_id: string;
    reward_id: string;
    created_at: Date;
    total_amount: string;
    recipient_count: string;
  }>(
    `SELECT
       rpp.window_id,
       rpp.reward_id,
       rc.created_at,
       SUM(rpp.payout_amount)::text as total_amount,
       COUNT(*)::text as recipient_count
     FROM reward_payouts_preview rpp
     JOIN reward_configs rc ON rpp.reward_id = rc.reward_id
     WHERE rpp.payout_amount > 0
       AND rpp.reward_id ~ '^[A-Z]+_[0-9]{4}_W[0-9]{2}$'
     GROUP BY rpp.window_id, rpp.reward_id, rc.created_at
     ORDER BY rc.created_at DESC
     LIMIT $1`,
    [limit]
  );

  const symbol = process.env.WEEKLY_REWARD_SYMBOL || 'ORE';
  const tokenInfo = getTokenBySymbol(symbol);
  const decimals = tokenInfo?.decimals || 11; // Default to 11 for ORE

  const windows: AvailableWindow[] = result.rows.map((row) => ({
    windowId: row.window_id,
    rewardId: row.reward_id,
    distributedAt: row.created_at.toISOString(),
    totalAmount: row.total_amount,
    displayAmount: (Number(row.total_amount) / 10 ** decimals).toFixed(decimals),
    recipientCount: parseInt(row.recipient_count, 10),
  }));

  return {
    windows,
    totalWindows: windows.length,
  };
}

/**
 * Get all payouts for a specific window
 * Returns paginated list of recipients ranked by payout amount
 */
export async function getWindowPayouts(
  windowId: string,
  page: number = 1,
  limit: number = 25
): Promise<WindowPayoutsData | null> {
  const offset = (page - 1) * limit;
  const symbol = process.env.WEEKLY_REWARD_SYMBOL || 'ORE';
  const tokenInfo = getTokenBySymbol(symbol);
  const decimals = tokenInfo?.decimals || 11; // Default to 11 for ORE

  // First check if window exists and get metadata
  const metaResult = await pool.query<{
    reward_id: string;
    created_at: Date;
    total_amount: string;
    recipient_count: string;
  }>(
    `SELECT
       rpp.reward_id,
       rc.created_at,
       SUM(rpp.payout_amount)::text as total_amount,
       COUNT(*)::text as recipient_count
     FROM reward_payouts_preview rpp
     JOIN reward_configs rc ON rpp.reward_id = rc.reward_id
     WHERE rpp.window_id = $1 AND rpp.payout_amount > 0
     GROUP BY rpp.reward_id, rc.created_at`,
    [windowId]
  );

  if (metaResult.rows.length === 0) {
    return null; // Window not found
  }

  const meta = metaResult.rows[0];
  const totalItems = parseInt(meta.recipient_count, 10);
  const totalPages = Math.ceil(totalItems / limit);

  // Get paginated recipients
  const recipientsResult = await pool.query<{
    wallet: string;
    payout_amount: string;
    share: string;
  }>(
    `SELECT
       wallet,
       payout_amount::text,
       share::text
     FROM reward_payouts_preview
     WHERE window_id = $1 AND payout_amount > 0
     ORDER BY payout_amount DESC
     LIMIT $2 OFFSET $3`,
    [windowId, limit, offset]
  );

  const recipients: WindowPayoutEntry[] = recipientsResult.rows.map((row, index) => {
    const displayAmount = (Number(row.payout_amount) / 10 ** decimals).toFixed(decimals);
    const sharePercentage = (Number(row.share) * 100).toFixed(4);
    const rank = offset + index + 1;

    return {
      rank,
      wallet: shortenWallet(row.wallet),
      walletFull: row.wallet,
      payoutAmount: row.payout_amount,
      displayAmount,
      sharePercentage,
    };
  });

  const totalDisplayAmount = (Number(meta.total_amount) / 10 ** decimals).toFixed(decimals);

  return {
    windowId,
    rewardId: meta.reward_id,
    distributedAt: meta.created_at.toISOString(),
    totalPool: {
      amount: meta.total_amount,
      symbol,
      displayAmount: totalDisplayAmount,
    },
    totalRecipients: totalItems,
    recipients,
    pagination: {
      page,
      limit,
      totalItems,
      totalPages,
    },
  };
}

/**
 * Get total rewards received by a wallet across all windows
 */
export async function getWalletTotalRewards(walletAddress: string): Promise<{
  wallet: string;
  totalAmount: string;
  displayAmount: string;
  symbol: string;
  windowCount: number;
}> {
  const symbol = process.env.WEEKLY_REWARD_SYMBOL || 'ORE';
  const tokenInfo = getTokenBySymbol(symbol);
  const decimals = tokenInfo?.decimals || 11; // Default to 11 for ORE

  const result = await pool.query<{
    total_amount: string;
    window_count: string;
  }>(
    `SELECT
       COALESCE(SUM(payout_amount), 0)::text as total_amount,
       COUNT(DISTINCT window_id)::text as window_count
     FROM reward_payouts_preview
     WHERE wallet = $1 AND payout_amount > 0
       AND reward_id ~ '^[A-Z]+_[0-9]{4}_W[0-9]{2}$'`,
    [walletAddress]
  );

  const row = result.rows[0];
  const totalAmount = row?.total_amount || '0';
  const windowCount = parseInt(row?.window_count || '0', 10);
  const displayAmount = (Number(totalAmount) / 10 ** decimals).toFixed(decimals);

  return {
    wallet: walletAddress,
    totalAmount,
    displayAmount,
    symbol,
    windowCount,
  };
}
