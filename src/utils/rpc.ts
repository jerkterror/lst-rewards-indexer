// src/utils/rpc.ts
// RPC connection utility with automatic failover support

import { Connection, ConnectionConfig } from '@solana/web3.js';

export interface RpcConfig {
  primaryUrl: string;
  backupUrl?: string;
  commitment?: 'processed' | 'confirmed' | 'finalized';
  maxRetries?: number;
  retryDelayMs?: number;
}

interface RpcState {
  primaryHealthy: boolean;
  lastFailoverTime: number | null;
  failoverCount: number;
}

const state: RpcState = {
  primaryHealthy: true,
  lastFailoverTime: null,
  failoverCount: 0,
};

// Time to wait before trying primary again after failover (5 minutes)
const PRIMARY_RECOVERY_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Get RPC configuration from environment variables
 */
export function getRpcConfigFromEnv(): RpcConfig {
  const primaryUrl = process.env.SOLANA_RPC_URL;
  const backupUrl = process.env.SOLANA_RPC_URL_BACKUP;

  if (!primaryUrl) {
    throw new Error('Missing SOLANA_RPC_URL environment variable');
  }

  return {
    primaryUrl,
    backupUrl: backupUrl || undefined,
    commitment: 'confirmed',
    maxRetries: 3,
    retryDelayMs: 1000,
  };
}

/**
 * Create a Connection object for the given RPC URL
 */
function createConnection(url: string, commitment: RpcConfig['commitment'] = 'confirmed'): Connection {
  return new Connection(url, commitment);
}

/**
 * Get the currently active RPC URL based on health state
 */
export function getActiveRpcUrl(config: RpcConfig): string {
  // If primary is healthy, use it
  if (state.primaryHealthy) {
    return config.primaryUrl;
  }

  // If we have a backup and primary is unhealthy, use backup
  if (config.backupUrl) {
    // Check if enough time has passed to try primary again
    if (state.lastFailoverTime) {
      const timeSinceFailover = Date.now() - state.lastFailoverTime;
      if (timeSinceFailover > PRIMARY_RECOVERY_INTERVAL_MS) {
        console.log('⚡ Attempting to recover primary RPC connection...');
        state.primaryHealthy = true;
        return config.primaryUrl;
      }
    }
    return config.backupUrl;
  }

  // No backup available, use primary anyway
  return config.primaryUrl;
}

/**
 * Mark primary RPC as failed and switch to backup
 */
export function markPrimaryFailed(config: RpcConfig): void {
  if (state.primaryHealthy && config.backupUrl) {
    state.primaryHealthy = false;
    state.lastFailoverTime = Date.now();
    state.failoverCount++;
    console.log(`⚠️  Primary RPC failed, switching to backup (failover #${state.failoverCount})`);
  }
}

/**
 * Mark primary RPC as recovered
 */
export function markPrimaryRecovered(): void {
  if (!state.primaryHealthy) {
    state.primaryHealthy = true;
    console.log('✅ Primary RPC recovered');
  }
}

/**
 * Get current RPC state for debugging/monitoring
 */
export function getRpcState(): Readonly<RpcState> {
  return { ...state };
}

/**
 * Reset RPC state (useful for testing)
 */
export function resetRpcState(): void {
  state.primaryHealthy = true;
  state.lastFailoverTime = null;
  state.failoverCount = 0;
}

/**
 * Create a Connection with the currently active RPC
 */
export function createActiveConnection(config: RpcConfig): Connection {
  const url = getActiveRpcUrl(config);
  return createConnection(url, config.commitment);
}

/**
 * Execute an RPC operation with automatic failover
 *
 * This wrapper will:
 * 1. Try the operation on the current active RPC
 * 2. If it fails with a connection/network error, failover to backup
 * 3. Retry the operation on the backup
 *
 * @param config - RPC configuration
 * @param operation - Async function that takes a Connection and performs an RPC operation
 * @param operationName - Name of the operation for logging
 * @returns The result of the operation
 */
