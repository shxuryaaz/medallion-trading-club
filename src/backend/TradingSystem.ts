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
import { StateStore, type EngineStateSnapshot } from './persistence/StateStore';
import { PortfolioManager } from './portfolio/PortfolioManager';
import { closedTradeNetAmount, entryExitFees, minTpDistanceForFees } from './fees';
import { exchange } from './exchange/BinanceClient';
import {
  DAILY_LOSS_LIMIT_FRAC,
  MAX_ENTRY_LATENCY_MS,
  MAX_ENTRY_SLIPPAGE_BPS,
  appendTradeTelemetry,
  entrySlippageBps,
  exitSlippageBps,
} from './TradeLog';

export type { TradeLog } from './types';

const ENGINE_ID = 'swing';

const MAX_OPEN_TRADES = 2;
/** Global cooldown after any new open. */
const TRADE_COOLDOWN_MS = 5 * 60 * 1000;
/** After closing a symbol, block re-entry on that symbol. */
const SYMBOL_REENTRY_COOLDOWN_MS = 30 * 60 * 1000;
/** After 3 consecutive closed losses, pause new entries. */
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
    initialStopDist: typeof p.initialStopDist === 'number'
      ? p.initialStopDist
      : Math.abs(entry - (typeof p.stopLoss === 'number' ? p.stopLoss : entry)),
    engineId: ENGINE_ID,
  };
}

export class TradingSystem {
  private readonly portfolio: PortfolioManager;
  private activePositions: Position[] = [];
  private tradeHistory: TradeLog[] = [];
  private isRunning: boolean = false;
  private logs: string[] = [];
  private lastTradeOpenedAt = 0;
  private symbolLastClosedAt = new Map<string, number>();
  private lossStreakPauseUntil = 0;
  private readonly startingBalance: number;

  constructor(portfolio: PortfolioManager, initialSnapshot?: EngineStateSnapshot | null) {
    this.portfolio = portfolio;
    this.startingBalance = portfolio.getBalance();

    const snap = initialSnapshot ?? null;
    if (snap) {
      this.tradeHistory = snap.tradeHistory;
      this.activePositions = snap.activePositions
        .map((p) => normalizeLoadedPosition(p as Partial<Position> & Record<string, unknown>))
        .filter((p): p is Position => p !== null);

      // Reconcile tradeIds between positions and trade history
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

      // Drop positions that have no matching OPEN trade
      const before = this.activePositions.length;
      this.activePositions = this.activePositions.filter((pos) => {
        const ok =
          Boolean(pos.tradeId) &&
          this.tradeHistory.some((t) => t.id === pos.tradeId && t.status === 'OPEN');
        if (!ok) {
          console.error('[TradingSystem] dropped orphan position:', pos.symbol, pos.tradeId);
        }
        return ok;
      });
      if (this.activePositions.length < before) {
        console.error('[TradingSystem] removed', before - this.activePositions.length, 'orphan(s) on load');
      }

      // Re-register surviving positions in the shared portfolio risk registry
      for (const pos of this.activePositions) {
        this.portfolio.registerTrade(ENGINE_ID, pos.tradeId, pos.symbol, riskAtStop(pos));
      }

      if (
        typeof snap.lossStreakPauseUntil === 'number' &&
        Number.isFinite(snap.lossStreakPauseUntil) &&
        snap.lossStreakPauseUntil > Date.now()
      ) {
        this.lossStreakPauseUntil = snap.lossStreakPauseUntil;
      }
    }
    this.addLog('Swing engine initialized. Medallion Club ready.');
  }

  private persistState() {
    StateStore.scheduleSave();
  }

  /** Full engine slice for unified `state.json` persistence. */
  getPersistSnapshot(): EngineStateSnapshot {
    return {
      tradeHistory: this.tradeHistory,
      activePositions: this.activePositions,
      lossStreakPauseUntil:
        this.lossStreakPauseUntil > Date.now() ? this.lossStreakPauseUntil : undefined,
    };
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

    // Trailing stop logic (unchanged)
    const stopDist = pos.initialStopDist ?? Math.abs(pos.entryPrice - pos.stopLoss);
    const profitDist =
      pos.side === 'LONG'
        ? currentPrice - pos.entryPrice
        : pos.entryPrice - currentPrice;

    if (profitDist >= 1.5 * stopDist) {
      if (pos.side === 'LONG') {
        pos.stopLoss = Math.max(pos.stopLoss, pos.entryPrice);
      } else {
        pos.stopLoss = Math.min(pos.stopLoss, pos.entryPrice);
      }
    }
    if (profitDist >= 2 * stopDist) {
      const trailingStop =
        pos.side === 'LONG' ? currentPrice - stopDist : currentPrice + stopDist;
      if (pos.side === 'LONG') {
        pos.stopLoss = Math.max(pos.stopLoss, trailingStop);
      } else {
        pos.stopLoss = Math.min(pos.stopLoss, trailingStop);
      }
    }
  }

