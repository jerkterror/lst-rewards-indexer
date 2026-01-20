import { Router, Request, Response } from 'express';
import { asyncHandler, createError } from '../middleware/error-handler';
import { getWalletData, getWalletHistory } from '../queries/wallet';

export const walletRouter = Router();

/**
 * Validate Solana wallet address (basic check)
 * Base58 encoded, 32-44 characters
 */
function isValidWalletAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false;
  if (address.length < 32 || address.length > 44) return false;
  // Base58 character set (no 0, O, I, l)
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(address);
}

/**
 * GET /api/wallet/:address
 * Returns data for a specific wallet
 */
walletRouter.get(
  '/:address',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;

    if (!isValidWalletAddress(address)) {
      throw createError('Invalid wallet address', 400, 'INVALID_ADDRESS');
    }

    const walletData = await getWalletData(address);

    if (!walletData) {
      throw createError('Wallet not found in rewards system', 404, 'WALLET_NOT_FOUND');
    }

    // Cache for 30 seconds
    res.set('Cache-Control', 'public, max-age=30');
    res.json(walletData);
  })
);

/**
 * GET /api/wallet/:address/history
 * Returns paginated reward history for a wallet
 */
walletRouter.get(
  '/:address/history',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 10));

    if (!isValidWalletAddress(address)) {
      throw createError('Invalid wallet address', 400, 'INVALID_ADDRESS');
    }

    const history = await getWalletHistory(address, page, limit);

    // Cache for 60 seconds (history changes less frequently)
    res.set('Cache-Control', 'public, max-age=60');
    res.json(history);
  })
);
