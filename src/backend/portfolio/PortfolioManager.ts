import { StateStore } from '../persistence/StateStore';

export interface CapitalAllocation {
  approved: boolean;
  riskAllocated: number;
  reason?: string;
}

interface RiskEntry {
  engineId: string;
  tradeId: string;
  riskAtStop: number; // dollars at risk if stop is hit
}

// Cross-engine risk constants
const MAX_PORTFOLIO_RISK_FRAC = 0.04;  // 4% of balance total (2% swing + 2% scalp headroom)
const MAX_SYMBOL_RISK_FRAC    = 0.02;  // 2% per symbol — swing + scalp combined
const ENGINE_TRADE_CAPS: Record<string, number> = { swing: 2, scalp: 3 };

export class PortfolioManager {
  private balance: number;

  // symbol → list of open risk entries (one per open trade on that symbol, any engine)
  private registry = new Map<string, RiskEntry[]>();

  constructor() {
    const snap = StateStore.loadPortfolio();
    this.balance = snap?.balance ?? 10_000;
    console.log(`[Portfolio] Initialized. Balance: ${this.balance.toFixed(2)}`);
  }

  // ── Capital gating ────────────────────────────────────────────────────────
  //
  // MUST be called synchronously. No await between requestCapital() and
  // registerTrade() — Node.js single-thread guarantee keeps this atomic.

  requestCapital(engineId: string, symbol: string, riskAmount: number): CapitalAllocation {
    if (!Number.isFinite(riskAmount) || riskAmount <= 0) {
      return { approved: false, riskAllocated: 0, reason: 'invalid_risk_amount' };
    }

    // Per-symbol cap: swing + scalp combined cannot exceed MAX_SYMBOL_RISK_FRAC
    const symRisk = this.getSymbolRisk(symbol);
    const symCap  = this.balance * MAX_SYMBOL_RISK_FRAC;
    if (symRisk >= symCap) {
      return { approved: false, riskAllocated: 0, reason: 'symbol_risk_cap' };
    }

    // Global portfolio cap across all engines
    const totalRisk   = this.getTotalRisk();
    const portfolioCap = this.balance * MAX_PORTFOLIO_RISK_FRAC;
    const room = portfolioCap - totalRisk;
    if (room <= 0) {
      return { approved: false, riskAllocated: 0, reason: 'portfolio_risk_cap' };
    }

    // Allocate the min of requested, global room, and per-symbol room
    const allocated = Math.min(riskAmount, room, symCap - symRisk);
    if (allocated <= 0) {
      return { approved: false, riskAllocated: 0, reason: 'no_room' };
    }

    return { approved: true, riskAllocated: allocated };
  }

  // ── Position lifecycle ────────────────────────────────────────────────────

  registerTrade(engineId: string, tradeId: string, symbol: string, riskAtStop: number): void {
    const list = this.registry.get(symbol) ?? [];
    list.push({ engineId, tradeId, riskAtStop });
    this.registry.set(symbol, list);
  }

  closeTrade(tradeId: string, pnl: number): void {
    // Remove from risk registry
    for (const [symbol, list] of this.registry) {
      const idx = list.findIndex(r => r.tradeId === tradeId);
      if (idx !== -1) {
        list.splice(idx, 1);
        if (list.length === 0) this.registry.delete(symbol);
        break;
      }
    }
    // Update balance — this is the single place balance is mutated
    this.balance += pnl;
    StateStore.savePortfolio({ balance: this.balance });
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  getBalance(): number {
    return this.balance;
  }

  /**
   * How many trades does this engine currently have in the risk registry?
   * Used by engines to enforce their own per-engine trade cap.
   */
  getEngineOpenCount(engineId: string): number {
    let n = 0;
    for (const list of this.registry.values()) {
      n += list.filter(r => r.engineId === engineId).length;
    }
    return n;
  }

  getEngineMaxTrades(engineId: string): number {
    return ENGINE_TRADE_CAPS[engineId] ?? 2;
  }

  getRiskSummary(): { totalRisk: number; portfolioCap: number; perSymbol: Record<string, number> } {
    const perSymbol: Record<string, number> = {};
    for (const [sym, list] of this.registry) {
      perSymbol[sym] = list.reduce((s, r) => s + r.riskAtStop, 0);
    }
    return {
      totalRisk: this.getTotalRisk(),
      portfolioCap: this.balance * MAX_PORTFOLIO_RISK_FRAC,
      perSymbol,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private getSymbolRisk(symbol: string): number {
    return (this.registry.get(symbol) ?? []).reduce((s, r) => s + r.riskAtStop, 0);
  }

  private getTotalRisk(): number {
    let total = 0;
    for (const list of this.registry.values()) {
      for (const r of list) total += r.riskAtStop;
    }
    return total;
  }
}
