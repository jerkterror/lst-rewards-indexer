import "dotenv/config";
import fs from "fs";
import assert from "assert";

import * as multisig from "@sqds/multisig";
import {
  Connection,
  PublicKey,
  Keypair,
  TransactionMessage,
} from "@solana/web3.js";

import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getMint,
} from "@solana/spl-token";

type CsvRow = {
  wallet: string;
  mint: string;
  amount: string; // raw units (already decimal-adjusted)
};

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function parseCsv(csvPath: string): CsvRow[] {
  const text = fs.readFileSync(csvPath, "utf8").trim();
  const [header, ...lines] = text.split(/\r?\n/);
  const headers = header.split(",").map((h) => h.trim());

  const w = headers.indexOf("wallet");
  const m = headers.indexOf("mint");
  const a = headers.indexOf("amount");

  if (w === -1 || m === -1 || a === -1) {
    throw new Error("CSV must include wallet,mint,amount columns");
  }

  return lines
    .map((l) => l.split(","))
    .map((cols) => ({
      wallet: cols[w].trim(),
      mint: cols[m].trim(),
      amount: cols[a].trim(),
    }))
    .filter((r) => r.wallet && r.mint && r.amount && r.amount !== "0");
}

/* ------------------------------------------------------------------ */
/* Main                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  /* -------------------- env -------------------- */

  const rpcUrl = process.env.SOLANA_RPC_URL!;
  const multisigAddr = process.env.SQUADS_MULTISIG!;
  const vaultAddr = process.env.SQUAD_VAULT_ADDRESS!;
  const keypairPath = process.env.SQUADS_MEMBER_KEYPAIR!;
  const maxTransfers = Number(process.env.MAX_TRANSFERS_PER_TX ?? "6");

  assert(rpcUrl, "Missing SOLANA_RPC_URL");
  assert(multisigAddr, "Missing SQUADS_MULTISIG");
  assert(vaultAddr, "Missing SQUAD_VAULT_ADDRESS");
  assert(keypairPath, "Missing SQUADS_MEMBER_KEYPAIR");

  const csvPath = process.argv[2];
  if (!csvPath) {
    throw new Error(
      "Usage: ts-node squads-create-payout-proposals.ts <csv-path>"
    );
  }

  /* -------------------- setup -------------------- */

  const connection = new Connection(rpcUrl, "confirmed");
  const multisigPda = new PublicKey(multisigAddr);
  const vaultAuthority = new PublicKey(vaultAddr);
  const member = loadKeypair(keypairPath);

  /* -------------------- load CSV -------------------- */

  const rows = parseCsv(csvPath);
  if (rows.length === 0) {
    throw new Error("CSV contained no payout rows");
  }

  const uniqueMints = [...new Set(rows.map((r) => r.mint))];
  if (uniqueMints.length !== 1) {
    throw new Error(
      `This script expects a single-mint CSV. Found: ${uniqueMints.join(", ")}`
    );
  }

  const mint = new PublicKey(uniqueMints[0]);

  /* -------------------- mint info -------------------- */

  const mintInfo = await getMint(connection, mint);
  const decimals = mintInfo.decimals;

  /* -------------------- derive source ATA -------------------- */

  const sourceTokenAccount = getAssociatedTokenAddressSync(
    mint,
    vaultAuthority,
    true // allow owner off curve
  );

  const sourceInfo = await connection.getParsedAccountInfo(
    sourceTokenAccount
  );
  if (!sourceInfo.value) {
    throw new Error(
      `Vault does not have an ATA for mint ${mint.toBase58()}`
    );
  }

  const parsed: any = sourceInfo.value.data;
  const ownerStr = parsed?.parsed?.info?.owner;
  if (ownerStr !== vaultAuthority.toBase58()) {
    throw new Error(
      `Source ATA owner mismatch: expected ${vaultAuthority.toBase58()}, got ${ownerStr}`
    );
  }

  /* -------------------- recipients -------------------- */

  const recipients = rows.map((r) => ({
    owner: new PublicKey(r.wallet),
    amount: BigInt(r.amount),
  }));

  const recipientAtas = recipients.map((r) =>
    getAssociatedTokenAddressSync(mint, r.owner, true)
  );

  const ataInfos = await connection.getMultipleAccountsInfo(recipientAtas);

  /* -------------------- batching -------------------- */

  const batches: number[][] = [];
  for (let i = 0; i < recipients.length; i += maxTransfers) {
    batches.push(
      Array.from(
        { length: Math.min(maxTransfers, recipients.length - i) },
        (_, k) => i + k
      )
    );
  }

  console.log("Multisig:", multisigPda.toBase58());
  console.log("Vault:", vaultAuthority.toBase58());
  console.log("Mint:", mint.toBase58(), "decimals:", decimals);
  console.log("Source ATA:", sourceTokenAccount.toBase58());
  console.log("Recipient rows:", recipients.length);
  console.log("Batches:", batches.length, "batchSize:", maxTransfers);

  /* -------------------- fetch next tx index -------------------- */

  const multisigInfo =
    await multisig.accounts.Multisig.fromAccountAddress(
      connection,
      multisigPda
    );

  let nextTransactionIndex =
    BigInt(Number(multisigInfo.transactionIndex)) + 1n;

  /* -------------------- create proposals -------------------- */

  for (let b = 0; b < batches.length; b++) {
    const idxs = batches[b];
    const instructions = [];

    for (const i of idxs) {
      const { owner, amount } = recipients[i];
      if (amount <= 0n) continue;

      const ata = recipientAtas[i];
      const exists = ataInfos[i] !== null;

      if (!exists) {
        instructions.push(
          createAssociatedTokenAccountInstruction(
            vaultAuthority,
            ata,
            owner,
            mint
          )
        );
      }

      instructions.push(
        createTransferCheckedInstruction(
          sourceTokenAccount,
          mint,
          ata,
          vaultAuthority,
          amount,
          decimals
        )
      );
    }

    if (instructions.length === 0) continue;

    const { blockhash } = await connection.getLatestBlockhash();

    const message = new TransactionMessage({
      payerKey: vaultAuthority,
      recentBlockhash: blockhash,
      instructions,
    });

    // -------- size guard (best-effort) --------
    const serialized = message.compileToV0Message().serialize();
    console.log(
      `Batch ${b + 1}: recipients=${idxs.length}, instructions=${instructions.length}, tx_size=${serialized.length} bytes`
    );

    if (serialized.length > 1200) {
      throw new Error(
        `Transaction too large (${serialized.length} bytes). Reduce MAX_TRANSFERS_PER_TX.`
      );
    }

    const memo = `Reward payout batch ${b + 1}/${batches.length}`;

    const sigTx = await multisig.rpc.vaultTransactionCreate({
      connection,
      feePayer: member,
      multisigPda,
      transactionIndex: nextTransactionIndex,
      creator: member.publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: message,
      memo,
    });

    await connection.confirmTransaction(sigTx, "confirmed");

    const sigProposal = await multisig.rpc.proposalCreate({
      connection,
      feePayer: member,
      multisigPda,
      transactionIndex: nextTransactionIndex,
      creator: member,
    });

    await connection.confirmTransaction(sigProposal, "confirmed");

    console.log(
      `Batch ${b + 1} created (txIndex=${nextTransactionIndex})`
    );

    nextTransactionIndex += 1n;
  }

  console.log("Done. Proposals created (not approved or executed).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
