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
}
