import { Router, Request, Response } from 'express';
import { pool } from '../../db';
import { asyncHandler } from '../middleware/error-handler';

export const healthRouter = Router();

/**
 * GET /api/health
 * Health check endpoint for monitoring
 */
healthRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    // Check database connectivity
    let dbStatus = 'disconnected';
    try {
      await pool.query('SELECT 1');
      dbStatus = 'connected';
    } catch (err) {
      console.error('[Health] Database check failed:', err);
      dbStatus = 'error';
    }

    const isHealthy = dbStatus === 'connected';

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      database: dbStatus,
      version: process.env.npm_package_version || '1.0.0',
    });
  })
);
