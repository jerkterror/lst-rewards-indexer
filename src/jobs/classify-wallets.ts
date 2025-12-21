// src/jobs/classify-wallets.ts
import 'dotenv/config';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { pool } from '../db';

const RPC_URL = process.env.SOLANA_RPC_URL!;
if (!RPC_URL) throw new Error('Missing SOLANA_RPC_URL');

const connection = new Connection(RPC_URL, 'confirmed');

async function classifyWallets() {
  const { rows } = await pool.query<{
    wallet: string;
  }>(`
    SELECT wallet
    FROM wallets
    WHERE is_system_owned IS NULL
  `);

  console.log(`Wallets to classify: ${rows.length}`);

  for (const row of rows) {
    const pubkey = new PublicKey(row.wallet);

    const info = await connection.getAccountInfo(pubkey);

    // If account does not exist, treat as non-system-owned
    const isSystemOwned =
      info !== null &&
      info.owner.equals(SystemProgram.programId);

    await pool.query(
      `
      UPDATE wallets
      SET is_system_owned = $1
      WHERE wallet = $2
      `,
      [isSystemOwned, row.wallet]
    );

    console.log(
      `${row.wallet} → ${isSystemOwned ? 'system-owned' : 'program-owned'}`
    );
  }

  console.log('Wallet classification complete');
}

classifyWallets().catch((e) => {
  console.error(e);
  process.exit(1);
});
