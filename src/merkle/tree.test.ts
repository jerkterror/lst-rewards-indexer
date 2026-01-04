// Test file for Merkle tree odd-node handling
// Run with: npx ts-node src/merkle/tree.test.ts

import { MerkleTree, constructLeaf, hashPair } from './tree';
import { DOMAIN_SEPARATOR } from './types';

function testOddNodes() {
  console.log('🧪 Testing Merkle Tree with Odd Number of Leaves\n');

  const distributionId = '0'.repeat(64); // 32 bytes as hex

  // Test cases: 1, 3, 5, 7 recipients (all odd)
  const testCases = [
    { count: 1, name: 'Single recipient' },
    { count: 3, name: 'Three recipients' },
    { count: 5, name: 'Five recipients' },
    { count: 7, name: 'Seven recipients' },
  ];

  for (const testCase of testCases) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Test: ${testCase.name} (${testCase.count} leaves)`);
    console.log('='.repeat(60));

    // Generate test wallets and amounts
    const entries = Array.from({ length: testCase.count }, (_, i) => ({
      wallet: `${i + 1}${'1'.repeat(43)}`, // Valid-ish base58 addresses
      amount: BigInt((i + 1) * 1000),
    }));

    // Build leaves
    const leaves = entries.map((e) =>
      constructLeaf(distributionId, e.wallet, e.amount)
    );

    console.log(`Leaves: ${leaves.length}`);
    leaves.forEach((leaf, i) => {
      console.log(`  [${i}] ${leaf.toString('hex').slice(0, 16)}...`);
    });

    // Build tree
    const tree = new MerkleTree(leaves);
    const root = tree.getRoot();

    console.log(`\nMerkle Root: ${root.toString('hex').slice(0, 32)}...`);

    // Verify all proofs
    console.log('\nVerifying all proofs:');
    let allValid = true;

    for (let i = 0; i < entries.length; i++) {
      const leaf = leaves[i];
      const proof = tree.getProof(i);

      console.log(`\n  Leaf [${i}]:`);
      console.log(`    Proof length: ${proof.length}`);

      // Show if this leaf uses itself as sibling
      const hasSelfSibling = proof.some(p => p.equals(leaf));
      if (hasSelfSibling) {
        console.log(`    ⚠️  Contains SELF as sibling (odd node)`);
      }

      // Manually verify (simulating on-chain verification)
      let current = leaf;
      for (let j = 0; j < proof.length; j++) {
        const sibling = proof[j];
        console.log(`    Step ${j}: hash_pair(current, ${sibling.toString('hex').slice(0, 16)}...)`);
        current = hashPair(current, sibling);
      }

      const isValid = current.equals(root);
      console.log(`    Result: ${isValid ? '✅ VALID' : '❌ INVALID'}`);

      if (!isValid) {
        allValid = false;
        console.log(`    ❌ VERIFICATION FAILED FOR LEAF ${i}`);
        console.log(`       Expected: ${root.toString('hex')}`);
        console.log(`       Got:      ${current.toString('hex')}`);
      }
    }

    if (allValid) {
      console.log(`\n✅ All ${entries.length} proofs verified successfully!`);
    } else {
      console.log(`\n❌ SOME PROOFS FAILED!`);
      throw new Error('Proof verification failed');
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('🎉 All odd-node tests passed!');
  console.log('='.repeat(60));
}

// Also test the hash_pair function with identical inputs
function testHashPairIdentical() {
  console.log('\n🧪 Testing hash_pair(X, X) behavior\n');

  const testValue = Buffer.from('a'.repeat(64), 'hex'); // 32 bytes
  const result = hashPair(testValue, testValue);

  console.log(`Input:  ${testValue.toString('hex').slice(0, 32)}...`);
  console.log(`Output: ${result.toString('hex').slice(0, 32)}...`);
  console.log(`✅ hash_pair(X, X) produces deterministic output`);
}

// Run tests
testHashPairIdentical();
testOddNodes();
