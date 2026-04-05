/** Taker-style fee per side (fraction of notional). */
export const FEE_RATE_PER_SIDE = 0.001;

export function feeOnNotional(price: number, quantity: number): number {
  return price * quantity * FEE_RATE_PER_SIDE;
}

export function entryExitFees(
  entryPrice: number,
  exitPrice: number,
  quantity: number
): { entryFee: number; exitFee: number } {
  return {
    entryFee: feeOnNotional(entryPrice, quantity),
    exitFee: feeOnNotional(exitPrice, quantity),
  };
}

/**
 * Skip entries where TP distance is smaller than round-trip fee edge (2 × fee × price).
 */
export function minTpDistanceForFees(referencePrice: number): number {
  return 2 * FEE_RATE_PER_SIDE * referencePrice;
}

/** Net PnL for stats: prefer explicit net when present (post-fees rollout). */
export function closedTradeNetAmount(t: {
  status: string;
  pnl?: number;
  netPnl?: number;
}): number | null {
  if (t.status !== 'CLOSED') return null;
  if (typeof t.netPnl === 'number') return t.netPnl;
  if (typeof t.pnl === 'number') return t.pnl;
  return null;
}
