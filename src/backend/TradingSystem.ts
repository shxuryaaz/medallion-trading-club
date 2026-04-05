import { randomUUID } from 'crypto';
import { DataLayer, OHLCV } from './DataLayer';
import {
  ScoringEngine,
  Position,
  RiskAgent,
  RISK_PER_TRADE,
  LOW_ATR_HALVE_RISK_PCT,
  analyzeMarketForTrading,
  type AiEnrichmentContext,
} from './Engine';
import type { TradeLog } from './types';
import { StateStore } from './persistence/StateStore';

export type { TradeLog } from './types';

const MAX_OPEN_TRADES = 2;
const MAX_PORTFOLIO_RISK_FRAC = 0.02;
/** Global cooldown after any new open. */
const TRADE_COOLDOWN_MS = 20 * 60 * 1000;
/** After closing a symbol, block re-entry on that symbol. */
const SYMBOL_REENTRY_COOLDOWN_MS = 30 * 60 * 1000;
/** After 3 consecutive closed losses, pause new entries (BTC stability). */
const LOSS_STREAK_PAUSE_MS = 60 * 60 * 1000;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function riskAtStop(pos: Position): number {
  return Math.abs(pos.entryPrice - pos.stopLoss) * pos.amount;
}

function normalizeLoadedPosition(p: Partial<Position> & Record<string, unknown>): Position | null {
  if (
    typeof p.entryPrice !== 'number' ||
    typeof p.amount !== 'number' ||
    (p.side !== 'LONG' && p.side !== 'SHORT')
  ) {
    return null;
  }
  const entry = p.entryPrice;
  const amount = p.amount;
  const side = p.side;
  const current =
    typeof p.currentPrice === 'number' ? p.currentPrice : entry;
  const unrealized =
    typeof p.unrealizedPnl === 'number'
      ? p.unrealizedPnl
      : side === 'LONG'
        ? (current - entry) * amount
        : (entry - current) * amount;
  const tid = typeof p.tradeId === 'string' && p.tradeId.length > 0 ? p.tradeId : '';
  return {
    tradeId: tid,
    symbol: typeof p.symbol === 'string' ? p.symbol : '',
    entryPrice: entry,
    currentPrice: current,
    unrealizedPnl: unrealized,
    amount,
    side,
    stopLoss: typeof p.stopLoss === 'number' ? p.stopLoss : entry,
    takeProfit: typeof p.takeProfit === 'number' ? p.takeProfit : entry,
    timestamp: typeof p.timestamp === 'number' ? p.timestamp : Date.now(),
  };
}

export class TradingSystem {
  private balance: number = 10000;
  private activePositions: Position[] = [];
  private tradeHistory: TradeLog[] = [];
  private isRunning: boolean = false;
  private logs: string[] = [];
  private lastTradeOpenedAt = 0;
  private symbolLastClosedAt = new Map<string, number>();
  private lossStreakPauseUntil = 0;

  constructor() {
    const snap = StateStore.load();
    if (snap) {
      this.balance = snap.balance;
      this.tradeHistory = snap.tradeHistory;
      this.activePositions = snap.activePositions
        .map((p) => normalizeLoadedPosition(p as Partial<Position> & Record<string, unknown>))
        .filter((p): p is Position => p !== null);
      for (const t of this.tradeHistory) {
        if (t.status !== 'OPEN') continue;
        const pos = this.activePositions.find(
          (p) => p.symbol === t.symbol && p.entryPrice === t.entryPrice && p.side === t.side
        );
        if (pos) pos.tradeId = t.id;
      }
      for (const pos of this.activePositions) {
        if (pos.tradeId) continue;
        const t = this.tradeHistory.find(
          (tr) =>
            tr.status === 'OPEN' &&
            tr.symbol === pos.symbol &&
            tr.entryPrice === pos.entryPrice &&
            tr.side === pos.side
        );
        if (t) pos.tradeId = t.id;
      }
      const before = this.activePositions.length;
      this.activePositions = this.activePositions.filter((pos) => {
        const ok =
          Boolean(pos.tradeId) &&
          this.tradeHistory.some((t) => t.id === pos.tradeId && t.status === 'OPEN');
        if (!ok) {
          console.error(
            '[TradingSystem] dropped position without matching OPEN trade:',
            pos.symbol,
            pos.tradeId
          );
        }
        return ok;
      });
      if (this.activePositions.length < before) {
        console.error('[TradingSystem] removed', before - this.activePositions.length, 'orphan position(s) on load');
      }
      if (
        typeof snap.lossStreakPauseUntil === 'number' &&
        Number.isFinite(snap.lossStreakPauseUntil) &&
        snap.lossStreakPauseUntil > Date.now()
      ) {
        this.lossStreakPauseUntil = snap.lossStreakPauseUntil;
      }
    }
    this.addLog('System initialized. Medallion Club ready.');
  }

