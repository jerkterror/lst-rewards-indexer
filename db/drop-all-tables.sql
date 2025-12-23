-- Drop all existing tables (CASCADE will drop dependent objects)
-- WARNING: This will delete ALL data in these tables!

DROP TABLE IF EXISTS reward_dust_ledger CASCADE;
DROP TABLE IF EXISTS reward_payouts_preview CASCADE;
DROP TABLE IF EXISTS reward_configs CASCADE;
DROP TABLE IF EXISTS reward_shares CASCADE;
DROP TABLE IF EXISTS weights CASCADE;
DROP TABLE IF EXISTS snapshots CASCADE;
DROP TABLE IF EXISTS wallets CASCADE;

-- Verify all tables are dropped
SELECT 'Tables remaining:' as status;
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
