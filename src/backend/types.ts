export interface TradeLog {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice?: number;
  amount: number;
  /** Net PnL after fees (same as netPnl when set). */
  pnl?: number;
  grossPnl?: number;
  netPnl?: number;
  entryFee?: number;
  exitFee?: number;
  status: 'OPEN' | 'CLOSED';
  timestamp: number;
  exitTimestamp?: number;
  source?: 'swing' | 'scalp'; // which engine opened this trade
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
