// src/indexers/snapshot.ts
import 'dotenv/config';
import {
  Connection,
  PublicKey,
  ParsedAccountData,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { pool } from '../db';

// ---------------------------
// Config / constants
// ---------------------------
const RPC_URL = process.env.SOLANA_RPC_URL!;
const PRIMARY_TOKEN_MINT_STR = process.env.PRIMARY_TOKEN_MINT!;
const PRIMARY_TOKEN_SYMBOL = process.env.PRIMARY_TOKEN_SYMBOL || 'PRIMARY';
const ELIGIBILITY_TOKEN_MINT_STR = process.env.ELIGIBILITY_TOKEN_MINT;
const ELIGIBILITY_TOKEN_SYMBOL = process.env.ELIGIBILITY_TOKEN_SYMBOL || 'ELIGIBILITY';
const ELIGIBILITY_TOKEN_MIN_AMOUNT_STR = process.env.ELIGIBILITY_TOKEN_MIN_AMOUNT;

// Validate required config
if (!RPC_URL) throw new Error('Missing SOLANA_RPC_URL');
if (!PRIMARY_TOKEN_MINT_STR) throw new Error('Missing PRIMARY_TOKEN_MINT');

const connection = new Connection(RPC_URL, 'confirmed');
const PRIMARY_TOKEN_MINT = new PublicKey(PRIMARY_TOKEN_MINT_STR);

// Optional: Eligibility token configuration
const ELIGIBILITY_TOKEN_MINT = ELIGIBILITY_TOKEN_MINT_STR
  ? new PublicKey(ELIGIBILITY_TOKEN_MINT_STR)
  : null;

const ELIGIBILITY_TOKEN_MIN_AMOUNT = ELIGIBILITY_TOKEN_MIN_AMOUNT_STR
  ? BigInt(ELIGIBILITY_TOKEN_MIN_AMOUNT_STR)
  : 0n;

function computeWindowId(ts: Date): string {
  const date = new Date(Date.UTC(
    ts.getUTCFullYear(),
    ts.getUTCMonth(),
    ts.getUTCDate()
  ));

  // ISO week calculation
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);

  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    (((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7
  );

  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// ---------------------------
// Types
// ---------------------------
type TokenHolder = {
  wallet: string;
  primaryTokenAmount: bigint;
};

type HolderWithEligibility = TokenHolder & {
  eligibilityTokenAmount: bigint | null;
};

// ---------------------------
// Helpers
// ---------------------------
async function fetchTokenHolders(): Promise<TokenHolder[]> {
  const accounts = await connection.getParsedProgramAccounts(
    TOKEN_PROGRAM_ID,
    {
      filters: [
        { dataSize: 165 },
        {
          memcmp: {
            offset: 0,
            bytes: PRIMARY_TOKEN_MINT.toBase58(),
          },
        },
      ],
    }
  );

  return accounts
    .map(acc => {
      const parsed = acc.account.data as ParsedAccountData;
      const info = parsed.parsed.info;
      const amount = BigInt(info.tokenAmount.amount);
      return amount > 0n
        ? { wallet: info.owner, primaryTokenAmount: amount }
        : null;
    })
    .filter(Boolean) as TokenHolder[];
}

/**
 * OPTIMIZED: Fetches eligibility token balances for multiple wallets in batches
 * This reduces 100+ RPC calls to just 1-2 batched calls
 * Returns null balances if no eligibility token is configured
 */
async function getEligibilityBalancesBatched(
  wallets: string[],
  eligibilityMint: PublicKey | null
): Promise<Map<string, bigint>> {
  const balances = new Map<string, bigint>();

  // If no eligibility token configured, return 0 for all wallets
  if (!eligibilityMint) {
    for (const wallet of wallets) {
      balances.set(wallet, 0n);
    }
    return balances;
  }

  // Derive all ATA addresses at once (no RPC calls needed!)
  const atas = wallets.map(wallet => ({
    wallet,
    ata: getAssociatedTokenAddressSync(
      eligibilityMint,
      new PublicKey(wallet),
      true // allowOwnerOffCurve
    ),
  }));

  // Solana allows max 100 accounts per getMultipleAccountsInfo call
  // So we batch in chunks of 100
  const BATCH_SIZE = 100;

  for (let i = 0; i < atas.length; i += BATCH_SIZE) {
    const batch = atas.slice(i, i + BATCH_SIZE);
    const ataAddresses = batch.map(item => item.ata);

    // Single batched RPC call for up to 100 accounts!
    const accountInfos = await connection.getMultipleAccountsInfo(ataAddresses);

    // Parse each account
    for (let j = 0; j < batch.length; j++) {
      const accountInfo = accountInfos[j];
      const { wallet } = batch[j];

      if (!accountInfo) {
        // Account doesn't exist = 0 balance
        balances.set(wallet, 0n);
        continue;
      }

      // Parse token account data
      // Token account layout: first 64 bytes are mint(32) + owner(32)
      // Amount is at bytes 64-72 (8 bytes, little-endian)
      const data = accountInfo.data;
      const amountBytes = data.slice(64, 72);
      const amount = amountBytes.readBigUInt64LE(0);

      balances.set(wallet, amount);
    }
  }

  return balances;
}

async function persistSnapshot(
  wallet: string,
  primaryTokenAmount: bigint,
  eligibilityTokenAmount: bigint | null,
  eligibilityTokenMint: string | null,
  eligible: boolean,
  windowId: string
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `
      INSERT INTO wallets (wallet, first_seen)
      VALUES ($1, NOW())
      ON CONFLICT (wallet) DO NOTHING
      `,
      [wallet]
    );

    await client.query(
      `
      INSERT INTO snapshots
        (wallet, primary_token_amount, eligibility_token_amount, eligibility_token_mint, eligible, window_id, ts)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `,
      [
        wallet,
        primaryTokenAmount.toString(),
        eligibilityTokenAmount?.toString() || null,
        eligibilityTokenMint,
        eligible,
        windowId,
      ]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------
// Main callable unit
// ---------------------------
export async function runSnapshot(): Promise<void> {
  const now = new Date();
  const windowId = computeWindowId(now);

  console.log(`Current reward window: ${windowId}`);
  console.log(`Primary token: ${PRIMARY_TOKEN_SYMBOL} (${PRIMARY_TOKEN_MINT_STR})`);

  if (ELIGIBILITY_TOKEN_MINT) {
    console.log(`Eligibility token: ${ELIGIBILITY_TOKEN_SYMBOL} (min: ${ELIGIBILITY_TOKEN_MIN_AMOUNT})`);
  } else {
    console.log('No eligibility requirement configured');
  }


  // Fetch all holders of the primary token
  const holders = await fetchTokenHolders();
  console.log(`${PRIMARY_TOKEN_SYMBOL} holders found: ${holders.length}`);

  // Fetch eligibility token balances (if configured)
  let eligibilityBalances: Map<string, bigint> | null = null;

  if (ELIGIBILITY_TOKEN_MINT) {
    console.log(`Fetching ${ELIGIBILITY_TOKEN_SYMBOL} balances for ${holders.length} wallets (batched)...`);
    eligibilityBalances = await getEligibilityBalancesBatched(
      holders.map(h => h.wallet),
      ELIGIBILITY_TOKEN_MINT
    );
  }

  // Combine primary and eligibility data
  const holdersWithEligibility: HolderWithEligibility[] = holders.map(h => ({
    ...h,
    eligibilityTokenAmount: eligibilityBalances?.get(h.wallet) ?? null,
  }));

  // Determine eligibility
  const eligible = holdersWithEligibility.filter(h => {
    if (!ELIGIBILITY_TOKEN_MINT || !ELIGIBILITY_TOKEN_MIN_AMOUNT) {
      return true; // No eligibility requirement
    }
    return (h.eligibilityTokenAmount ?? 0n) >= ELIGIBILITY_TOKEN_MIN_AMOUNT;
  });

  console.log(`Eligible wallets: ${eligible.length}`);

  if (eligible.length > 0 && eligible.length <= 20) {
    console.table(
      eligible.map(h => ({
        wallet: h.wallet,
        [PRIMARY_TOKEN_SYMBOL]: h.primaryTokenAmount.toString(),
        ...(ELIGIBILITY_TOKEN_MINT && {
          [ELIGIBILITY_TOKEN_SYMBOL]: (h.eligibilityTokenAmount ?? 0n).toString(),
        }),
      }))
    );
  }

  // Persist all snapshots
  for (const h of holdersWithEligibility) {
    const isEligible = eligible.some(e => e.wallet === h.wallet);

    await persistSnapshot(
      h.wallet,
      h.primaryTokenAmount,
      h.eligibilityTokenAmount,
      ELIGIBILITY_TOKEN_MINT?.toBase58() || null,
      isEligible,
      windowId
    );
  }

  console.log('Snapshots written');
}
