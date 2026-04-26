import fs from 'fs/promises';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const TRADE_LOG_FILE = path.join(LOG_DIR, 'trades.jsonl');

export const MAX_ENTRY_LATENCY_MS = 1000;
export const MAX_ENTRY_SLIPPAGE_BPS = 5;
export const DAILY_LOSS_LIMIT_FRAC = 0.02;

export interface TradeTelemetry {
  tradeId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  signalPrice: number;
  fillPrice: number;
  entrySlippageBps: number;
  exitSlippageBps: number;
  feesUsd: number;
  netPnlUsd: number;
  R: number;
  latencyMs: number;
}

export function entrySlippageBps(
  side: 'LONG' | 'SHORT',
  signalPrice: number,
  fillPrice: number
): number {
  if (signalPrice <= 0 || fillPrice <= 0) return 0;
  return side === 'LONG'
    ? ((fillPrice - signalPrice) / signalPrice) * 10_000
    : ((signalPrice - fillPrice) / signalPrice) * 10_000;
}

export function exitSlippageBps(
  side: 'LONG' | 'SHORT',
  expectedExitPrice: number,
  fillPrice: number
): number {
  if (expectedExitPrice <= 0 || fillPrice <= 0) return 0;
  return side === 'LONG'
    ? ((expectedExitPrice - fillPrice) / expectedExitPrice) * 10_000
    : ((fillPrice - expectedExitPrice) / expectedExitPrice) * 10_000;
}

export async function appendTradeTelemetry(trade: TradeTelemetry): Promise<void> {
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(TRADE_LOG_FILE, `${JSON.stringify(trade)}\n`, 'utf8');
}