  private persistState() {
    StateStore.save({
      balance: this.balance,
      tradeHistory: this.tradeHistory,
      activePositions: this.activePositions,
      lossStreakPauseUntil:
        this.lossStreakPauseUntil > Date.now() ? this.lossStreakPauseUntil : undefined,
    });
  }

  private addLog(msg: string) {
    const time = new Date().toLocaleTimeString();
    this.logs.push(`[${time}] ${msg}`);
    if (this.logs.length > 50) this.logs.shift();
    console.log(`[${time}] ${msg}`);
  }

  private markPosition(pos: Position, currentPrice: number) {
    pos.currentPrice = currentPrice;
    pos.unrealizedPnl =
      pos.side === 'LONG'
        ? (currentPrice - pos.entryPrice) * pos.amount
        : (pos.entryPrice - currentPrice) * pos.amount;
  }

  private buildAiEnrichment(market: ReturnType<typeof analyzeMarketForTrading>): AiEnrichmentContext {
    const recent = this.tradeHistory
      .filter((t) => t.status === 'CLOSED' && typeof t.pnl === 'number')
      .slice(-5)
      .reverse()
      .map((t) => {
        const p = t.pnl as number;
        const outcome: 'win' | 'loss' | 'flat' = p > 0 ? 'win' : p < 0 ? 'loss' : 'flat';
        return { symbol: t.symbol, side: t.side, pnl: p, outcome };
      });
    return {
      recentTrades: recent,
      atr: market.atr,
      atrPercentOfPrice: market.atrPct,
      trendStrengthPercent: market.emaSpreadPct * 100,
    };
  }

