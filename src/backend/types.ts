export interface TradeLog {
  id: string;
  strategyVersionId: string;
  parameterSetId: string;
  experimentId?: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  source: 'swing' | 'scalp'; // which engine opened this trade
  status: 'OPEN' | 'CLOSED';

  // Entry audit
  signalPrice: number;
  fillPrice: number;
  entrySlippageBps: number;

  // Planned structure at entry
  plannedStopLoss: number;
  plannedTakeProfit: number;
  initialRiskUsd: number;
  plannedRewardUsd: number;
  plannedRiskReward: number;

  // Live state for open-trade audit views
  currentPrice?: number;
  unrealizedPnlUsd?: number;
  distanceToStopBps?: number;
  distanceToTakeProfitBps?: number;

  // Exit audit
  exitPrice?: number;
  exitReason?: 'TP' | 'SL' | 'MANUAL' | 'ERROR';
  exitSlippageBps?: number;

  // PnL audit
  feesUsd?: number;
  netPnlUsd?: number;
  R?: number;

  createdAt: number;
  closedAt?: number;

  // Compatibility fields consumed by existing UI / persistence code.
  signalTimestamp?: number;
  latencyMs?: number;
  entryPrice: number;
  amount: number;
  /** Net PnL after fees (same as netPnl when set). */
  pnl?: number;
  grossPnl?: number;
  netPnl?: number;
  entryFee?: number;
  exitFee?: number;
  timestamp: number;
  exitTimestamp?: number;
  /** Scalp entry diagnostics (optional; swing omits). */
  scalpEntryQuality?: {
    score: number;
    momentumStrength: number;
    volShort: number;
  };
  /** Planned exit distances at open (scalp only). */
  scalpRiskReward?: {
    slDistance: number;
    tpDistance: number;
    riskReward: number;
  };
}
