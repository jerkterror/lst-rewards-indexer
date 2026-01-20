// src/jobs/classify-wallets.ts
// Classifies wallets as system-owned (eligible for rewards) or program-owned
// Can be run standalone or imported as a module

import 'dotenv/config';
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { pool } from '../db';

const RPC_URL = process.env.SOLANA_RPC_URL!;
if (!RPC_URL) throw new Error('Missing SOLANA_RPC_URL');

const connection = new Connection(RPC_URL, 'confirmed');

export async function classifyWallets(): Promise<{ classified: number; systemOwned: number }> {
  const { rows } = await pool.query<{
    wallet: string;
  }>(`
    SELECT wallet
    FROM wallets
    WHERE is_system_owned IS NULL
  `);

  console.log(`Wallets to classify: ${rows.length}`);

  if (rows.length === 0) {
    console.log('No wallets to classify');
    return { classified: 0, systemOwned: 0 };
  }

  // OPTIMIZED: Batch RPC calls (100 wallets per call)
  const BATCH_SIZE = 100;
  const classifications: Array<{ wallet: string; isSystemOwned: boolean }> = [];

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const pubkeys = batch.map(row => new PublicKey(row.wallet));

    console.log(`Fetching account info for ${batch.length} wallets (batch ${Math.floor(i / BATCH_SIZE) + 1})...`);

    // Single batched RPC call for up to 100 wallets!
    const accountInfos = await connection.getMultipleAccountsInfo(pubkeys);

    for (let j = 0; j < batch.length; j++) {
      const info = accountInfos[j];
      const wallet = batch[j].wallet;

      // If account does not exist, treat as non-system-owned
      const isSystemOwned =
        info !== null &&
        info.owner.equals(SystemProgram.programId);

      classifications.push({ wallet, isSystemOwned });

      console.log(
        `${wallet} → ${isSystemOwned ? 'system-owned' : 'program-owned'}`
      );
    }
  }

  // OPTIMIZED: Single batched database update
  console.log(`Updating ${classifications.length} wallet classifications in database...`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const { wallet, isSystemOwned } of classifications) {
      await client.query(
        `UPDATE wallets SET is_system_owned = $1 WHERE wallet = $2`,
        [isSystemOwned, wallet]
      );
    }

    await client.query('COMMIT');
    console.log('Database updated successfully');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  console.log('Wallet classification complete');

  const systemOwned = classifications.filter(c => c.isSystemOwned).length;
  return { classified: rows.length, systemOwned };
}

// Run directly if this is the main module
if (require.main === module) {
  classifyWallets()
    .then((result) => {
      console.log(`Result: ${result.classified} classified, ${result.systemOwned} system-owned`);
      process.exit(0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
