/**
 * Helper to manage ignored/blacklisted wallets.
 * These wallets are excluded from rewards calculations and leaderboard.
 *
 * Set IGNORE_WALLETS in .env as a comma-separated list:
 * IGNORE_WALLETS=wallet1,wallet2,wallet3
 */

let cachedIgnoredWallets: Set<string> | null = null;

/**
 * Get the set of ignored wallet addresses
 */
export function getIgnoredWallets(): Set<string> {
  if (cachedIgnoredWallets === null) {
    const envValue = process.env.IGNORE_WALLETS || '';
    cachedIgnoredWallets = new Set(
      envValue
        .split(',')
        .map(w => w.trim())
        .filter(w => w.length > 0)
    );
  }
  return cachedIgnoredWallets;
}

/**
 * Check if a wallet address is in the ignore list
 */
export function isWalletIgnored(wallet: string): boolean {
  return getIgnoredWallets().has(wallet);
}

/**
 * Get ignored wallets as an array (for SQL IN clauses)
 */
export function getIgnoredWalletsArray(): string[] {
  return Array.from(getIgnoredWallets());
}

/**
 * Build a SQL WHERE clause fragment to exclude ignored wallets.
 * Returns empty string if no wallets are ignored.
 *
 * @param columnName - The wallet column name (default: 'wallet')
 * @param paramOffset - Starting parameter number for parameterized query
 * @returns Object with { clause: string, params: string[] }
 */
export function buildIgnoreClause(
  columnName: string = 'wallet',
  paramOffset: number = 1
): { clause: string; params: string[] } {
  const ignored = getIgnoredWalletsArray();

  if (ignored.length === 0) {
    return { clause: '', params: [] };
  }

  // Build parameterized placeholders: $1, $2, $3, etc.
  const placeholders = ignored.map((_, i) => `$${paramOffset + i}`).join(', ');

  return {
    clause: `AND ${columnName} NOT IN (${placeholders})`,
    params: ignored,
  };
}

/**
 * Clear the cache (useful for testing or if env changes at runtime)
 */
export function clearIgnoredWalletsCache(): void {
  cachedIgnoredWallets = null;
}
