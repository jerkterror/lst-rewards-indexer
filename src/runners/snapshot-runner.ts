// src/runners/snapshot-runner.ts
import { runSnapshot } from '../indexers/snapshot';

async function main() {
  await runSnapshot();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
