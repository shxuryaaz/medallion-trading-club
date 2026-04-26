import type { TradeLog } from '../types';

export interface VersionPerformance {
  strategyVersionId: string;
  trades: number;
  expectancyR: number;
  profitFactor: number | null;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  maxDrawdownPct: number;
  avgEntrySlippageBps: number;
  avgExitSlippageBps: number;
}

function mean(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function maxDrawdownPct(trades: TradeLog[]): number {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;

  for (const trade of trades) {
    equity += trade.netPnlUsd ?? trade.netPnl ?? trade.pnl ?? 0;
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    }
  }

  return maxDrawdown;
}

export class PerformanceAnalyzer {
  static analyzeByVersion(trades: TradeLog[]): VersionPerformance[] {
    const closed = trades
      .filter((trade) => trade.status === 'CLOSED')
      .filter((trade) => typeof trade.R === 'number' || typeof trade.netPnlUsd === 'number');

    const groups = new Map<string, TradeLog[]>();
    for (const trade of closed) {
      const versionId = trade.strategyVersionId ?? 'v1';
      const list = groups.get(versionId) ?? [];
      list.push(trade);
      groups.set(versionId, list);
    }

    return [...groups.entries()]
      .map(([strategyVersionId, list]) => {
        const rs = list.map((trade) => trade.R ?? 0);
        const wins = list.filter((trade) => (trade.netPnlUsd ?? trade.netPnl ?? trade.pnl ?? 0) > 0);
        const losses = list.filter((trade) => (trade.netPnlUsd ?? trade.netPnl ?? trade.pnl ?? 0) < 0);
        const grossProfit = wins.reduce(
          (sum, trade) => sum + (trade.netPnlUsd ?? trade.netPnl ?? trade.pnl ?? 0),
          0
        );
        const grossLoss = losses.reduce(
          (sum, trade) => sum + (trade.netPnlUsd ?? trade.netPnl ?? trade.pnl ?? 0),
          0
        );
        const winRs = wins.map((trade) => trade.R ?? 0).filter((r) => r > 0);
        const lossRs = losses.map((trade) => trade.R ?? 0).filter((r) => r < 0);

        return {
          strategyVersionId,
          trades: list.length,
          expectancyR: mean(rs),
          profitFactor: losses.length > 0 ? grossProfit / Math.abs(grossLoss) : grossProfit > 0 ? null : 0,
          winRate: list.length > 0 ? wins.length / list.length : 0,
          avgWinR: mean(winRs),
          avgLossR: mean(lossRs),
          maxDrawdownPct: maxDrawdownPct(list),
          avgEntrySlippageBps: mean(list.map((trade) => trade.entrySlippageBps ?? 0)),
          avgExitSlippageBps: mean(list.map((trade) => trade.exitSlippageBps ?? 0)),
        };
      })
      .sort((a, b) => b.trades - a.trades);
  }
}
