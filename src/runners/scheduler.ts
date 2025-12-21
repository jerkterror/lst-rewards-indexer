// src/runners/scheduler.ts
import cron from 'node-cron';
import { runSnapshot } from '../indexers/snapshot';

console.log('Snapshot scheduler starting (every 6 hours)');
 
cron.schedule('0 */6 * * *', async () => {
//1m schedule for testing
//cron.schedule('* * * * *', async () => {
  console.log('Running scheduled snapshot');
  try {
    await runSnapshot();
  } catch (e) {
    console.error('Snapshot run failed:', e);
  }
});
