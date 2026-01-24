import { Router, Request, Response } from 'express';
import { asyncHandler, createError } from '../middleware/error-handler';
import {
  getAvailableWindows,
  getWindowPayouts,
  getWalletTotalRewards,
} from '../queries/window-payouts';

export const windowPayoutsRouter = Router();

/**
 * Validate ISO week format (YYYY-WNN)
 */
function isValidWindowId(windowId: string): boolean {
  const pattern = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
  return pattern.test(windowId);
}

/**
 * GET /api/rewards/windows
 * Returns list of available windows with payout data (most recent first)
 */
windowPayoutsRouter.get(
  '/windows',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit as string, 10) || 5));

    const data = await getAvailableWindows(limit);

    // Cache for 5 minutes (windows list doesn't change often)
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  })
);

/**
 * GET /api/rewards/window/:windowId
 * Returns all payouts for a specific window (historical leaderboard)
 */
windowPayoutsRouter.get(
  '/window/:windowId',
  asyncHandler(async (req: Request, res: Response) => {
    const windowId = req.params.windowId as string;

    if (!windowId) {
      throw createError('Window ID is required', 400, 'MISSING_WINDOW_ID');
    }

    if (!isValidWindowId(windowId)) {
      throw createError(
        'Invalid window ID format. Expected: YYYY-WNN (e.g., 2026-W03)',
        400,
        'INVALID_WINDOW_ID'
      );
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 25));

    const data = await getWindowPayouts(windowId, page, limit);

    if (!data) {
      throw createError(`No payout data found for window ${windowId}`, 404, 'WINDOW_NOT_FOUND');
    }

    // Cache for 1 hour (historical data is immutable)
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(data);
  })
);

/**
 * GET /api/rewards/total/:address
 * Returns total rewards received by a wallet across all windows
 */
windowPayoutsRouter.get(
  '/total/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const address = req.params.address as string;

    if (!address) {
      throw createError('Wallet address is required', 400, 'MISSING_ADDRESS');
    }

    // Basic validation (Solana addresses are 32-44 chars base58)
    if (address.length < 32 || address.length > 44) {
      throw createError('Invalid wallet address', 400, 'INVALID_ADDRESS');
    }

    const data = await getWalletTotalRewards(address);

    // Cache for 5 minutes
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  })
);
