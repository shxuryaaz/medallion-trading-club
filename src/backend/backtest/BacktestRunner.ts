import { DataLayer } from '../DataLayer';
import {
  ScoringEngine,
  RiskAgent,
  RISK_PER_TRADE,
  LOW_ATR_HALVE_RISK_PCT,
  analyzeMarketForTrading,
  type AiEnrichmentContext,
  type Position,
} from '../Engine';

const MAX_OPEN_TRADES = 2;
const MAX_PORTFOLIO_RISK_FRAC = 0.02;
const COOLDOWN_SEC = 20 * 60;
const REENTRY_COOLDOWN_SEC = 30 * 60;
const LOSS_STREAK_PAUSE_SEC = 60 * 60;
const WINDOW = 100;
const DEFAULT_INITIAL = 10000;

export interface BacktestParams {
  symbol: string;
  interval: string;
  days: number;
  useAI: boolean;
  initialBalance?: number;
}

export interface BacktestClosedTrade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  entryTimeSec: number;
  exitTimeSec: number;
}

export interface BacktestResult {
  params: BacktestParams;
  barsUsed: number;
  initialBalance: number;
  finalBalance: number;
  totalPnl: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgProfit: number;
  avgLoss: number;
  maxDrawdown: number;
  logs: string[];
  trades: BacktestClosedTrade[];
}

function riskAtStop(pos: Position): number {
  return Math.abs(pos.entryPrice - pos.stopLoss) * pos.amount;
}

function buildEnrichment(
  closed: BacktestClosedTrade[],
  market: ReturnType<typeof analyzeMarketForTrading>
): AiEnrichmentContext {
  const recent = closed
    .slice(-5)
    .reverse()
    .map((t) => ({
      symbol: t.symbol,
      side: t.side,
      pnl: t.pnl,
      outcome: (t.pnl > 0 ? 'win' : t.pnl < 0 ? 'loss' : 'flat') as 'win' | 'loss' | 'flat',
    }));
  return {
    recentTrades: recent,
    atr: market.atr,
    atrPercentOfPrice: market.atrPct,
    trendStrengthPercent: market.emaSpreadPct * 100,
  };
}

