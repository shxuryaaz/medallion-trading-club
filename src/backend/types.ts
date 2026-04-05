export interface TradeLog {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice?: number;
  amount: number;
  pnl?: number;
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
}
