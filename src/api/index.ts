import express from 'express';
import cors from 'cors';
import 'dotenv/config';

import { healthRouter } from './routes/health';
import { statsRouter } from './routes/stats';
import { walletRouter } from './routes/wallet';
import { leaderboardRouter } from './routes/leaderboard';
import { windowPayoutsRouter } from './routes/window-payouts';
import { errorHandler } from './middleware/error-handler';
import { rateLimiter } from './middleware/rate-limit';

const app = express();
const PORT = process.env.API_PORT || 3001;

// Trust proxy (for nginx)
app.set('trust proxy', 1);

// CORS configuration
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(
  cors({
    origin: corsOrigin === '*' ? '*' : corsOrigin.split(',').map((o) => o.trim()),
    methods: ['GET'],
    allowedHeaders: ['Content-Type'],
  })
);

// Parse JSON bodies (not strictly needed for GET-only API, but good practice)
app.use(express.json());

// Application-level rate limiting (backup to nginx)
app.use(rateLimiter);

// Security headers
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-XSS-Protection', '1; mode=block');
  next();
});

// Request logging
app.use((req, _res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/api/health', healthRouter);
app.use('/api/stats', statsRouter);
app.use('/api/wallet', walletRouter);
app.use('/api/leaderboard', leaderboardRouter);
app.use('/api/rewards', windowPayoutsRouter);

// Root endpoint
app.get('/api', (_req, res) => {
  res.json({
    name: 'LST Rewards API',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      stats: '/api/stats',
      wallet: '/api/wallet/:address',
      walletHistory: '/api/wallet/:address/history',
      leaderboard: '/api/leaderboard',
      rewardsWindows: '/api/rewards/windows',
      rewardsWindow: '/api/rewards/window/:windowId',
      rewardsTotal: '/api/rewards/total/:address',
    },
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({
    error: 'Not found',
    code: 'NOT_FOUND',
  });
});

// Global error handler
app.use(errorHandler);

// Start server
export function startServer(): void {
  app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log(`[API] LST Rewards Read-Only API`);
    console.log(`[API] Listening on port ${PORT}`);
    console.log(`[API] CORS origin: ${corsOrigin}`);
    console.log(`[API] Started at: ${new Date().toISOString()}`);
    console.log('='.repeat(50));
  });
}

export { app };