  getPerformanceStats() {
    const closed = this.tradeHistory.filter((t) => t.status === 'CLOSED' && typeof t.pnl === 'number');
    const wins = closed.filter((t) => (t.pnl as number) > 0);
    const losses = closed.filter((t) => (t.pnl as number) < 0);
    const n = closed.length;
    const winRate = n > 0 ? wins.length / n : 0;
    const avgProfit = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl as number), 0) / wins.length : 0;
    const avgLoss =
      losses.length > 0 ? losses.reduce((s, t) => s + (t.pnl as number), 0) / losses.length : 0;
    return {
      closedTrades: n,
      wins: wins.length,
      losses: losses.length,
      winRate,
      avgProfit,
      avgLoss,
    };
  }

  async refreshOpenPositionMarks(): Promise<void> {
    for (const pos of this.activePositions) {
      const data = await DataLayer.fetchOHLCV(pos.symbol, '1m', 1);
      if (data.length === 0) continue;
      this.markPosition(pos, data[0].close);
    }
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.addLog('Trading system started.');
    this.runMainLoop();
  }

  stop() {
    this.isRunning = false;
    this.addLog('Trading system stopped.');
  }

  private async runMainLoop() {
    while (this.isRunning) {
      try {
        await this.scanAndTrade();
        await this.monitorPositions();
      } catch (error) {
        this.addLog(`Error in main loop: ${error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
    }
  }

  private async scanAndTrade() {
    this.addLog('Scanning market for opportunities...');

    if (Date.now() < this.lossStreakPauseUntil) {
      const secLeft = Math.ceil((this.lossStreakPauseUntil - Date.now()) / 1000);
      this.addLog(`SKIP scan cause=loss_streak_pause ~${secLeft}s remaining (after 3 consecutive losses)`);
      return;
    }

    const topCoins = await DataLayer.fetchTopCoins(5);

    for (const symbol of topCoins) {
      if (this.activePositions.find((p) => p.symbol === symbol)) continue;

      const elapsed = Date.now() - this.lastTradeOpenedAt;
      if (this.lastTradeOpenedAt > 0 && elapsed < TRADE_COOLDOWN_MS) {
        const secLeft = Math.ceil((TRADE_COOLDOWN_MS - elapsed) / 1000);
        this.addLog(`SKIP ${symbol} cause=cooldown ~${secLeft}s remaining`);
        continue;
      }

      const lastClosed = this.symbolLastClosedAt.get(symbol);
      if (lastClosed !== undefined) {
        const sinceClose = Date.now() - lastClosed;
        if (sinceClose < SYMBOL_REENTRY_COOLDOWN_MS) {
          const secLeft = Math.ceil((SYMBOL_REENTRY_COOLDOWN_MS - sinceClose) / 1000);
          this.addLog(`SKIP ${symbol} cause=no_reentry ~${secLeft}s remaining (post-close)`);
          continue;
        }
      }

      const data = await DataLayer.fetchOHLCV(symbol, '15m', 100);
      if (data.length === 0) continue;

      const market = analyzeMarketForTrading(data);
      if (!market.ok) {
        this.addLog(
          `SKIP ${symbol} cause=${market.reason} atrPct=${(market.atrPct * 100).toFixed(4)} emaSpreadPct=${(market.emaSpreadPct * 100).toFixed(4)}`
        );
        continue;
      }

      const enrichment = this.buildAiEnrichment(market);
      const evaluation = await ScoringEngine.evaluateTradeOpportunity(symbol, data, enrichment);
      const lastPrice = data[data.length - 1].close;

      const aiPart = evaluation.ai
        ? `ai=${evaluation.ai.decision} conf=${evaluation.ai.confidence.toFixed(2)}`
        : 'ai=n/a';
      const skipTag = evaluation.skipCause ? `cause=${evaluation.skipCause} ` : '';

      if (!evaluation.execute || !evaluation.side) {
        const tail = evaluation.ai ? ` ${truncate(evaluation.ai.reasoning, 120)}` : '';
        this.addLog(
          `SKIP ${symbol} ${skipTag}score=${evaluation.finalScore.toFixed(1)} ${aiPart} reason=${evaluation.reason}${tail}`
        );
        continue;
      }

      this.addLog(
        `EVAL ${symbol} score=${evaluation.finalScore.toFixed(1)} ${aiPart} final=EXECUTE reason=${truncate(evaluation.reason, 160)}`
      );
      this.executeTrade(symbol, lastPrice, evaluation.side, data, market);
    }
  }

  private executeTrade(
    symbol: string,
    price: number,
    side: 'LONG' | 'SHORT',
    ohlcv: OHLCV[],
    market: ReturnType<typeof analyzeMarketForTrading>
  ) {
    if (this.activePositions.length >= MAX_OPEN_TRADES) {
      this.addLog(`SKIP ${symbol} ${side} cause=max_positions (${MAX_OPEN_TRADES})`);
      return;
    }

    const usedRisk = this.activePositions.reduce((sum, p) => sum + riskAtStop(p), 0);
    const cap = this.balance * MAX_PORTFOLIO_RISK_FRAC;
    const room = cap - usedRisk;
    if (room <= 0) {
      this.addLog(
        `SKIP ${symbol} ${side} cause=portfolio_risk_cap (${MAX_PORTFOLIO_RISK_FRAC * 100}% of balance)`
      );
      return;
    }

    const targetRisk = this.balance * RISK_PER_TRADE;
    const lowAtr =
      market.atrPct > 0 &&
      market.atrPct < LOW_ATR_HALVE_RISK_PCT;
    const riskScale = lowAtr ? 0.5 : 1;
    const riskDollars = Math.min(targetRisk * riskScale, room);
    if (riskDollars <= 0 || !Number.isFinite(riskDollars)) {
      this.addLog(`SKIP ${symbol} ${side} cause=invalid_risk_budget`);
      return;
    }

    if (lowAtr) {
      this.addLog(
        `RISK ${symbol} low_atr atrPct=${(market.atrPct * 100).toFixed(5)} → half size (risk$=${riskDollars.toFixed(2)})`
      );
    }

    const position = RiskAgent.calculatePosition(this.balance, price, side, ohlcv, riskDollars);
    if (!position) {
      this.addLog(`SKIP ${symbol} ${side} cause=risk_sizing_failed`);
      return;
    }

    const tradeId = randomUUID();
    position.tradeId = tradeId;
    position.symbol = symbol;
    this.activePositions.push(position);

    const trade: TradeLog = {
      id: tradeId,
      symbol,
      side,
      entryPrice: price,
      amount: position.amount,
      status: 'OPEN',
      timestamp: Date.now(),
    };
    this.tradeHistory.push(trade);

    this.persistState();
    this.lastTradeOpenedAt = Date.now();
    this.addLog(`Executed ${side} on ${symbol} at ${price} (tradeId=${tradeId})`);
  }

  private async monitorPositions() {
    await this.refreshOpenPositionMarks();

    for (let i = this.activePositions.length - 1; i >= 0; i--) {
      const pos = this.activePositions[i];
      const currentPrice = pos.currentPrice;

      let shouldClose = false;
      let reason = '';

      if (pos.side === 'LONG') {
        if (currentPrice <= pos.stopLoss) {
          shouldClose = true;
          reason = 'Stop Loss';
        }
        if (currentPrice >= pos.takeProfit) {
          shouldClose = true;
          reason = 'Take Profit';
        }
      } else {
        if (currentPrice >= pos.stopLoss) {
          shouldClose = true;
          reason = 'Stop Loss';
        }
        if (currentPrice <= pos.takeProfit) {
          shouldClose = true;
          reason = 'Take Profit';
        }
      }

      if (shouldClose) {
        this.closePosition(i, currentPrice, reason);
      }
    }
  }

  private closePosition(index: number, price: number, reason: string) {
    const pos = this.activePositions[index];
    if (!pos.tradeId) {
      this.addLog(
        `ERROR closePosition: missing tradeId for symbol=${pos.symbol}; position not removed`
      );
      return;
    }

    const trade = this.tradeHistory.find((t) => t.id === pos.tradeId && t.status === 'OPEN');
    if (!trade) {
      this.addLog(
        `ERROR closePosition: no OPEN trade for tradeId=${pos.tradeId} symbol=${pos.symbol}; position not removed`
      );
      return;
    }

    const pnl =
      pos.side === 'LONG'
        ? (price - pos.entryPrice) * pos.amount
        : (pos.entryPrice - price) * pos.amount;

    this.balance += pnl;
    trade.exitPrice = price;
    trade.pnl = pnl;
    trade.status = 'CLOSED';
    trade.exitTimestamp = Date.now();

    this.addLog(`Closed ${pos.symbol} at ${price} (${reason}). PnL: ${pnl.toFixed(2)}`);

    this.symbolLastClosedAt.set(pos.symbol, Date.now());
    this.activePositions.splice(index, 1);

    const closed = this.tradeHistory.filter(
      (t) => t.status === 'CLOSED' && typeof t.pnl === 'number'
    );
    const last3 = closed.slice(-3);
    if (
      last3.length === 3 &&
      last3.every((t) => (t.pnl as number) < 0) &&
      Date.now() >= this.lossStreakPauseUntil
    ) {
      this.lossStreakPauseUntil = Date.now() + LOSS_STREAK_PAUSE_MS;
      this.addLog(
        'PAUSE new entries 1h (loss_streak_pause) after 3 consecutive losing closes'
      );
    }

    this.persistState();
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      balance: this.balance,
      activePositions: this.activePositions,
      tradeHistory: this.tradeHistory,
      logs: this.logs,
    };
  }
}

export const tradingSystem = new TradingSystem();
