// src/merkle/tree.ts
// Merkle tree construction and proof generation

import { keccak256 } from 'js-sha3';
import { PublicKey } from '@solana/web3.js';
import { DOMAIN_SEPARATOR, MerkleLeaf, MerkleProof } from './types';

/**
 * Hash function for Merkle tree nodes
 * Uses Keccak-256 (same as Solana's on-chain keccak hash)
 */
export function hash(data: Buffer): Buffer {
  return Buffer.from(keccak256.arrayBuffer(data));
}

/**
 * Hash two child nodes to produce parent
 * Sorts nodes before hashing for deterministic tree construction
 */
export function hashPair(left: Buffer, right: Buffer): Buffer {
  // Sort to ensure deterministic ordering
  const [first, second] = Buffer.compare(left, right) <= 0
    ? [left, right]
    : [right, left];

  return hash(Buffer.concat([first, second]));
}

/**
 * Construct a leaf for the Merkle tree
 * 
 * leaf = hash(domain_separator || distribution_id || recipient || amount)
 * 
 * This provides:
 * - Domain separation (prevents cross-program attacks)
 * - Distribution binding (prevents cross-round replay)
 * - Amount commitment (prevents amount tampering)
 * 
 * MUST match on-chain compute_leaf() exactly!
 */
export function constructLeaf(
  distributionId: string,
  wallet: string,
  amount: bigint
): Buffer {
  const walletPubkey = new PublicKey(wallet);

  // Encode amount as 8-byte little-endian (matches Solana's u64)
  const amountBuffer = Buffer.alloc(8);
  amountBuffer.writeBigUInt64LE(amount);

  // Distribution ID is hex string - decode to bytes
  const distributionIdBuffer = Buffer.from(distributionId, 'hex');

  const data = Buffer.concat([
    Buffer.from(DOMAIN_SEPARATOR),  // Domain separator as UTF-8 bytes
    distributionIdBuffer,            // Distribution ID as raw bytes (32 bytes)
    walletPubkey.toBuffer(),         // Recipient pubkey (32 bytes)
    amountBuffer,                    // Amount as u64 LE (8 bytes)
  ]);

  return hash(data);
}

/**
 * MerkleTree class for building trees and generating proofs
 */
export class MerkleTree {
  private leaves: Buffer[];
  private layers: Buffer[][];

  constructor(leaves: Buffer[]) {
    if (leaves.length === 0) {
      throw new Error('Cannot create Merkle tree with no leaves');
    }

    this.leaves = leaves;
    this.layers = this.buildLayers();
  }

  /**
   * Build all layers of the tree from leaves to root
   */
  private buildLayers(): Buffer[][] {
    const layers: Buffer[][] = [this.leaves];

    while (layers[layers.length - 1].length > 1) {
      const currentLayer = layers[layers.length - 1];
      const nextLayer: Buffer[] = [];

      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          // Hash pair of nodes
          nextLayer.push(hashPair(currentLayer[i], currentLayer[i + 1]));
        } else {
          // Odd node - promote to next level (duplicate for pairing)
          nextLayer.push(hashPair(currentLayer[i], currentLayer[i]));
        }
      }

      layers.push(nextLayer);
    }

    return layers;
  }

  /**
   * Get the Merkle root
   */
  getRoot(): Buffer {
    return this.layers[this.layers.length - 1][0];
  }

  /**
   * Get the Merkle root as hex string
   */
  getRootHex(): string {
    return this.getRoot().toString('hex');
  }

  /**
   * Generate proof for a leaf at given index
   */
  getProof(index: number): Buffer[] {
    if (index < 0 || index >= this.leaves.length) {
      throw new Error(`Invalid leaf index: ${index}`);
    }

    const proof: Buffer[] = [];
    let currentIndex = index;

    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < layer.length) {
        proof.push(layer[siblingIndex]);
      } else {
        // No sibling (odd node at end of layer)
        proof.push(layer[currentIndex]);
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    return proof;
  }

  /**
   * Get proof as hex strings
   */
  getProofHex(index: number): string[] {
    return this.getProof(index).map((p) => p.toString('hex'));
  }

  /**
   * Verify a proof
   */
  static verify(
    root: Buffer,
    leaf: Buffer,
    proof: Buffer[]
  ): boolean {
    let current = leaf;

    for (const sibling of proof) {
      current = hashPair(current, sibling);
    }

    return Buffer.compare(current, root) === 0;
  }

  /**
   * Verify a proof with hex inputs
   */
  static verifyHex(
    rootHex: string,
    leafHex: string,
    proofHex: string[]
  ): boolean {
    return MerkleTree.verify(
      Buffer.from(rootHex, 'hex'),
      Buffer.from(leafHex, 'hex'),
      proofHex.map((p) => Buffer.from(p, 'hex'))
    );
  }
}

/**
 * Build complete Merkle structure from payout entries
 */
export function buildMerkleData(
  distributionId: string,
  entries: Array<{ wallet: string; amount: bigint }>
): {
  tree: MerkleTree;
  leaves: MerkleLeaf[];
  root: string;
  proofs: MerkleProof[];
} {
  // Construct leaves
  const leaves: MerkleLeaf[] = entries.map((entry, index) => ({
    index,
    wallet: entry.wallet,
    amount: entry.amount,
    leaf: constructLeaf(distributionId, entry.wallet, entry.amount),
  }));

  // Build tree
  const tree = new MerkleTree(leaves.map((l) => l.leaf));
  const root = tree.getRootHex();

  // Generate proofs for all leaves
  const proofs: MerkleProof[] = leaves.map((leaf) => ({
    index: leaf.index,
    wallet: leaf.wallet,
    amount: leaf.amount.toString(),
    proof: tree.getProofHex(leaf.index),
  }));

  return { tree, leaves, root, proofs };
}

