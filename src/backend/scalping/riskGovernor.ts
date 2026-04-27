import type { TradeLog } from '../types';
import { closedTradeNetAmount } from '../fees';

export type PrimaryLossCause = 'signal_failure' | 'slippage' | 'fees' | 'late_entry';

export interface RollingMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  expectancyR: number;
}

export interface LossBreakdown {
  signal_failure: number;
  slippage: number;
  fees: number;
  late_entry: number;
}

export interface ScalpRiskState {
  performanceLockoutUntil?: number;
  softPauseUntil?: number;
  riskMultiplier: number;
}

export interface RiskGovernorSnapshot {
  rolling5: RollingMetrics;
  rolling10: RollingMetrics;
  rolling15: RollingMetrics;
  performanceByVersion: Record<string, RollingMetrics>;
}

export type RiskGovernorDecision =
  | { level: 'normal'; riskMultiplier: 1; reason: 'normal'; snapshot: RiskGovernorSnapshot }
  | { level: 'early_warning'; riskMultiplier: 0.5; reason: 'early_warning'; snapshot: RiskGovernorSnapshot }
  | { level: 'soft_disable'; riskMultiplier: 0; reason: 'soft_disable'; pauseMs: number; snapshot: RiskGovernorSnapshot }
  | { level: 'hard_lockout'; riskMultiplier: 0; reason: 'hard_lockout'; pauseMs: number; snapshot: RiskGovernorSnapshot };

const SOFT_DISABLE_MS = 2 * 60 * 60_000;
const HARD_LOCKOUT_MS = 24 * 60 * 60_000;

function closedTrades(trades: TradeLog[]): TradeLog[] {
  return trades.filter((trade) => closedTradeNetAmount(trade) != null);
}

function tradeR(trade: TradeLog): number {
  if (typeof trade.R === 'number' && Number.isFinite(trade.R)) return trade.R;
  const pnl = closedTradeNetAmount(trade);
  const risk = trade.initialRiskUsd;
  if (pnl == null || typeof risk !== 'number' || risk <= 0) return 0;
  return pnl / risk;
}

export function getRollingMetrics(trades: TradeLog[], window: number): RollingMetrics {
  const recent = closedTrades(trades).slice(-window);
  const wins = recent.filter((trade) => (closedTradeNetAmount(trade) ?? 0) > 0);
  const losses = recent.filter((trade) => (closedTradeNetAmount(trade) ?? 0) < 0);
  const sumWins = wins.reduce((sum, trade) => sum + (closedTradeNetAmount(trade) ?? 0), 0);
  const sumLosses = Math.abs(losses.reduce((sum, trade) => sum + (closedTradeNetAmount(trade) ?? 0), 0));

  return {
    trades: recent.length,
    wins: wins.length,
    losses: losses.length,
    winRate: recent.length > 0 ? wins.length / recent.length : 0,
    profitFactor: sumLosses > 0 ? sumWins / sumLosses : sumWins > 0 ? Number.POSITIVE_INFINITY : 0,
    expectancyR: recent.length > 0 ? recent.reduce((sum, trade) => sum + tradeR(trade), 0) / recent.length : 0,
  };
}

export function getLossBreakdown(trades: TradeLog[]): LossBreakdown {
  const out: LossBreakdown = {
    signal_failure: 0,
    slippage: 0,
    fees: 0,
    late_entry: 0,
  };

  for (const trade of closedTrades(trades)) {
    if ((closedTradeNetAmount(trade) ?? 0) >= 0) continue;
    const cause = trade.primaryLossCause ?? 'signal_failure';
    out[cause] += 1;
  }
  return out;
}

export function classifyLossCause(params: {
  trade: TradeLog;
  grossPnlUsd: number;
  feesUsd: number;
  mfeUsd?: number;
}): PrimaryLossCause | undefined {
  const r = params.trade.R ?? (
    params.trade.initialRiskUsd > 0 ? (params.trade.netPnlUsd ?? params.trade.netPnl ?? params.trade.pnl ?? 0) / params.trade.initialRiskUsd : 0
  );
  if (r >= 0) return undefined;

  if (params.trade.entrySlippageBps > 3) return 'slippage';
  if (params.feesUsd > Math.abs(params.grossPnlUsd) * 0.3) return 'fees';
  if ((params.mfeUsd ?? 0) > 0 && params.trade.exitReason === 'SL') return 'late_entry';
  return 'signal_failure';
}

export function getPerformanceByVersion(trades: TradeLog[], window: number): Record<string, RollingMetrics> {
  const byVersion: Record<string, TradeLog[]> = {};
  for (const trade of closedTrades(trades)) {
    const versionId = trade.strategyVersionId ?? 'v1';
    byVersion[versionId] ??= [];
    byVersion[versionId].push(trade);
  }

  const out: Record<string, RollingMetrics> = {};
  for (const [versionId, versionTrades] of Object.entries(byVersion)) {
    out[versionId] = getRollingMetrics(versionTrades, window);
  }
  return out;
}

export function evaluateRiskGovernor(trades: TradeLog[]): RiskGovernorDecision {
  const snapshot: RiskGovernorSnapshot = {
    rolling5: getRollingMetrics(trades, 5),
    rolling10: getRollingMetrics(trades, 10),
    rolling15: getRollingMetrics(trades, 15),
    performanceByVersion: getPerformanceByVersion(trades, 15),
  };

  if (
    snapshot.rolling15.trades >= 15 &&
    (
      snapshot.rolling15.wins === 0 ||
      snapshot.rolling15.profitFactor < 0.5 ||
      snapshot.rolling15.winRate < 0.15
    )
  ) {
    return { level: 'hard_lockout', riskMultiplier: 0, reason: 'hard_lockout', pauseMs: HARD_LOCKOUT_MS, snapshot };
  }

  if (
    snapshot.rolling10.trades >= 10 &&
    (
      snapshot.rolling10.profitFactor < 0.7 ||
      snapshot.rolling10.winRate < 0.2
    )
  ) {
    return { level: 'soft_disable', riskMultiplier: 0, reason: 'soft_disable', pauseMs: SOFT_DISABLE_MS, snapshot };
  }

  if (
    snapshot.rolling5.trades >= 5 &&
    (
      snapshot.rolling5.expectancyR < -0.5 ||
      snapshot.rolling5.losses === 5
    )
  ) {
    return { level: 'early_warning', riskMultiplier: 0.5, reason: 'early_warning', snapshot };
  }

  return { level: 'normal', riskMultiplier: 1, reason: 'normal', snapshot };
}
