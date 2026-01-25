#!/usr/bin/env npx ts-node
// src/utils/test-rpc-failover.ts
// Test script for RPC failover functionality

import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';
import {
  FailoverConnection,
  getRpcConfigFromEnv,
  getRpcState,
  resetRpcState,
  markPrimaryFailed,
  withFailover,
} from './rpc';

const TEST_WALLET = 'vau1zxA2LbssAUEF7Gpw91zMM1LvXrvpzJtmZ58rPsn'; // Known wallet

async function testBasicConnection() {
  console.log('\n=== Test 1: Basic Connection ===\n');

  const config = getRpcConfigFromEnv();
  console.log(`Primary RPC: ${config.primaryUrl}`);
  console.log(`Backup RPC:  ${config.backupUrl || '(not configured)'}`);

  const rpc = new FailoverConnection(config);
  console.log(`\nActive RPC:  ${rpc.getCurrentUrl()}`);
  console.log(`Has backup:  ${rpc.hasBackup()}`);

  // Test a simple RPC call
  console.log('\nTesting getSlot()...');
  const slot = await rpc.execute(
    (conn) => conn.getSlot(),
    'getSlot'
  );
  console.log(`  Current slot: ${slot}`);

  // Test getBalance
  console.log('\nTesting getBalance()...');
  const balance = await rpc.execute(
    (conn) => conn.getBalance(new PublicKey(TEST_WALLET)),
    'getBalance'
  );
  console.log(`  Balance of ${TEST_WALLET}: ${balance / 1e9} SOL`);

  console.log('\n✅ Basic connection test passed!');
}

async function testBothRpcs() {
  console.log('\n=== Test 2: Verify Both RPCs Work ===\n');

  const config = getRpcConfigFromEnv();

  if (!config.backupUrl) {
    console.log('⚠️  No backup RPC configured, skipping this test');
    return;
  }

  // Test primary directly
  console.log('Testing primary RPC directly...');
  const primaryRpc = new FailoverConnection({
    ...config,
    backupUrl: undefined, // Force primary only
  });

  try {
    const primarySlot = await primaryRpc.execute(
      (conn) => conn.getSlot(),
      'primaryGetSlot'
    );
    console.log(`  Primary slot: ${primarySlot}`);
    console.log('  ✅ Primary RPC is working');
  } catch (e: any) {
    console.log(`  ❌ Primary RPC failed: ${e.message}`);
  }

  // Test backup directly
  console.log('\nTesting backup RPC directly...');
  const backupRpc = new FailoverConnection({
    primaryUrl: config.backupUrl,
    backupUrl: undefined,
    commitment: 'confirmed',
  });

  try {
    const backupSlot = await backupRpc.execute(
      (conn) => conn.getSlot(),
      'backupGetSlot'
    );
    console.log(`  Backup slot: ${backupSlot}`);
    console.log('  ✅ Backup RPC is working');
  } catch (e: any) {
    console.log(`  ❌ Backup RPC failed: ${e.message}`);
  }
}

async function testFailoverSimulation() {
  console.log('\n=== Test 3: Failover Simulation ===\n');

  const config = getRpcConfigFromEnv();

  if (!config.backupUrl) {
    console.log('⚠️  No backup RPC configured, skipping this test');
    return;
  }

  // Reset state
  resetRpcState();
  console.log('Initial state:', getRpcState());

  const rpc = new FailoverConnection(config);
  console.log(`Active RPC: ${rpc.getCurrentUrl()}`);

  // Simulate primary failure
  console.log('\nSimulating primary RPC failure...');
  markPrimaryFailed(config);

  console.log('State after failure:', getRpcState());
  console.log(`Active RPC now: ${rpc.getCurrentUrl()}`);

  // Verify we can still make calls (should use backup)
  console.log('\nMaking RPC call after simulated failure...');
  const slot = await rpc.execute(
    (conn) => conn.getSlot(),
    'getSlotAfterFailover'
  );
  console.log(`  Slot from backup: ${slot}`);

  // Reset for future tests
  resetRpcState();
  console.log('\n✅ Failover simulation passed!');
}

async function testInvalidUrlFailover() {
  console.log('\n=== Test 4: Real Failover (Invalid Primary) ===\n');

  const config = getRpcConfigFromEnv();

  if (!config.backupUrl) {
    console.log('⚠️  No backup RPC configured, skipping this test');
    return;
  }

  // Reset state
  resetRpcState();

  // Use an invalid primary URL to trigger real failover
  const testConfig = {
    primaryUrl: 'https://invalid-rpc-that-does-not-exist.example.com',
    backupUrl: config.backupUrl,
    commitment: 'confirmed' as const,
    maxRetries: 2,
    retryDelayMs: 500,
  };

  console.log(`Primary (invalid): ${testConfig.primaryUrl}`);
  console.log(`Backup (valid):    ${testConfig.backupUrl}`);

  console.log('\nAttempting RPC call with invalid primary...');
  console.log('(This should failover to backup automatically)\n');

  try {
    const slot = await withFailover(
      testConfig,
      (conn) => conn.getSlot(),
      'getSlotWithInvalidPrimary'
    );
    console.log(`  ✅ Got slot from backup: ${slot}`);
    console.log('\nFinal state:', getRpcState());
  } catch (e: any) {
    console.log(`  ❌ Failed: ${e.message}`);
  }

  // Reset for future tests
  resetRpcState();
}

async function testLatency() {
  console.log('\n=== Test 5: Latency Comparison ===\n');

  const config = getRpcConfigFromEnv();

  // Test primary latency
  console.log('Testing primary RPC latency...');
  const primaryStart = Date.now();
  const primaryRpc = new FailoverConnection({
    ...config,
    backupUrl: undefined,
  });

  try {
    await primaryRpc.execute((conn) => conn.getSlot(), 'latencyTest');
    const primaryLatency = Date.now() - primaryStart;
    console.log(`  Primary latency: ${primaryLatency}ms`);
  } catch (e: any) {
    console.log(`  Primary failed: ${e.message}`);
  }

  if (config.backupUrl) {
    // Test backup latency
    console.log('Testing backup RPC latency...');
    const backupStart = Date.now();
    const backupRpc = new FailoverConnection({
      primaryUrl: config.backupUrl,
      backupUrl: undefined,
      commitment: 'confirmed',
    });

    try {
      await backupRpc.execute((conn) => conn.getSlot(), 'latencyTest');
      const backupLatency = Date.now() - backupStart;
      console.log(`  Backup latency: ${backupLatency}ms`);
    } catch (e: any) {
      console.log(`  Backup failed: ${e.message}`);
    }
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║         RPC Failover Test Suite                    ║');
  console.log('╚════════════════════════════════════════════════════╝');

  try {
    await testBasicConnection();
    await testBothRpcs();
    await testFailoverSimulation();
    await testInvalidUrlFailover();
    await testLatency();

    console.log('\n╔════════════════════════════════════════════════════╗');
    console.log('║         All Tests Complete!                        ║');
    console.log('╚════════════════════════════════════════════════════╝\n');
  } catch (e: any) {
    console.error('\n❌ Test failed:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