export async function withFailover<T>(
  config: RpcConfig,
  operation: (connection: Connection) => Promise<T>,
  operationName: string = 'RPC operation'
): Promise<T> {
  const maxRetries = config.maxRetries ?? 3;
  const retryDelayMs = config.retryDelayMs ?? 1000;

  let lastError: Error | null = null;
  let attempts = 0;

  // Try with current active connection
  while (attempts < maxRetries) {
    attempts++;
    const connection = createActiveConnection(config);

    try {
      const result = await operation(connection);

      // If we were on backup and this succeeded, check if we should try primary
      if (!state.primaryHealthy && state.lastFailoverTime) {
        const timeSinceFailover = Date.now() - state.lastFailoverTime;
        if (timeSinceFailover > PRIMARY_RECOVERY_INTERVAL_MS) {
          markPrimaryRecovered();
        }
      }

      return result;
    } catch (error: any) {
      lastError = error;

      // Check if this is a connection/network error that warrants failover
      if (isFailoverableError(error)) {
        console.log(`⚠️  ${operationName} failed (attempt ${attempts}/${maxRetries}): ${error.message}`);

        // If we have a backup and haven't failed over yet, do so
        if (config.backupUrl && state.primaryHealthy) {
          markPrimaryFailed(config);
          attempts = 0; // Reset attempts for backup
          continue;
        }
      }

      // For non-failoverable errors or if we've exhausted backup retries
      if (attempts < maxRetries) {
        await sleep(retryDelayMs * attempts); // Exponential-ish backoff
      }
    }
  }

  throw lastError || new Error(`${operationName} failed after ${maxRetries} attempts`);
}

/**
 * Check if an error is the type that should trigger RPC failover
 * These are typically network/connection errors, not application-level errors
 */
function isFailoverableError(error: any): boolean {
  const message = error?.message?.toLowerCase() || '';

  // Connection/network errors
  if (message.includes('fetch failed') ||
      message.includes('failed to fetch') ||
      message.includes('network error') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('socket hang up') ||
      message.includes('getaddrinfo') ||
      message.includes('enotfound') ||
      message.includes('dns') ||
      message.includes('connection refused') ||
      message.includes('connection reset') ||
      message.includes('connection timeout') ||
      message.includes('request timeout')) {
    return true;
  }

  // RPC-specific errors that indicate the endpoint is having issues
  if (message.includes('429') || // Rate limited
      message.includes('too many requests') ||
      message.includes('503') || // Service unavailable
      message.includes('502') || // Bad gateway
      message.includes('504') || // Gateway timeout
      message.includes('internal server error') ||
      message.includes('rpc pool is at capacity')) {
    return true;
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Convenience class that wraps a Connection with failover capabilities
 * Use this when you need to pass a connection-like object around
 */
export class FailoverConnection {
  private config: RpcConfig;
  private _connection: Connection;

  constructor(config?: RpcConfig) {
    this.config = config || getRpcConfigFromEnv();
    this._connection = createActiveConnection(this.config);
  }

  /**
   * Get the underlying Connection object
   * Note: This returns the current active connection, which may change after failover
   */
  get connection(): Connection {
    const currentUrl = getActiveRpcUrl(this.config);
    const connectionUrl = (this._connection as any)._rpcEndpoint;

    // Refresh connection if active RPC has changed
    if (connectionUrl !== currentUrl) {
      this._connection = createActiveConnection(this.config);
    }

    return this._connection;
  }

  /**
   * Execute an operation with failover protection
   */
  async execute<T>(
    operation: (connection: Connection) => Promise<T>,
    operationName?: string
  ): Promise<T> {
    return withFailover(this.config, operation, operationName);
  }

  /**
   * Get the RPC configuration
   */
  getConfig(): RpcConfig {
    return this.config;
  }

  /**
   * Check if backup RPC is configured
   */
  hasBackup(): boolean {
    return !!this.config.backupUrl;
  }

  /**
   * Get current RPC URL being used
   */
  getCurrentUrl(): string {
    return getActiveRpcUrl(this.config);
  }
}

/**
 * Create a FailoverConnection from environment variables
 */
export function createFailoverConnection(): FailoverConnection {
  return new FailoverConnection(getRpcConfigFromEnv());
}
