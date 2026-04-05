import 'dotenv/config';
import { runBacktest } from '../src/backend/backtest/BacktestRunner.ts';

const symbol = process.argv[2] || 'BTCUSDT';
const days = Math.min(365, Math.max(1, parseInt(process.argv[3] || '14', 10)));
const interval = process.argv[4] || '5m';
const useAI = process.argv.includes('--ai');

runBacktest({ symbol, interval, days, useAI })
  .then((r) => {
    console.log('\n--- Result ---');
    console.log(JSON.stringify({ ...r, logs: `[${r.logs.length} lines]` }, null, 2));
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
