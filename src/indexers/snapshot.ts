// src/indexers/snapshot.ts
import 'dotenv/config';
import {
  Connection,
  PublicKey,
  ParsedAccountData,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { pool } from '../db';

// ---------------------------
// Config / constants
// ---------------------------
const RPC_URL = process.env.SOLANA_RPC_URL!;
if (!RPC_URL) throw new Error('Missing SOLANA_RPC_URL');

const connection = new Connection(RPC_URL, 'confirmed');

const INDIESOL_MINT = new PublicKey(
  'L33mHftsNpaj39z1omnGbGbuA5eKqSsbmr91rjTod48'
);

const ORE_MINT = new PublicKey(
  'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp'
);

const ONE_ORE = 1n * 10n ** 9n;

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
type IndieSolHolder = {
  wallet: string;
  indiesolRaw: bigint;
};

type HolderWithOre = IndieSolHolder & {
  oreRaw: bigint;
};

// ---------------------------
// Helpers
// ---------------------------
async function fetchIndieSolHolders(): Promise<IndieSolHolder[]> {
  const accounts = await connection.getParsedProgramAccounts(
    TOKEN_PROGRAM_ID,
    {
      filters: [
        { dataSize: 165 },
        {
          memcmp: {
            offset: 0,
            bytes: INDIESOL_MINT.toBase58(),
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
        ? { wallet: info.owner, indiesolRaw: amount }
        : null;
    })
    .filter(Boolean) as IndieSolHolder[];
}

async function getOreBalance(wallet: string): Promise<bigint> {
  const owner = new PublicKey(wallet);
  const accounts = await connection.getParsedTokenAccountsByOwner(
    owner,
    { mint: ORE_MINT }
  );

  if (accounts.value.length === 0) return 0n;

  const parsed =
    accounts.value[0].account.data as ParsedAccountData;

  return BigInt(parsed.parsed.info.tokenAmount.amount);
}

async function persistSnapshot(
  wallet: string,
  indiesolRaw: bigint,
  oreRaw: bigint,
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
    (wallet, amount, ore_amount, eligible, window_id, ts)
  VALUES ($1, $2, $3, $4, $5, NOW())
  `,
  [
    wallet,
    indiesolRaw.toString(),
    oreRaw.toString(),
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

  // ----------------------------------
  // Snapshot window guard (6 hours)
  // ----------------------------------
  const recent = await pool.query(`
    SELECT 1
    FROM snapshots
    WHERE ts >= NOW() - INTERVAL '6 hours'
    LIMIT 1
  `);

  if ((recent.rowCount ?? 0) > 0) {
    console.log('Snapshot already taken in last 6 hours, exiting');
    return;
  }

  const holders = await fetchIndieSolHolders();

  const withOre: HolderWithOre[] = await Promise.all(
    holders.map(async h => ({
      ...h,
      oreRaw: await getOreBalance(h.wallet),
    }))
  );

  const eligible = withOre.filter(h => h.oreRaw >= ONE_ORE);

  console.log(`IndieSOL holders found: ${holders.length}`);
  console.log(`Eligible wallets (>= 1 ORE): ${eligible.length}`);
  console.table(
    eligible.map(h => ({
      wallet: h.wallet,
      indiesol: h.indiesolRaw.toString(),
      ore: h.oreRaw.toString(),
    }))
  );

  for (const h of withOre) {
  await persistSnapshot(
    h.wallet,
    h.indiesolRaw,
    h.oreRaw,
    h.oreRaw >= ONE_ORE,
    windowId
  );
}

  console.log('Snapshots written');
}
