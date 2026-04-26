import fs from 'fs/promises';
import path from 'path';

const LOG_DIR = path.join(process.cwd(), 'logs');
const TRADE_LOG_FILE = path.join(LOG_DIR, 'trades.jsonl');

export const MAX_ENTRY_LATENCY_MS = 1000;
export const MAX_ENTRY_SLIPPAGE_BPS = 5;
export const DAILY_LOSS_LIMIT_FRAC = 0.02;

export type TradeSource = 'swing' | 'scalp';
export type TradeExitReason = 'TP' | 'SL' | 'MANUAL' | 'ERROR';

export interface TradeLog {
  id: string;
  strategyVersionId: string;
  parameterSetId: string;
  experimentId?: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  source: TradeSource;
  status: 'OPEN' | 'CLOSED';

  // Entry audit.
  signalPrice: number;
  fillPrice: number;
  entrySlippageBps: number;

  // Planned structure at entry.
  plannedStopLoss: number;
  plannedTakeProfit: number;
  initialRiskUsd: number;
  plannedRewardUsd: number;
  plannedRiskReward: number;

  // Live state for open trades, filled by API snapshots.
  currentPrice?: number;
  unrealizedPnlUsd?: number;
  distanceToStopBps?: number;
  distanceToTakeProfitBps?: number;

  // Exit audit.
  exitPrice?: number;
  exitReason?: TradeExitReason;
  exitSlippageBps?: number;

  // PnL audit.
  feesUsd?: number;
  netPnlUsd?: number;
  R?: number;

  createdAt: number;
  closedAt?: number;

  // Compatibility fields consumed by existing status/UI/stats code.
  entryPrice: number;
  amount: number;
  timestamp: number;
  exitTimestamp?: number;
  pnl?: number;
  grossPnl?: number;
  netPnl?: number;
  entryFee?: number;
  exitFee?: number;
  signalTimestamp?: number;
  latencyMs?: number;

  scalpEntryQuality?: {
    score: number;
    momentumStrength: number;
    volShort: number;
  };
  scalpRiskReward?: {
    slDistance: number;
    tpDistance: number;
    riskReward: number;
  };
}

export interface TradeOpenedAuditEvent {
  event: 'TRADE_OPENED';
  tradeId: string;
  symbol: string;
  source: TradeSource;
  side: 'LONG' | 'SHORT';
  signalPrice: number;
  fillPrice: number;
  plannedStopLoss: number;
  plannedTakeProfit: number;
  plannedRiskReward: number;
  entrySlippageBps: number;
}

export interface TradeClosedAuditEvent {
  event: 'TRADE_CLOSED';
  tradeId: string;
  exitPrice: number;
  exitReason: TradeExitReason;
  feesUsd: number;
  netPnlUsd: number;
  R: number;
}

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

export function plannedRewardUsd(fillPrice: number, takeProfit: number, quantity: number): number {
  return Math.abs(takeProfit - fillPrice) * quantity;
}

export function plannedRiskReward(initialRiskUsd: number, rewardUsd: number): number {
  return initialRiskUsd > 0 ? rewardUsd / initialRiskUsd : 0;
}

export function mapExitReason(reason: string): TradeExitReason {
  if (reason === 'TP' || reason === 'Take Profit') return 'TP';
  if (reason === 'SL' || reason === 'Stop Loss') return 'SL';
  if (reason === 'ERROR') return 'ERROR';
  return 'MANUAL';
}

async function appendJsonLine(value: unknown): Promise<void> {
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(TRADE_LOG_FILE, `${JSON.stringify(value)}\n`, 'utf8');
}

export async function appendTradeOpened(event: TradeOpenedAuditEvent): Promise<void> {
  await appendJsonLine(event);
}

export async function appendTradeClosed(event: TradeClosedAuditEvent): Promise<void> {
  await appendJsonLine(event);
}

export async function appendTradeTelemetry(trade: TradeTelemetry): Promise<void> {
  await appendJsonLine(trade);
}

