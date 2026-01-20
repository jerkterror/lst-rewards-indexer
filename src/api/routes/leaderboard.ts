import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { getLeaderboard } from '../queries/leaderboard';

export const leaderboardRouter = Router();

/**
 * GET /api/leaderboard
 * Returns paginated leaderboard of top holders by weight
 */
leaderboardRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 25));

    const leaderboard = await getLeaderboard(page, limit);

    // Cache for 60 seconds (leaderboard doesn't change rapidly)
    res.set('Cache-Control', 'public, max-age=60');
    res.json(leaderboard);
  })
);