  private buildAiEnrichment(market: ReturnType<typeof analyzeMarketForTrading>): AiEnrichmentContext {
    const recent = this.tradeHistory
      .filter((t) => closedTradeNetAmount(t) != null)
      .slice(-5)
      .reverse()
      .map((t) => {
        const p = closedTradeNetAmount(t) as number;
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
    const closed = this.tradeHistory.filter((t) => closedTradeNetAmount(t) != null);
    const wins = closed.filter((t) => (closedTradeNetAmount(t) as number) > 0);
    const losses = closed.filter((t) => (closedTradeNetAmount(t) as number) < 0);
    const n = closed.length;
    const winRate = n > 0 ? wins.length / n : 0;
    const net = (t: TradeLog) => closedTradeNetAmount(t) as number;
    const avgProfit = wins.length > 0 ? wins.reduce((s, t) => s + net(t), 0) / wins.length : 0;
    const avgLoss =
      losses.length > 0 ? losses.reduce((s, t) => s + net(t), 0) / losses.length : 0;
    const sumWins = wins.reduce((s, t) => s + net(t), 0);
    const sumLosses = losses.reduce((s, t) => s + net(t), 0);
    const profitFactor =
      losses.length === 0 ? (sumWins > 0 ? null : 0) : sumWins / Math.abs(sumLosses);
    const avgWinToAvgLoss =
      wins.length > 0 && losses.length > 0 && avgLoss !== 0
        ? avgProfit / Math.abs(avgLoss)
        : null;
    const totalNetPnl = closed.reduce((s, t) => s + net(t), 0);
    return {
      closedTrades: n,
      wins: wins.length,
      losses: losses.length,
      winRate,
      avgProfit,
      avgLoss,
      profitFactor,
      avgWinToAvgLoss,
      totalNetPnl,
    };
  }

  async refreshOpenPositionMarks(): Promise<void> {
    for (const pos of this.activePositions) {
      const close = await DataLayer.getLast1mClose(pos.symbol);
      if (close == null) continue;
      this.markPosition(pos, close);
    }
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.addLog('Swing engine started.');
    this.runMainLoop();
  }

  stop() {
    this.isRunning = false;
    this.addLog('Swing engine stopped.');
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
      this.addLog(`SKIP scan cause=loss_streak_pause ~${secLeft}s remaining`);
      return;
    }

    const topCoins = DataLayer.getStaticScalpWatchlist(5);

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

      await new Promise((r) => setTimeout(r, 1000));
      const data = await DataLayer.getSwingScan15m(symbol, 100);
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
      await this.executeTrade(symbol, lastPrice, evaluation.side, data, market);
    }
  }

