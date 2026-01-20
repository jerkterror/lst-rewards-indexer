/**
 * API Server Runner
 *
 * Starts the read-only API server for the rewards system.
 * This runs as a separate process from the scheduler to ensure
 * snapshot collection continues even if the API has issues.
 *
 * Usage:
 *   npx ts-node src/runners/api-server.ts
 *
 * The API provides read-only access to:
 *   - Global stats (/api/stats)
 *   - Wallet data (/api/wallet/:address)
 *   - Wallet history (/api/wallet/:address/history)
 *   - Leaderboard (/api/leaderboard)
 *
 * Environment variables:
 *   - DATABASE_URL: PostgreSQL connection string (required)
 *   - API_PORT: Port to listen on (default: 3001)
 *   - CORS_ORIGIN: Allowed origins (default: *)
 *   - WEEKLY_REWARD_AMOUNT: Weekly reward pool in raw units (default: 3750000000)
 *   - WEEKLY_REWARD_SYMBOL: Reward token symbol (default: ORE)
 */

import { startServer } from '../api';

console.log('[API Server] Starting...');
startServer();
