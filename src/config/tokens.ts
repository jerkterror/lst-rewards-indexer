// Token Registry
// Maintains a list of known SPL tokens for easy reference

export type TokenInfo = {
  mint: string;
  decimals: number;
  symbol: string;
  name: string;
};

export const KNOWN_TOKENS: Record<string, TokenInfo> = {
  INDIESOL: {
    mint: 'L33mHftsNpaj39z1omnGbGbuA5eKqSsbmr91rjTod48',
    decimals: 9,
    symbol: 'INDIESOL',
    name: 'IndieSOL',
  },
  ORE: {
    mint: 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp',
    decimals: 11,
    symbol: 'ORE',
    name: 'ORE',
  },
  SOL: {
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    symbol: 'SOL',
    name: 'Wrapped SOL',
  },
  USDC: {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    symbol: 'USDC',
    name: 'USD Coin',
  },
  USDT: {
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
    symbol: 'USDT',
    name: 'Tether USD',
  },
};

/**
 * Get token info by symbol (case-insensitive)
 */
export function getTokenBySymbol(symbol: string): TokenInfo | undefined {
  const upperSymbol = symbol.toUpperCase();
  return KNOWN_TOKENS[upperSymbol];
}

/**
 * Get token info by mint address
 */
export function getTokenByMint(mint: string): TokenInfo | undefined {
  return Object.values(KNOWN_TOKENS).find((token) => token.mint === mint);
}

/**
 * Check if a symbol is known
 */
export function isKnownToken(symbol: string): boolean {
  return symbol.toUpperCase() in KNOWN_TOKENS;
}

/**
 * Convert human-readable amount to raw units
 * Example: 7 ORE (9 decimals) → 7000000000
 */
export function toRawAmount(amount: number, decimals: number): bigint {
  return BigInt(Math.floor(amount * 10 ** decimals));
}

/**
 * Convert raw units to human-readable amount
 * Example: 7000000000 (9 decimals) → 7
 */
export function fromRawAmount(rawAmount: bigint, decimals: number): number {
  return Number(rawAmount) / 10 ** decimals;
}