  private async executeTrade(
    symbol: string,
    price: number,
    side: 'LONG' | 'SHORT',
    ohlcv: OHLCV[],
    market: ReturnType<typeof analyzeMarketForTrading>
  ): Promise<void> {
    if (this.startingBalance > 0) {
      const dailyPnl = this.portfolio.getBalance() - this.startingBalance;
      if (dailyPnl <= -this.startingBalance * DAILY_LOSS_LIMIT_FRAC) {
        this.addLog(`SKIP ${symbol} ${side} cause=daily_loss_limit pnl=${dailyPnl.toFixed(2)}`);
        return;
      }
    }

    const signalTimestamp = Date.now();
    // Per-engine position cap (swing only)
    if (this.activePositions.length >= MAX_OPEN_TRADES) {
      this.addLog(`SKIP ${symbol} ${side} cause=max_positions (${MAX_OPEN_TRADES})`);
      return;
    }

    // Compute intended risk; portfolio gate enforces cross-engine limits
    const balance     = this.portfolio.getBalance();
    const targetRisk  = balance * RISK_PER_TRADE;
    const lowAtr      = market.atrPct > 0 && market.atrPct < LOW_ATR_HALVE_RISK_PCT;
    const riskScale   = lowAtr ? 0.5 : 1;
    const requestedRisk = targetRisk * riskScale;

    if (lowAtr) {
      this.addLog(
        `RISK ${symbol} low_atr atrPct=${(market.atrPct * 100).toFixed(5)} → half size`
      );
    }

    // Portfolio gate: checks symbol risk cap + global risk cap
    const allocation = this.portfolio.requestCapital(ENGINE_ID, symbol, requestedRisk);
    if (!allocation.approved) {
      this.addLog(`SKIP ${symbol} ${side} cause=${allocation.reason}`);
      return;
    }

    const riskDollars = allocation.riskAllocated;
    if (riskDollars <= 0 || !Number.isFinite(riskDollars)) {
      this.addLog(`SKIP ${symbol} ${side} cause=invalid_risk_budget`);
      return;
    }

    const position = RiskAgent.calculatePosition(balance, price, side, ohlcv, riskDollars);
    if (!position) {
      this.addLog(`SKIP ${symbol} ${side} cause=risk_sizing_failed`);
      return;
    }

    const tpDist = Math.abs(position.takeProfit - price);
    const minEdge = minTpDistanceForFees(price);
    if (tpDist < minEdge) {
      this.addLog(
        `SKIP ${symbol} ${side} cause=fee_min_edge(tpDist=${tpDist.toFixed(6)} need>=${minEdge.toFixed(6)})`
      );
      return;
    }

    const order = await exchange.placeMarketOrder(symbol, side === 'LONG' ? 'BUY' : 'SELL', position.amount);
    if (!order) {
      this.addLog(`SKIP ${symbol} ${side} cause=order_failed`);
      return;
    }

    const latencyMs = Date.now() - signalTimestamp;
    const slippageBps = entrySlippageBps(side, price, order.avgPrice);
    const guardRejected = latencyMs > MAX_ENTRY_LATENCY_MS || slippageBps > MAX_ENTRY_SLIPPAGE_BPS;
    if (guardRejected) {
      const cause = latencyMs > MAX_ENTRY_LATENCY_MS
        ? `latency(${latencyMs}ms)`
        : `entry_slippage(${slippageBps.toFixed(2)}bps)`;
      const flattened = await exchange.closePosition(symbol, side, order.executedQty);
      this.addLog(
        `SKIP ${symbol} ${side} cause=${cause}; ` +
        `entry_order=${order.orderId} flatten=${flattened ? 'ok' : 'failed'}`
      );
      if (flattened) return;
    }

    const tradeId = randomUUID();
    const fillOffset = order.avgPrice - price;
    position.tradeId  = tradeId;
    position.symbol   = symbol;
    position.engineId = ENGINE_ID;
    position.exchangeOrderId = order.orderId;
    position.entryPrice = order.avgPrice;
    position.currentPrice = order.avgPrice;
    position.amount = order.executedQty;
    position.stopLoss += fillOffset;
    position.takeProfit += fillOffset;
    position.initialStopDist = Math.abs(position.entryPrice - position.stopLoss);

    this.activePositions.push(position);

    const trade: TradeLog = {
      id: tradeId,
      signalPrice: price,
      signalTimestamp,
      fillPrice: order.avgPrice,
      entrySlippageBps: slippageBps,
      latencyMs,
      initialRiskUsd: riskAtStop(position),
      symbol,
      side,
      entryPrice: order.avgPrice,
      amount: order.executedQty,
      status: 'OPEN',
      timestamp: Date.now(),
      source: 'swing',
    };
    this.tradeHistory.push(trade);

    // Register risk with portfolio — synchronous, immediately after push
    this.portfolio.registerTrade(ENGINE_ID, tradeId, symbol, riskAtStop(position));

    this.persistState();
    this.lastTradeOpenedAt = Date.now();
    const guardNote = guardRejected ? ' guard_rejected_flatten_failed=true' : '';
    this.addLog(`OPEN ${side} ${symbol} @ ${order.avgPrice} (signal=${price} slip=${slippageBps.toFixed(2)}bps tradeId=${tradeId})${guardNote}`);
  }