export async function runBacktest(params: BacktestParams): Promise<BacktestResult> {
  const sym = params.symbol.toUpperCase();
  const days = Math.min(30, Math.max(7, Math.floor(params.days)));
  const initialBalance = params.initialBalance ?? DEFAULT_INITIAL;
  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;

  const bars = await DataLayer.fetchOHLCVRange(sym, params.interval, startMs, endMs);

  const logs: string[] = [];
  const trades: BacktestClosedTrade[] = [];
  let balance = initialBalance;
  const positions: Position[] = [];
  let lastOpenTimeSec = 0;
  const symbolLastCloseSec = new Map<string, number>();
  let equityPeak = initialBalance;
  let maxDrawdown = 0;
  let tradeSeq = 0;
  let lossStreakPauseUntilSec = 0;

  const log = (msg: string) => {
    logs.push(msg);
    console.log(msg);
  };

  const pushClose = (
    pos: Position,
    exitPrice: number,
    exitTimeSec: number,
    tag: string
  ) => {
    const pnl =
      pos.side === 'LONG'
        ? (exitPrice - pos.entryPrice) * pos.amount
        : (pos.entryPrice - exitPrice) * pos.amount;
    balance += pnl;
    const rec: BacktestClosedTrade = {
      id: pos.tradeId,
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      pnl,
      entryTimeSec: Math.floor(pos.timestamp / 1000),
      exitTimeSec,
    };
    trades.push(rec);
    symbolLastCloseSec.set(pos.symbol, exitTimeSec);
    log(
      `[BT CLOSE] ${tag} pnl=${pnl.toFixed(2)} ${pos.side} ${pos.symbol} entry=${pos.entryPrice.toFixed(4)} exit=${exitPrice.toFixed(4)}`
    );

    const last3 = trades.slice(-3);
    if (
      last3.length === 3 &&
      last3.every((x) => x.pnl < 0) &&
      exitTimeSec >= lossStreakPauseUntilSec
    ) {
      lossStreakPauseUntilSec = exitTimeSec + LOSS_STREAK_PAUSE_SEC;
      log(`[BT] loss_streak_pause until t=${lossStreakPauseUntilSec} (3 consecutive losses)`);
    }
  };

  if (bars.length < WINDOW + 5) {
    log(`[BT] insufficient bars: ${bars.length} (need ~${WINDOW + 5})`);
    return {
      params,
      barsUsed: bars.length,
      initialBalance,
      finalBalance: balance,
      totalPnl: 0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      avgProfit: 0,
      avgLoss: 0,
      maxDrawdown: 0,
      logs,
      trades: [],
    };
  }

  log(
    `[BT] start symbol=${sym} interval=${params.interval} days=${days} bars=${bars.length} useAI=${params.useAI} balance=${initialBalance}`
  );

  for (let t = WINDOW; t < bars.length; t++) {
    const bar = bars[t];

    for (let i = positions.length - 1; i >= 0; i--) {
      const pos = positions[i];
      let exitPrice: number | null = null;
      let reason = '';

      if (pos.side === 'LONG') {
        if (bar.low <= pos.stopLoss) {
          exitPrice = pos.stopLoss;
          reason = 'SL';
        } else if (bar.high >= pos.takeProfit) {
          exitPrice = pos.takeProfit;
          reason = 'TP';
        }
      } else {
        if (bar.high >= pos.stopLoss) {
          exitPrice = pos.stopLoss;
          reason = 'SL';
        } else if (bar.low <= pos.takeProfit) {
          exitPrice = pos.takeProfit;
          reason = 'TP';
        }
      }

      if (exitPrice != null) {
        pushClose(pos, exitPrice, bar.time, `bar=${t} ${reason}`);
        positions.splice(i, 1);
      }
    }

    let unrealized = 0;
    for (const p of positions) {
      unrealized +=
        p.side === 'LONG'
          ? (bar.close - p.entryPrice) * p.amount
          : (p.entryPrice - bar.close) * p.amount;
    }
    const equity = balance + unrealized;
    equityPeak = Math.max(equityPeak, equity);
    if (equityPeak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (equityPeak - equity) / equityPeak);
    }

    if (positions.some((p) => p.symbol === sym)) {
      continue;
    }
    if (positions.length >= MAX_OPEN_TRADES) {
      continue;
    }

    if (lastOpenTimeSec > 0 && bar.time - lastOpenTimeSec < COOLDOWN_SEC) {
      continue;
    }

    const lastSymClose = symbolLastCloseSec.get(sym);
    if (lastSymClose !== undefined && bar.time - lastSymClose < REENTRY_COOLDOWN_SEC) {
      const secLeft = Math.ceil(REENTRY_COOLDOWN_SEC - (bar.time - lastSymClose));
      log(`[BT SKIP] bar=${t} cause=no_reentry ~${secLeft}s after close on ${sym}`);
      continue;
    }

    if (bar.time < lossStreakPauseUntilSec) {
      const secLeft = lossStreakPauseUntilSec - bar.time;
      log(`[BT SKIP] bar=${t} cause=loss_streak_pause ~${secLeft}s remaining`);
      continue;
    }

    const window = bars.slice(Math.max(0, t - (WINDOW - 1)), t + 1);
    const market = analyzeMarketForTrading(window);
    if (!market.ok) {
      const filter =
        market.reason === 'low_volatility'
          ? 'volatility_filter'
          : market.reason === 'low_regime'
            ? 'low_regime'
            : 'sideways_filter';
      log(
        `[BT SKIP] bar=${t} cause=${filter} (${market.reason}) atrPct=${(market.atrPct * 100).toFixed(5)} emaSpreadPct=${(market.emaSpreadPct * 100).toFixed(5)}`
      );
      continue;
    }

    const enrichment = buildEnrichment(trades, market);

    const evaluation = params.useAI
      ? await ScoringEngine.evaluateTradeOpportunity(sym, window, enrichment)
      : ScoringEngine.evaluateNumericOnly(window);

    if (!evaluation.execute || !evaluation.side) {
      if (evaluation.skipCause === 'score_neutral') {
        log(
          `[BT SKIP] bar=${t} cause=score_neutral score=${evaluation.finalScore.toFixed(1)} (neutral 35–65; strong need >72 long or <28 short)`
        );
      } else {
        log(
          `[BT SKIP] bar=${t} cause=${evaluation.skipCause ?? 'unknown'} score=${evaluation.finalScore.toFixed(1)}`
        );
      }
      continue;
    }

    const usedRisk = positions.reduce((sum, p) => sum + riskAtStop(p), 0);
    const cap = balance * MAX_PORTFOLIO_RISK_FRAC;
    const room = cap - usedRisk;
    if (room <= 0) {
      log(`[BT SKIP] bar=${t} cause=portfolio_risk_cap`);
      continue;
    }

    const lowAtr = market.atrPct > 0 && market.atrPct < LOW_ATR_HALVE_RISK_PCT;
    const riskScale = lowAtr ? 0.5 : 1;
    const riskDollars = Math.min(balance * RISK_PER_TRADE * riskScale, room);
    if (riskDollars <= 0 || !Number.isFinite(riskDollars)) {
      continue;
    }

    const position = RiskAgent.calculatePosition(
      balance,
      bar.close,
      evaluation.side,
      window,
      riskDollars
    );
    if (!position) {
      log(`[BT SKIP] bar=${t} cause=risk_sizing_failed`);
      continue;
    }

    tradeSeq++;
    position.tradeId = `bt-${tradeSeq}`;
    position.symbol = sym;
    position.timestamp = bar.time * 1000;
    positions.push(position);
    lastOpenTimeSec = bar.time;

    log(
      `[BT OPEN] bar=${t} t=${bar.time} ${evaluation.side} close=${bar.close.toFixed(4)} score=${evaluation.finalScore.toFixed(1)} risk$=${riskDollars.toFixed(2)}`
    );
  }

  const lastBar = bars[bars.length - 1];
  const remaining = [...positions];
  positions.length = 0;
  for (const pos of remaining) {
    log(`[BT] force-close open leg at last close ${lastBar.close.toFixed(4)}`);
    pushClose(pos, lastBar.close, lastBar.time, 'eod');
  }

  const winList = trades.filter((x) => x.pnl > 0);
  const lossList = trades.filter((x) => x.pnl < 0);
  const n = trades.length;
  const winRate = n > 0 ? winList.length / n : 0;
  const avgProfit = winList.length > 0 ? winList.reduce((s, x) => s + x.pnl, 0) / winList.length : 0;
  const avgLoss =
    lossList.length > 0 ? lossList.reduce((s, x) => s + x.pnl, 0) / lossList.length : 0;

  log(
    `[BT] summary trades=${n} winRate=${(winRate * 100).toFixed(1)}% totalPnl=${(balance - initialBalance).toFixed(2)} maxDD=${(maxDrawdown * 100).toFixed(2)}% finalBal=${balance.toFixed(2)}`
  );

  return {
    params,
    barsUsed: bars.length,
    initialBalance,
    finalBalance: balance,
    totalPnl: balance - initialBalance,
    totalTrades: n,
    wins: winList.length,
    losses: lossList.length,
    winRate,
    avgProfit,
    avgLoss,
    maxDrawdown,
    logs,
    trades,
  };
}
