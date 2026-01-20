import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { getGlobalStats } from '../queries/stats';

export const statsRouter = Router();

/**
 * GET /api/stats
 * Returns global statistics for the rewards program
 */
statsRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const stats = await getGlobalStats();

    // Cache for 30 seconds (stats don't change frequently)
    res.set('Cache-Control', 'public, max-age=30');
    res.json(stats);
  })
);