  private async monitorPositions() {
    await this.refreshOpenPositionMarks();

    for (let i = this.activePositions.length - 1; i >= 0; i--) {
      const pos = this.activePositions[i];
      const currentPrice = pos.currentPrice;

      let shouldClose = false;
      let reason = '';

      if (pos.side === 'LONG') {
        if (currentPrice <= pos.stopLoss)  { shouldClose = true; reason = 'Stop Loss'; }
        if (currentPrice >= pos.takeProfit) { shouldClose = true; reason = 'Take Profit'; }
      } else {
        if (currentPrice >= pos.stopLoss)  { shouldClose = true; reason = 'Stop Loss'; }
        if (currentPrice <= pos.takeProfit) { shouldClose = true; reason = 'Take Profit'; }
      }

      if (shouldClose) {
        await this.closePosition(i, currentPrice, reason);
      }
    }
  }

  private async closePosition(index: number, price: number, reason: string) {
    const pos = this.activePositions[index];
    if (!pos.tradeId) {
      this.addLog(`ERROR closePosition: missing tradeId for symbol=${pos.symbol}`);
      return;
    }

    const trade = this.tradeHistory.find((t) => t.id === pos.tradeId && t.status === 'OPEN');
    if (!trade) {
      this.addLog(`ERROR closePosition: no OPEN trade for tradeId=${pos.tradeId}`);
      return;
    }

    // Attempt live close on exchange; use actual fill price if available
    let closePrice = price;
    const result = await exchange.closePosition(pos.symbol, pos.side, pos.amount);
    if (!result) {
      this.addLog(`ERROR: close failed ${pos.symbol} tradeId=${pos.tradeId}; position kept open`);
      return;
    }
    if (result.avgPrice > 0) closePrice = result.avgPrice;

    const grossPnl =
      pos.side === 'LONG'
        ? (closePrice - pos.entryPrice) * pos.amount
        : (pos.entryPrice - closePrice) * pos.amount;

    const { entryFee, exitFee } = entryExitFees(pos.entryPrice, closePrice, pos.amount);
    const netPnl = grossPnl - entryFee - exitFee;
    const initialRiskUsd = trade.initialRiskUsd ?? riskAtStop(pos);
    const realizedR = initialRiskUsd > 0 ? netPnl / initialRiskUsd : 0;
    const plannedExit =
      reason === 'Take Profit' ? pos.takeProfit :
      reason === 'Stop Loss' ? pos.stopLoss :
      price;
    const exitSlip = exitSlippageBps(pos.side, plannedExit, closePrice);

    // Portfolio: credit net PnL + remove from risk registry
    this.portfolio.closeTrade(pos.tradeId, netPnl);

    trade.exitPrice     = closePrice;
    trade.grossPnl      = grossPnl;
    trade.entryFee      = entryFee;
    trade.exitFee       = exitFee;
    trade.netPnl        = netPnl;
    trade.pnl           = netPnl;
    trade.exitSlippageBps = exitSlip;
    trade.R             = realizedR;
    trade.status        = 'CLOSED';
    trade.exitTimestamp = Date.now();

    appendTradeTelemetry({
      tradeId: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      signalPrice: trade.signalPrice ?? trade.entryPrice,
      fillPrice: trade.fillPrice ?? trade.entryPrice,
      entrySlippageBps: trade.entrySlippageBps ?? 0,
      exitSlippageBps: exitSlip,
      feesUsd: entryFee + exitFee,
      netPnlUsd: netPnl,
      R: realizedR,
      latencyMs: trade.latencyMs ?? 0,
    }).catch((err) => this.addLog(`ERROR telemetry append failed: ${(err as Error).message}`));

    this.addLog(
      `CLOSE ${pos.symbol} @ ${closePrice} (${reason}). Net ${netPnl.toFixed(2)} (gross ${grossPnl.toFixed(2)} fees ${(entryFee + exitFee).toFixed(2)})`
    );

    this.symbolLastClosedAt.set(pos.symbol, Date.now());
    this.activePositions.splice(index, 1);

    // Loss streak check (swing-specific — 3 consecutive losses)
    const closed = this.tradeHistory.filter((t) => closedTradeNetAmount(t) != null);
    const last3 = closed.slice(-3);
    if (
      last3.length === 3 &&
      last3.every((t) => (closedTradeNetAmount(t) as number) < 0) &&
      Date.now() >= this.lossStreakPauseUntil
    ) {
      this.lossStreakPauseUntil = Date.now() + LOSS_STREAK_PAUSE_MS;
      this.addLog('PAUSE new entries 1h (loss_streak) after 3 consecutive losses');
    }

    this.persistState();
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      balance: this.portfolio.getBalance(),
      activePositions: this.activePositions,
      tradeHistory: this.tradeHistory,
      logs: this.logs,
    };
  }
}
