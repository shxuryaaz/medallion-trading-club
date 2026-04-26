import { randomUUID } from 'crypto';
import { DataLayer } from '../DataLayer';
import type { OHLCV } from '../DataLayer';
import type { Position } from '../Engine';
import { computeATR } from '../Engine';
import type { TradeLog } from '../types';
import { PortfolioManager } from '../portfolio/PortfolioManager';
import { WebSocketManager } from '../data/WebSocketManager';
import { StateStore, type EngineStateSnapshot } from '../persistence/StateStore';
import { closedTradeNetAmount, entryExitFees, feeOnNotional, minTpDistanceForFees } from '../fees';
import { DEFAULT_WATCHLIST_PANEL_SYMBOLS } from '../../constants/watchlistPanel.ts';
import { exchange } from '../exchange/BinanceClient';
import {
  DAILY_LOSS_LIMIT_FRAC,
  MAX_ENTRY_LATENCY_MS,
  MAX_ENTRY_SLIPPAGE_BPS,
  appendTradeTelemetry,
  entrySlippageBps,
  exitSlippageBps,
} from '../TradeLog';

// ── Indicator helpers (inlined — no dependency on swing engine math) ──────────

function computeEMA(prices: number[], period: number): number {
  if (prices.length === 0) return 0;
  const len = Math.min(prices.length, period);
  // Seed with simple average of first `period` values (or all if fewer)
  let ema = prices.slice(0, len).reduce((a, b) => a + b, 0) / len;
  const k = 2 / (period + 1);
  for (let i = len; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

/** Population stdev of `values` (returns 0 if length < 2). */
function stdevPopulation(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  let s = 0;
  for (const v of values) {
    const d = v - mean;
    s += d * d;
  }
  return Math.sqrt(s / n);
}

/**
 * Simple 1-tick returns r[i] = (p[i]-p[i-1])/p[i-1].
 * `shortN` / `longN` = number of returns (need prices.length >= longN + 1).
 */
function tickReturnVolatility(
  prices: number[],
  shortN: number,
  longN: number
): { shortVol: number; longVol: number } | null {
  if (prices.length < longN + 1) return null;
  const shortSlice = prices.slice(-(shortN + 1));
  const longSlice = prices.slice(-(longN + 1));
  const returnsShort: number[] = [];
  for (let i = 1; i < shortSlice.length; i++) {
    const prev = shortSlice[i - 1];
    if (prev === 0) continue;
    returnsShort.push((shortSlice[i] - prev) / prev);
  }
  const returnsLong: number[] = [];
  for (let i = 1; i < longSlice.length; i++) {
    const prev = longSlice[i - 1];
    if (prev === 0) continue;
    returnsLong.push((longSlice[i] - prev) / prev);
  }
  if (returnsShort.length < 8 || returnsLong.length < 20) return null;
  return { shortVol: stdevPopulation(returnsShort), longVol: stdevPopulation(returnsLong) };
}

function tickVolatilityGate(prices: number[]): { ok: true } | { ok: false; reason: string } {
  const v = tickReturnVolatility(prices, VOL_SHORT_RETURNS, VOL_LONG_RETURNS);
  if (v == null) return { ok: false, reason: 'vol_insufficient_ticks' };
  if (v.shortVol < MIN_TICK_VOL) {
    return { ok: false, reason: `vol_low(short=${v.shortVol.toExponential(2)})` };
  }
  if (v.shortVol > MAX_TICK_VOL) {
    return { ok: false, reason: `vol_extreme(short=${v.shortVol.toExponential(2)})` };
  }
  const longFloor = Math.max(v.longVol, VOL_LONG_VOL_FLOOR);
  if (v.shortVol / longFloor > VOL_SPIKE_RATIO) {
    return { ok: false, reason: `vol_spike(ratio=${(v.shortVol / longFloor).toFixed(2)})` };
  }
  return { ok: true };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Last K simple returns (needs prices.length >= K + 1). */
function lastKReturns(prices: number[], k: number): number[] {
  const out: number[] = [];
  const start = prices.length - k;
  if (start < 1) return out;
  for (let i = start; i < prices.length; i++) {
    const prev = prices[i - 1];
    if (prev === 0) continue;
    out.push((prices[i] - prev) / prev);
  }
  return out;
}

function tickNoiseGate(
  prices: number[],
  symbol?: string
): { ok: true } | { ok: false; reason: string } {
  if (prices.length < NOISE_K + 1) return { ok: false, reason: 'noise_insufficient' };
  const returns = lastKReturns(prices, NOISE_K);
  if (returns.length < NOISE_K * 0.85) return { ok: false, reason: 'noise_insufficient' };

  let flips = 0;
  let signedSum = 0;
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i];
    if (Math.abs(r) > MICRO_NOISE_FLOOR) signedSum += Math.sign(r);
    if (i > 0) {
      const r0 = returns[i - 1];
      const r1 = returns[i];
      if (Math.abs(r0) <= MICRO_NOISE_FLOOR || Math.abs(r1) <= MICRO_NOISE_FLOOR) continue;
      if (Math.sign(r0) !== Math.sign(r1)) flips++;
    }
  }
  const consistency = Math.abs(signedSum) / returns.length;
  if (flips > FLIP_MAX) return { ok: false, reason: `noise_chop(flips=${flips})` };
  if (consistency < CONSISTENCY_MIN) {
    if (symbol) {
      console.log(`[SCALP][ALMOST] ${symbol} failed=noise consistency=${consistency.toFixed(2)}`);
    }
    return { ok: false, reason: `noise_chop(consistency=${consistency.toFixed(2)})` };
  }
  return { ok: true };
}

function entryQualityScore(params: {
  accelRatio: number;
  volShort: number;
  tickSpread: number;
  htfSpreadPct: number;
  last: number;
  ema21: number;
}): number {
  const ratioCap = Math.min(params.accelRatio, 2);
  const momPts = clamp01((ratioCap - 1) / 1) * 25;

  const mid = (MIN_TICK_VOL + MAX_TICK_VOL) / 2;
  const half = (MAX_TICK_VOL - MIN_TICK_VOL) / 2;
  const volPts = (1 - Math.min(Math.abs(params.volShort - mid), half) / half) * 25;

  const spreadBlend = params.tickSpread + params.htfSpreadPct;
  const trendPts = clamp01(spreadBlend / 0.0012) * 25;

  const d = Math.abs(params.last - params.ema21) / Math.max(params.ema21, 1e-12);
  const dIdeal = MAX_STRETCH_FROM_EMA * 0.5;
  const halfSpan = MAX_STRETCH_FROM_EMA * 0.5;
  const emaPts = (1 - Math.min(Math.abs(d - dIdeal), halfSpan) / halfSpan) * 25;

  return Math.round(Math.min(100, momPts + volPts + trendPts + emaPts));
}

/** Last close of each completed 5×1m block (ohlcv oldest → newest). */
function resample5mCloses(ohlcv: OHLCV[]): number[] {
  const out: number[] = [];
  for (let i = 4; i < ohlcv.length; i += 5) {
    out.push(ohlcv[i].close);
  }
  return out;
}

function htfTrendFlags(
  ohlcv1m: OHLCV[]
): { allowsLong: boolean; allowsShort: boolean; htfSpreadPct: number } | null {
  const c5 = resample5mCloses(ohlcv1m);
  if (c5.length < HTF_MIN_5M_BARS) return null;
  const ema9 = computeEMA(c5, 9);
  const ema21 = computeEMA(c5, 21);
  const denom = Math.max(Math.abs(ema21), 1e-12);
  return {
    allowsLong: ema9 > ema21,
    allowsShort: ema9 < ema21,
    htfSpreadPct: Math.abs(ema9 - ema21) / denom,
  };
}

// ── Strategy constants ────────────────────────────────────────────────────────

const ENGINE_ID            = 'scalp';
// Symbols excluded from scalping: low-price assets with precision/fee issues and no observed scalp edge
const SCALP_EXCLUDED_SYMBOLS = new Set(['PEPEUSDT', 'DOGEUSDT']);
const LOOP_INTERVAL_MS     = 4_000;           // scan every 4 seconds
const TRADE_COOLDOWN_MS    = 60_000;          // 1 min global cooldown between scalp opens
const SYMBOL_POST_CLOSE_COOLDOWN_MS = 75_000; // per-symbol after close (30–120s band)
const LOSS_STREAK_PAUSE_MS = 30 * 60_000;     // 30 min pause after 5 consecutive losses
const LOSS_STREAK_COUNT    = 5;               // losses in a row before pause
const MAX_POSITIONS        = 3;               // max concurrent scalp trades
const SCALP_LEVERAGE       = 10;              // leverage set on exchange before first trade per symbol
const NOTIONAL_FRAC        = 0.10;            // fraction of balance used as MARGIN per trade
//   effective notional = balance × NOTIONAL_FRAC × SCALP_LEVERAGE
//   $10 account → $1 margin × 10x = $10 notional (workable for ETH/XRP)
//   $5k account → $500 margin × 10x = $5000 notional
const MIN_EMA_SPREAD_PCT   = 0.00025;         // EMA9/21 must be at least ~0.025% apart
const MAX_STRETCH_FROM_EMA = 0.0025;          // entryQualityScore distance vs ema21 (soft)
const MIN_BUFFER_TICKS       = 130;             // covers vol long window + EMA21 (when HTF cache seeded)
const MIN_BUFFER_TICKS_COLD = 60;              // WS-only warmup when 1m cache missing / thinner context

// Tick volatility (simple return stdev)
const VOL_SHORT_RETURNS    = 40;
const VOL_LONG_RETURNS     = 120;
const MIN_TICK_VOL         = 8e-6;            // below = dead tape
const MAX_TICK_VOL         = 0.0022;          // above = too wild
const VOL_SPIKE_RATIO      = 3.0;
const VOL_LONG_VOL_FLOOR   = 1e-7;            // avoid div-by-zero in spike ratio

// Cached 1m bars for HTF (TTL enforced in DataLayer.getScalpContext1m — no REST in hot path beyond cache refresh)
const OHLCV_FETCH_LIMIT    = 130;
const HTF_MIN_5M_BARS      = 22;              // ≥21 closes for EMA21 seed + value

// ATR-based SL / TP (exit-only tuning — entry logic unchanged)
const ATR_PERIOD_SCALP     = 7;               // shorter window matches seconds-scale entry trigger
const ATR_STOP_MULT        = 1.0;             // tighter SL to reduce avg loss size
const SL_MIN_PCT           = 0.0025;          // 0.25% floor on stop distance
const SL_MAX_PCT           = 0.005;           // 0.50% cap
const SL_TIGHTEN_MULT      = 0.9;             // slightly tighter stop vs raw ATR clamp
// With 0.2% round-trip fees and 0.25% SL, net RR = (TP−0.2%)/(SL+0.2%).
// TP_MIN_R_MULT=4.5 → TP ~1.125%, net RR ≈ 2.06:1, break-even win rate 33%.
const TP_RR                = 3.5;
const TP_MIN_R_MULT        = 4.5;
/** Min net TP move (after fees) per unit vs SL distance — filter only; does not change TP/ATR. */
const MIN_NET_R_MULTIPLE   = 1.2;

// Impulse scalping — last-N tick returns
const IMPULSE_RETURN_COUNT  = 6;              // 5–8 tick returns
const IMPULSE_MIN           = 0.00028;        // min sum(|r|) over N (weak impulse below this)
const IMPULSE_DIRECTION_FRAC = 0.7;           // ≥70% of ticks same sign
/** Minimum short-window volatility (same scale as tickReturnVolatility shortVol). */
const VOL_MIN               = MIN_TICK_VOL;

// Entry quality — noise, score, sizing
const NOISE_K              = 28;
const MICRO_NOISE_FLOOR    = 5e-7;
const FLIP_MAX             = 14;
const CONSISTENCY_MIN      = 0.08;
const ENTRY_SCORE_MIN      = 70;            // raised: empirical data shows sub-70 entries losing at high rate
const SCORE_SIZE_MIN       = 1.0;             // flat 10% regardless of score (size managed by entry gate)

interface ScalpMarketContext {
  ohlcv: OHLCV[];
  allowsLong: boolean;
  allowsShort: boolean;
  htfSpreadPct: number;
}

type EntryEval =
  | { ok: false; reason: string }
  | {
      ok: true;
      side: 'LONG' | 'SHORT';
      score: number;
      momentumStrength: number;
      volShort: number;
      reason: string;
    };

function scoreToNotionalScale(score: number): number {
  const t = clamp01((score - ENTRY_SCORE_MIN) / (100 - ENTRY_SCORE_MIN));
  return SCORE_SIZE_MIN + t * (1 - SCORE_SIZE_MIN);
}

function riskAtStop(pos: Position): number {
  return Math.abs(pos.entryPrice - pos.stopLoss) * pos.amount;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Last evaluated scalp signal per symbol (memory only; used by /ws/watchlist). */
export type ScalpLastSignal = {
  decision: 'BUY' | 'SELL' | 'SKIP';
  score: number;
  reason: string;
  timestamp: number;
};

function shortenScalpReason(reason: string, maxLen = 40): string {
  const base = reason.split('(')[0]?.trim() ?? reason;
  return base.replace(/\s+/g, '_').replace(/%/g, 'pct').slice(0, maxLen);
}

// ── ScalpingEngine ────────────────────────────────────────────────────────────

export class ScalpingEngine {
  private readonly portfolio: PortfolioManager;
  private readonly ws: WebSocketManager;
  private readonly startingBalance: number;

  private isRunning = false;
  private activePositions: Position[] = [];
  private tradeHistory: TradeLog[] = [];
  private logs: string[] = [];

  private lastTradeOpenedAt = 0;
  private symbolLastClosedAt = new Map<string, number>();
  private lossStreakPauseUntil = 0;
  private watchlist: string[] = [];
  /** 1m OHLCV per symbol for HTF trend + ATR (TTL refresh). */
  private ohlcvCache = new Map<string, { bars: OHLCV[]; fetchedAt: number }>();

  private lastSignalBySymbol = new Map<string, ScalpLastSignal>();

  /** Funding rate cache: refreshed every 30 min per symbol. */
  private fundingRateCache = new Map<string, { rate: number; fetchedAt: number }>();
  private static readonly FUNDING_CACHE_TTL_MS = 30 * 60_000;
  private static readonly FUNDING_EXTREME      = 0.0003; // 0.03%/8h → avoid crowded side

  private minBufferTicksFor(symbol: string): number {
    const ent = this.ohlcvCache.get(symbol);
    if (ent && ent.bars.length >= HTF_MIN_5M_BARS * 5) return MIN_BUFFER_TICKS;
    return MIN_BUFFER_TICKS_COLD;
  }

  constructor(
    portfolio: PortfolioManager,
    ws: WebSocketManager,
    initialSnapshot?: EngineStateSnapshot | null
  ) {
    this.portfolio = portfolio;
    this.ws        = ws;
    this.startingBalance = portfolio.getBalance();

    const snap = initialSnapshot ?? null;
    if (snap) {
      this.activePositions    = snap.activePositions ?? [];
      this.tradeHistory       = snap.tradeHistory ?? [];
      this.lossStreakPauseUntil = snap.lossStreakPauseUntil ?? 0;

      // Re-register surviving open positions with the portfolio risk registry
      for (const pos of this.activePositions) {
        this.portfolio.registerTrade(ENGINE_ID, pos.tradeId, pos.symbol, riskAtStop(pos));
      }

      if (this.activePositions.length > 0) {
        this.addLog(`Restored ${this.activePositions.length} open position(s) from state.`);
      }
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.addLog('Scalping engine started.');
    await this.bootstrap();
    void this.refreshFundingRates(); // initial fetch, then self-schedules
    this.scheduleLoop();
  }

  /** Fetch funding rates for all watchlist symbols; re-schedules every 30 min. */
  private async refreshFundingRates(): Promise<void> {
    for (const symbol of this.watchlist) {
      const rate = await exchange.getFundingRate(symbol);
      if (rate !== null) {
        this.fundingRateCache.set(symbol, { rate, fetchedAt: Date.now() });
      }
    }
    if (this.isRunning) {
      setTimeout(() => void this.refreshFundingRates(), ScalpingEngine.FUNDING_CACHE_TTL_MS);
    }
  }

  /** Returns cached funding rate for symbol, or null if unavailable / stale. */
  private getCachedFundingRate(symbol: string): number | null {
    const entry = this.fundingRateCache.get(symbol);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > ScalpingEngine.FUNDING_CACHE_TTL_MS * 2) return null;
    return entry.rate;
  }

  stop(): void {
    this.isRunning = false;
    this.addLog('Scalping engine stopped.');
    for (const sym of this.watchlist) this.ws.unsubscribe(sym);
  }

  getStatus() {
    return {
      engineId: ENGINE_ID,
      isRunning: this.isRunning,
      activePositions: this.activePositions,
      tradeHistory: this.tradeHistory,
      logs: this.logs,
      wsStatus: this.ws.getConnectionStatus(),
    };
  }

  /** Engine watchlist ∪ default panel symbols (for UI grid + WS broadcast). */
  getPanelWatchlistSymbols(): string[] {
    return [
      ...new Set([
        ...this.watchlist.map((s) => s.toUpperCase()),
        ...DEFAULT_WATCHLIST_PANEL_SYMBOLS,
      ]),
    ];
  }

  getLastSignal(symbol: string): ScalpLastSignal | null {
    return this.lastSignalBySymbol.get(symbol.toUpperCase()) ?? null;
  }

  /** Refresh in-memory signals for every panel symbol (each scan tick). */
  private async refreshPanelSignals(): Promise<void> {
    for (const raw of this.getPanelWatchlistSymbols()) {
      const symbol = raw.toUpperCase();
      const timestamp = Date.now();
      const put = (s: ScalpLastSignal) => this.lastSignalBySymbol.set(symbol, s);

      if (!this.isRunning) {
        put({ decision: 'SKIP', score: 0, reason: 'engine_stopped', timestamp });
        continue;
      }
      if (!this.watchlist.includes(symbol)) {
        put({ decision: 'SKIP', score: 0, reason: 'not_on_watchlist', timestamp });
        continue;
      }
      if (!this.ws.isReady(symbol, this.minBufferTicksFor(symbol))) {
        put({
          decision: 'SKIP',
          score: 0,
          reason: `buffer_cold_${this.ws.getRecentPrices(symbol).length}`,
          timestamp,
        });
        continue;
      }

      const prices = this.ws.getRecentPrices(symbol);
      const vol = tickVolatilityGate(prices);
      if (vol.ok === false) {
        put({ decision: 'SKIP', score: 0, reason: shortenScalpReason(vol.reason), timestamp });
        continue;
      }
      // Noise is advisory only (score-side), not a hard gate.
      tickNoiseGate(prices, symbol);

      const ctx = await this.ensureScalpMarketContext(symbol);
      if (ctx == null) {
        put({ decision: 'SKIP', score: 0, reason: 'htf_unavailable', timestamp });
        continue;
      }

      const entry = this.evaluateEntry(symbol, prices, ctx);
      if (!entry.ok) {
        put({
          decision: 'SKIP',
          score: 0,
          reason: shortenScalpReason(entry.reason),
          timestamp,
        });
        continue;
      }

      put({
        decision: entry.side === 'LONG' ? 'BUY' : 'SELL',
        score: entry.score,
        reason: 'entry_ok',
        timestamp,
      });
    }
  }

  /**
   * Lightweight read-only snapshot for dashboard: mirrors scan gates + evaluateEntry without opening.
   */
  async getDashboardSnapshot(symbol: string): Promise<{
    engineId: string;
    isRunning: boolean;
    watchlist: string[];
    wsStatus: Record<string, { connected: boolean; bufferSize: number }>;
    symbol: string;
    evaluatedAt: number;
    currentPrice: number | null;
    sparkline: number[];
    htfTrend: 'up' | 'down' | 'flat' | 'unknown';
    volShort: number | null;
    decision: 'BUY' | 'SELL' | 'SKIP';
    skipReason?: string;
    entryScore?: number;
    momentumStrength?: number;
    executionNote?: string;
  }> {
    const wsStatus = this.ws.getConnectionStatus();
    const currentPrice = this.ws.getLatestPrice(symbol);
    const sparkline = this.ws.getRecentPrices(symbol, 80);
    const prices = this.ws.getRecentPrices(symbol);

    const volPackEarly =
      prices.length >= VOL_LONG_RETURNS + 1
        ? tickReturnVolatility(prices, VOL_SHORT_RETURNS, VOL_LONG_RETURNS)
        : null;
    let volShort: number | null = volPackEarly?.shortVol ?? null;

    let htfTrend: 'up' | 'down' | 'flat' | 'unknown' = 'unknown';
    const ctx = await this.ensureScalpMarketContext(symbol);
    if (ctx) {
      if (ctx.allowsLong && !ctx.allowsShort) htfTrend = 'up';
      else if (ctx.allowsShort && !ctx.allowsLong) htfTrend = 'down';
      else htfTrend = 'flat';
    }

    const base = {
      engineId: ENGINE_ID,
      isRunning: this.isRunning,
      watchlist: [...this.watchlist],
      wsStatus,
      symbol,
      evaluatedAt: Date.now(),
      currentPrice,
      sparkline,
      htfTrend,
      volShort,
      decision: 'SKIP' as const,
    };

    if (!this.watchlist.includes(symbol)) {
      return { ...base, skipReason: 'not_on_watchlist' };
    }

    if (!this.isRunning) {
      return { ...base, skipReason: 'engine_stopped' };
    }

    if (!this.ws.isReady(symbol, this.minBufferTicksFor(symbol))) {
      return {
        ...base,
        skipReason: `buffer_cold(${prices.length})`,
      };
    }

    const vol = tickVolatilityGate(prices);
    if (vol.ok === false) {
      const vp = tickReturnVolatility(prices, VOL_SHORT_RETURNS, VOL_LONG_RETURNS);
      volShort = vp?.shortVol ?? volShort;
      return { ...base, volShort, skipReason: vol.reason };
    }

    // Noise is advisory only (score-side), not a hard gate.
    tickNoiseGate(prices, symbol);

    if (ctx == null) {
      const vp = tickReturnVolatility(prices, VOL_SHORT_RETURNS, VOL_LONG_RETURNS);
      volShort = vp?.shortVol ?? volShort;
      return { ...base, volShort, skipReason: 'htf_context_unavailable' };
    }

    const entry = this.evaluateEntry(symbol, prices, ctx);
    volShort = tickReturnVolatility(prices, VOL_SHORT_RETURNS, VOL_LONG_RETURNS)?.shortVol ?? volShort;

    if (!entry.ok) {
      return {
        ...base,
        volShort,
        skipReason: entry.reason,
      };
    }

    let executionNote: string | undefined;
    if (Date.now() < this.lossStreakPauseUntil) executionNote = 'loss_streak_pause';
    else if (this.activePositions.length >= MAX_POSITIONS) executionNote = 'max_positions';
    else if (this.lastTradeOpenedAt > 0 && Date.now() - this.lastTradeOpenedAt < TRADE_COOLDOWN_MS) {
      executionNote = 'global_cooldown';
    } else if (Date.now() - (this.symbolLastClosedAt.get(symbol) ?? 0) < SYMBOL_POST_CLOSE_COOLDOWN_MS) {
      executionNote = 'symbol_cooldown';
    } else if (this.activePositions.some(p => p.symbol === symbol)) {
      executionNote = 'already_in_symbol';
    }

    return {
      ...base,
      volShort: entry.volShort,
      decision: entry.side === 'LONG' ? 'BUY' : 'SELL',
      entryScore: entry.score,
      momentumStrength: entry.momentumStrength,
      executionNote,
    };
  }

  getPerformanceStats() {
    const closed = this.tradeHistory.filter(t => closedTradeNetAmount(t) != null);
    const net = (t: TradeLog) => closedTradeNetAmount(t) as number;
    const wins   = closed.filter(t => net(t) > 0);
    const losses = closed.filter(t => net(t) < 0);
    const n      = closed.length;
    const avgProfit = wins.length   > 0 ? wins.reduce((s, t)   => s + net(t), 0) / wins.length   : 0;
    const avgLoss   = losses.length > 0 ? losses.reduce((s, t) => s + net(t), 0) / losses.length : 0;
    const sumWins   = wins.reduce((s, t) => s + net(t), 0);
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
      winRate: n > 0 ? wins.length / n : 0,
      avgProfit,
      avgLoss,
      profitFactor,
      avgWinToAvgLoss,
      totalNetPnl,
    };
  }

  /**
   * Mark open positions for API/UI — WebSocket only (no REST in the hot path).
   */
  async refreshOpenPositionMarks(): Promise<void> {
    for (const pos of this.activePositions) {
      const price = this.ws.getLatestPrice(pos.symbol);
      if (price != null) this.applyMark(pos, price);
    }
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  /**
   * Static watchlist; one cached 1m kline fetch per symbol at boot (DataLayer TTL thereafter).
   * Subscribe cold if bootstrap REST fails — WS fills the tick buffer over time.
   */
  private async bootstrap(): Promise<void> {
    // Full static universe (DataLayer clamps to STATIC_USDT_UNIVERSE length; boot spacing avoids REST burst).
    this.watchlist = DataLayer.getStaticScalpWatchlist(64);
    this.addLog(`Scalp watchlist (static): ${this.watchlist.join(', ')}`);

    for (const symbol of this.watchlist) {
      try {
        const ohlcv: OHLCV[] = await DataLayer.getScalpContext1m(symbol, OHLCV_FETCH_LIMIT);
        this.ohlcvCache.set(symbol, { bars: ohlcv, fetchedAt: Date.now() });
        const prices = ohlcv.map(c => c.close);
        this.ws.subscribe(symbol, prices.length ? prices : undefined);
        this.addLog(`[boot] ${symbol}: seeded ${prices.length} bars → WS live`);
      } catch {
        this.ws.subscribe(symbol);
        this.addLog(`[boot] ${symbol}: REST seed failed → WS subscribed cold`);
      }
      await sleep(300);
    }

    const extraSyms = [
      ...new Set(this.activePositions.map((p) => p.symbol).filter((s) => !this.watchlist.includes(s))),
    ];
    for (const symbol of extraSyms) {
      try {
        const ohlcv: OHLCV[] = await DataLayer.getScalpContext1m(symbol, OHLCV_FETCH_LIMIT);
        this.ohlcvCache.set(symbol, { bars: ohlcv, fetchedAt: Date.now() });
        const prices = ohlcv.map((c) => c.close);
        this.ws.subscribe(symbol, prices.length ? prices : undefined);
        this.addLog(`[boot] ${symbol}: WS for open position (not on watchlist)`);
      } catch {
        this.ws.subscribe(symbol);
        this.addLog(`[boot] ${symbol}: WS cold (open position)`);
      }
      await sleep(300);
    }

    for (const symbol of this.getPanelWatchlistSymbols()) {
      this.ws.subscribe(symbol);
    }
  }

  /** 1m bars for ATR + soft HTF hints; impulse entries do not hard-require HTF alignment. */
  private async ensureScalpMarketContext(symbol: string): Promise<ScalpMarketContext | null> {
    try {
      const bars = await DataLayer.getScalpContext1m(symbol, OHLCV_FETCH_LIMIT);
      const minBars = Math.max(ATR_PERIOD_SCALP + 2, 30);
      if (bars.length < minBars) return null;
      this.ohlcvCache.set(symbol, { bars, fetchedAt: Date.now() });
      const flags = htfTrendFlags(bars);
      if (flags != null) {
        return {
          ohlcv: bars,
          allowsLong: flags.allowsLong,
          allowsShort: flags.allowsShort,
          htfSpreadPct: flags.htfSpreadPct,
        };
      }
      return {
        ohlcv: bars,
        allowsLong: true,
        allowsShort: true,
        htfSpreadPct: 0,
      };
    } catch {
      return null;
    }
  }

  // ── Loop ──────────────────────────────────────────────────────────────────

  /**
   * Use recursive setTimeout instead of a while loop so each tick starts fresh
   * without drift. The loop yields at every await, letting the swing engine run.
   */
  private scheduleLoop(): void {
    const tick = async () => {
      if (!this.isRunning) return;
      try {
        this.monitorPositions(); // synchronous — WS prices are already in memory
        await this.scanAndTrade();
      } catch (e) {
        this.addLog(`[loop error] ${e}`);
      }
      if (this.isRunning) setTimeout(tick, LOOP_INTERVAL_MS);
    };
    setTimeout(tick, LOOP_INTERVAL_MS);
  }

  // ── Position monitoring ───────────────────────────────────────────────────

  /**
   * Check SL/TP for every open position using the latest WS price.
   * No await — purely in-memory, runs in microseconds.
   */
  private async monitorPositions(): Promise<void> {
    for (let i = this.activePositions.length - 1; i >= 0; i--) {
      const pos   = this.activePositions[i];
      const price = this.ws.getLatestPrice(pos.symbol);
      if (price == null) continue;

      this.applyMark(pos, price);

      // Break-even trailing stop: once price reaches 50% of TP distance,
      // move SL to entry + round-trip fee buffer so worst case is a scratch.
      const tpDist   = Math.abs(pos.takeProfit - pos.entryPrice);
      const progress = pos.side === 'LONG'
        ? price - pos.entryPrice
        : pos.entryPrice - price;

      if (progress >= tpDist * 0.5) {
        // Fee buffer = 0.2% round-trip so we never close at a loss after fees
        const feeBuffer = pos.entryPrice * 0.002;
        const beStop    = pos.side === 'LONG'
          ? pos.entryPrice + feeBuffer
          : pos.entryPrice - feeBuffer;

        const moved = pos.side === 'LONG'
          ? beStop > pos.stopLoss
          : beStop < pos.stopLoss;

        if (moved) {
          pos.stopLoss = beStop;
          this.addLog(`[BE] ${pos.symbol} SL → breakeven+fees @ ${beStop.toFixed(4)}`);
        }
      }

      let closeReason: string | null = null;
      if (pos.side === 'LONG') {
        if (price <= pos.stopLoss)   closeReason = 'SL';
        if (price >= pos.takeProfit) closeReason = 'TP';
      } else {
        if (price >= pos.stopLoss)   closeReason = 'SL';
        if (price <= pos.takeProfit) closeReason = 'TP';
      }

      if (closeReason) await this.closePosition(i, price, closeReason);
    }
  }

  private applyMark(pos: Position, price: number): void {
    pos.currentPrice  = price;
    pos.unrealizedPnl = pos.side === 'LONG'
      ? (price - pos.entryPrice) * pos.amount
      : (pos.entryPrice - price) * pos.amount;
  }

  // ── Entry scanning ────────────────────────────────────────────────────────

  private async scanAndTrade(): Promise<void> {
    await this.refreshPanelSignals();

    // Pause check
    if (Date.now() < this.lossStreakPauseUntil) {
      const secsLeft = Math.ceil((this.lossStreakPauseUntil - Date.now()) / 1000);
      if (secsLeft % 60 < (LOOP_INTERVAL_MS / 1000)) {
        this.addLog(`PAUSED loss_streak ~${Math.ceil(secsLeft / 60)}min remaining`);
      }
      return;
    }

    // Per-engine cap check (locally — don't bother portfolio if already full)
    if (this.activePositions.length >= MAX_POSITIONS) return;

    // Global cooldown check
    const elapsed = Date.now() - this.lastTradeOpenedAt;
    if (this.lastTradeOpenedAt > 0 && elapsed < TRADE_COOLDOWN_MS) return;

    for (const symbol of this.watchlist) {
      // Skip if already in this symbol
      if (this.activePositions.find(p => p.symbol === symbol)) continue;

      // Per-symbol cooldown after last close
      const lastClosed = this.symbolLastClosedAt.get(symbol) ?? 0;
      if (Date.now() - lastClosed < SYMBOL_POST_CLOSE_COOLDOWN_MS) continue;

      // WebSocket buffer must be warm
      if (!this.ws.isReady(symbol, this.minBufferTicksFor(symbol))) {
        this.addLog(`SKIP ${symbol} cause=buffer_cold(${this.ws.getRecentPrices(symbol).length}ticks)`);
        continue;
      }

      const prices = this.ws.getRecentPrices(symbol);
      const vol = tickVolatilityGate(prices);
      if (vol.ok === false) {
        this.addLog(`SKIP ${symbol} cause=${vol.reason}`);
        continue;
      }

      // Noise is advisory only (score-side), not a hard gate.
      tickNoiseGate(prices, symbol);

      const ctx = await this.ensureScalpMarketContext(symbol);
      if (ctx == null) {
        this.addLog(`SKIP ${symbol} cause=htf_context_unavailable`);
        continue;
      }

      // Funding rate guard: avoid entering on the crowded side
      const fundingRate = this.getCachedFundingRate(symbol);

      const entry = this.evaluateEntry(symbol, prices, ctx);

      if (!entry.ok) {
        this.addLog(`SKIP ${symbol} cause=${entry.reason}`);
        continue;
      }

      // Block entries that fight an extreme funding rate
      if (fundingRate !== null) {
        if (entry.side === 'LONG' && fundingRate > ScalpingEngine.FUNDING_EXTREME) {
          this.addLog(`SKIP ${symbol} cause=funding_long_squeeze(${fundingRate.toFixed(5)})`);
          continue;
        }
        if (entry.side === 'SHORT' && fundingRate < -ScalpingEngine.FUNDING_EXTREME) {
          this.addLog(`SKIP ${symbol} cause=funding_short_squeeze(${fundingRate.toFixed(5)})`);
          continue;
        }
      }

      // CVD gate: only enter when order flow confirms the impulse direction
      const cvd = this.ws.getCVD(symbol, 30_000);
      if (cvd !== null) {
        if (entry.side === 'LONG' && cvd.cvd < 0) {
          this.addLog(`SKIP ${symbol} cause=cvd_bearish_flow(${cvd.cvd.toFixed(4)})`);
          continue;
        }
        if (entry.side === 'SHORT' && cvd.cvd > 0) {
          this.addLog(`SKIP ${symbol} cause=cvd_bullish_flow(${cvd.cvd.toFixed(4)})`);
          continue;
        }
      }

      const price = this.ws.getLatestPrice(symbol)!;
      await this.openTrade(symbol, price, entry.side, entry.reason, ctx.ohlcv, {
        score: entry.score,
        momentumStrength: entry.momentumStrength,
        volShort: entry.volShort,
      });

      // One trade per loop tick — prevents double-opening in a single scan
      break;
    }
  }

  // ── Signal logic ──────────────────────────────────────────────────────────

  private evaluateEntry(symbol: string, prices: number[], ctx: ScalpMarketContext): EntryEval {
    if (SCALP_EXCLUDED_SYMBOLS.has(symbol)) return { ok: false, reason: 'symbol_excluded' };

    // Hard noise gate — reject choppy tape before any further evaluation
    const noiseCheck = tickNoiseGate(prices, symbol);
    if (noiseCheck.ok === false) return { ok: false, reason: noiseCheck.reason };

    const volPack = tickReturnVolatility(prices, VOL_SHORT_RETURNS, VOL_LONG_RETURNS);
    if (volPack == null) return { ok: false, reason: 'vol_insufficient_ticks' };
    const volShort = volPack.shortVol;

    // Volume / volatility gate (impulse scalping)
    if (volShort <= VOL_MIN) {
      return { ok: false, reason: `vol_below_min(${volShort.toExponential(2)})` };
    }
    if (volShort >= MAX_TICK_VOL) {
      console.log(`[SCALP] SKIP cause=vol_extreme ${symbol} shortVol=${volShort.toExponential(2)}`);
      return { ok: false, reason: 'vol_extreme' };
    }

    const n = IMPULSE_RETURN_COUNT;
    if (prices.length < n + 1) return { ok: false, reason: 'impulse_insufficient_ticks' };
    const recentReturns = lastKReturns(prices, n);
    if (recentReturns.length < n) return { ok: false, reason: 'impulse_insufficient_ticks' };

    const impulseStrength = recentReturns.reduce((s, r) => s + Math.abs(r), 0);
    const directionalBias = recentReturns.reduce((s, r) => s + r, 0);
    const posTicks = recentReturns.filter((r) => r > 0).length;
    const negTicks = recentReturns.filter((r) => r < 0).length;
    const posFrac = posTicks / n;
    const negFrac = negTicks / n;

    if (impulseStrength < IMPULSE_MIN) {
      console.log(
        `[SCALP] SKIP cause=weak_impulse ${symbol} strength=${impulseStrength.toExponential(3)}`
      );
      return { ok: false, reason: 'weak_impulse' };
    }

    let side: 'LONG' | 'SHORT' | null = null;
    if (directionalBias > 0 && impulseStrength > IMPULSE_MIN && posFrac >= IMPULSE_DIRECTION_FRAC) {
      side = 'LONG';
    } else if (
      directionalBias < 0 &&
      impulseStrength > IMPULSE_MIN &&
      negFrac >= IMPULSE_DIRECTION_FRAC
    ) {
      side = 'SHORT';
    }

    if (side == null) {
      return { ok: false, reason: 'no_impulse' };
    }

    // Require that the 3 ticks preceding the impulse window also lean in the same direction.
    // This ensures the move has been building, not just a single noise burst at the end.
    if (prices.length >= n + 4) {
      const preImpulseReturns = lastKReturns(prices, n + 3).slice(0, 3);
      const preAligned = preImpulseReturns.filter(r => side === 'LONG' ? r > 0 : r < 0).length;
      if (preAligned < 2) {
        return { ok: false, reason: 'impulse_no_buildup' };
      }
    }

    console.log(
      `[SCALP] IMPULSE ${side} strength=${impulseStrength.toExponential(3)} bias=${directionalBias.toExponential(3)} ` +
        `${symbol} posFrac=${posFrac.toFixed(2)} negFrac=${negFrac.toFixed(2)}`
    );

    const closes = ctx.ohlcv.map((c) => c.close);
    const last = prices[prices.length - 1];
    const cEma9 = closes.length >= 9 ? computeEMA(closes, 9) : last;
    const cEma21 = closes.length >= 21 ? computeEMA(closes, 21) : last;
    const spread =
      closes.length >= 21
        ? Math.abs(cEma9 - cEma21) / Math.max(Math.abs(cEma21), 1e-12)
        : 0;

    // Hard-reject counter-trend entries — a soft penalty is insufficient given low win rate
    if (side === 'LONG' && !ctx.allowsLong) return { ok: false, reason: 'htf_conflict_long' };
    if (side === 'SHORT' && !ctx.allowsShort) return { ok: false, reason: 'htf_conflict_short' };

    let penalty = 0;
    if (spread > 0 && spread < MIN_EMA_SPREAD_PCT) penalty += 6;

    const noiseReturns = lastKReturns(prices, NOISE_K);
    if (noiseReturns.length > 0) {
      const signedSum = noiseReturns.reduce(
        (s, r) => s + (Math.abs(r) > MICRO_NOISE_FLOOR ? Math.sign(r) : 0),
        0
      );
      const consistency = Math.abs(signedSum) / noiseReturns.length;
      if (consistency < CONSISTENCY_MIN) penalty += 5;
    }

    const accelRatio = 1 + Math.min(impulseStrength / Math.max(IMPULSE_MIN, 1e-12), 2);
    let score = entryQualityScore({
      accelRatio,
      volShort,
      tickSpread: impulseStrength / n,
      htfSpreadPct: ctx.htfSpreadPct,
      last,
      ema21: cEma21,
    });
    score = Math.max(0, Math.round(score - penalty));

    if (score < ENTRY_SCORE_MIN) {
      return { ok: false, reason: `score_below_${ENTRY_SCORE_MIN}(${score})` };
    }

    return {
      ok: true,
      side,
      score,
      momentumStrength: impulseStrength,
      volShort,
      reason: `impulse_${side} strength=${impulseStrength.toExponential(2)} bias=${directionalBias.toExponential(2)}`,
    };
  }

  // ── Trade execution ───────────────────────────────────────────────────────

  private async openTrade(
    symbol: string,
    price: number,
    side: 'LONG' | 'SHORT',
    signalReason: string,
    ohlcv: OHLCV[],
    entryQuality: { score: number; momentumStrength: number; volShort: number }
  ): Promise<void> {
    if (this.startingBalance > 0) {
      const dailyPnl = this.portfolio.getBalance() - this.startingBalance;
      if (dailyPnl <= -this.startingBalance * DAILY_LOSS_LIMIT_FRAC) {
        this.addLog(`SKIP ${symbol} ${side} cause=daily_loss_limit pnl=${dailyPnl.toFixed(2)}`);
        return;
      }
    }

    const signalTimestamp = Date.now();
    const atr = computeATR(ohlcv, ATR_PERIOD_SCALP);
    if (atr == null || atr <= 0) {
      this.addLog(`SKIP ${symbol} ${side} cause=atr_unavailable`);
      return;
    }

    const balance  = this.portfolio.getBalance();
    const scale    = scoreToNotionalScale(entryQuality.score);
    // Notional = margin × leverage (the actual position size sent to exchange)
    const notional = balance * NOTIONAL_FRAC * SCALP_LEVERAGE * scale;
    const amount   = notional / price;

    const rawSl = ATR_STOP_MULT * atr;
    const slMin = price * SL_MIN_PCT;
    const slMax = price * SL_MAX_PCT;
    const clamped = Math.min(slMax, Math.max(slMin, rawSl));
    const slDist = Math.max(slMin, clamped * SL_TIGHTEN_MULT);
    const existingTpDist = slDist * TP_RR;
    const tpDist = Math.max(TP_MIN_R_MULT * slDist, existingTpDist);
    const sl      = side === 'LONG' ? price - slDist : price + slDist;
    const tp      = side === 'LONG' ? price + tpDist : price - tpDist;
    const riskAmt = slDist * amount; // dollars at risk if SL hit

    const minEdge = minTpDistanceForFees(price);
    if (tpDist < minEdge) {
      this.addLog(
        `SKIP ${symbol} ${side} cause=fee_min_edge(tpDist=${tpDist.toFixed(6)} need>=${minEdge.toFixed(6)})`
      );
      return;
    }

    // Fee-aware: net price move to TP must exceed stop distance (same units as SL risk)
    const roundTripFees = feeOnNotional(price, amount) + feeOnNotional(tp, amount);
    const netTpMovePerUnit = tpDist - roundTripFees / amount;
    if (netTpMovePerUnit <= 0) {
      this.addLog(
        `SKIP ${symbol} ${side} cause=negative_edge(netTPmove=${netTpMovePerUnit.toFixed(6)} ` +
          `tpDist=${tpDist.toFixed(6)} fees/amt=${(roundTripFees / amount).toFixed(6)})`
      );
      return;
    }
    if (netTpMovePerUnit <= slDist * 0.6) {
      this.addLog(
        `SKIP ${symbol} ${side} cause=fee_rr(netTPmove=${netTpMovePerUnit.toFixed(6)} need>${(slDist * 0.6).toFixed(6)} ` +
          `tpDist=${tpDist.toFixed(6)} fees/amt=${(roundTripFees / amount).toFixed(6)})`
      );
      return;
    }

    const { entryFee, exitFee } = entryExitFees(price, tp, amount);
    const netMoveAfterFees = tpDist - (entryFee + exitFee) / amount;
    if (netMoveAfterFees < slDist * MIN_NET_R_MULTIPLE) {
      this.addLog(`[SCALP] SKIP ${symbol} cause=net_edge_too_low`);
      return;
    }

    const riskReward = tpDist / slDist;

    // Portfolio gate — synchronous check + register (atomic in Node.js)
    const allocation = this.portfolio.requestCapital(ENGINE_ID, symbol, riskAmt);
    if (!allocation.approved) {
      this.addLog(`SKIP ${symbol} ${side} cause=${allocation.reason}`);
      return;
    }

    if (allocation.riskAllocated < riskAmt) {
      this.addLog(
        `SKIP ${symbol} ${side} cause=partial_risk_allocation(request=${riskAmt.toFixed(2)} approved=${allocation.riskAllocated.toFixed(2)})`
      );
      return;
    }

    await exchange.setLeverage(symbol, SCALP_LEVERAGE)
      .catch(() => { /* default leverage used on failure */ });

    const order = await exchange.placeMarketOrder(symbol, side === 'LONG' ? 'BUY' : 'SELL', amount);
    if (!order) {
      this.addLog(`SKIP ${symbol} ${side} cause=order_failed`);
      return;
    }

    const latencyMs = Date.now() - signalTimestamp;
    const slipBps = entrySlippageBps(side, price, order.avgPrice);
    if (latencyMs > MAX_ENTRY_LATENCY_MS || slipBps > MAX_ENTRY_SLIPPAGE_BPS) {
      const cause = latencyMs > MAX_ENTRY_LATENCY_MS
        ? `latency(${latencyMs}ms)`
        : `entry_slippage(${slipBps.toFixed(2)}bps)`;
      const flattened = await exchange.closePosition(symbol, side, order.executedQty);
      this.addLog(
        `SKIP ${symbol} ${side} cause=${cause}; ` +
        `entry_order=${order.orderId} flatten=${flattened ? 'ok' : 'failed'}`
      );
      if (flattened) return;
    }

    const tradeId = randomUUID();
    const fillOffset = order.avgPrice - price;
    const fillSl = sl + fillOffset;
    const fillTp = tp + fillOffset;
    const fillSlDist = Math.abs(order.avgPrice - fillSl);
    const actualRiskAmt = fillSlDist * order.executedQty;

    const position: Position = {
      tradeId,
      symbol,
      entryPrice:    order.avgPrice,
      currentPrice:  order.avgPrice,
      unrealizedPnl: 0,
      amount:        order.executedQty,
      side,
      stopLoss:      fillSl,
      takeProfit:    fillTp,
      timestamp:     Date.now(),
      initialStopDist: fillSlDist,
      engineId:      ENGINE_ID,
      exchangeOrderId: order.orderId,
    };

    const trade: TradeLog = {
      id:         tradeId,
      symbol,
      side,
      signalPrice: price,
      signalTimestamp,
      fillPrice: order.avgPrice,
      entrySlippageBps: slipBps,
      latencyMs,
      initialRiskUsd: actualRiskAmt,
      entryPrice: order.avgPrice,
      amount: order.executedQty,
      status:     'OPEN',
      timestamp:  Date.now(),
      source:     'scalp',
      scalpEntryQuality: {
        score: entryQuality.score,
        momentumStrength: entryQuality.momentumStrength,
        volShort: entryQuality.volShort,
      },
      scalpRiskReward: {
        slDistance: fillSlDist,
        tpDistance: tpDist,
        riskReward: fillSlDist > 0 ? Math.abs(fillTp - order.avgPrice) / fillSlDist : riskReward,
      },
    };

    this.portfolio.registerTrade(ENGINE_ID, tradeId, symbol, actualRiskAmt);

    this.activePositions.push(position);
    this.tradeHistory.push(trade);
    this.lastTradeOpenedAt = Date.now();

    this.persistState();
    this.addLog(
      `OPEN ${side} ${symbol} @ ${order.avgPrice.toFixed(4)} signal=${price.toFixed(4)} slip=${slipBps.toFixed(2)}bps ` +
      `SL=${fillSl.toFixed(4)} TP=${fillTp.toFixed(4)} ` +
      `slDist=${fillSlDist.toFixed(6)} tpDist=${Math.abs(fillTp - order.avgPrice).toFixed(6)} R:R=${(fillSlDist > 0 ? Math.abs(fillTp - order.avgPrice) / fillSlDist : riskReward).toFixed(2)} ` +
      `size=${notional.toFixed(2)}$(${SCALP_LEVERAGE}x) scale=${scale.toFixed(2)} ` +
      `score=${entryQuality.score} momStr=${entryQuality.momentumStrength.toExponential(2)} ` +
      `volShort=${entryQuality.volShort.toExponential(2)} | ${signalReason}`
    );
  }

  private async closePosition(index: number, price: number, reason: string): Promise<void> {
    const pos = this.activePositions[index];

    // Attempt live close on exchange; keep the position open if reduce-only fails.
    const result = await exchange.closePosition(pos.symbol, pos.side, pos.amount);
    if (!result) {
      this.addLog(`ERROR: close failed ${pos.symbol} tradeId=${pos.tradeId}; position kept open`);
      return;
    }
    const closePrice = result.avgPrice;

    const grossPnl = pos.side === 'LONG'
      ? (closePrice - pos.entryPrice) * pos.amount
      : (pos.entryPrice - closePrice) * pos.amount;

    const { entryFee, exitFee } = entryExitFees(pos.entryPrice, closePrice, pos.amount);
    const netPnl = grossPnl - entryFee - exitFee;
    const trade = this.tradeHistory.find(t => t.id === pos.tradeId);
    const initialRiskUsd = trade?.initialRiskUsd ?? riskAtStop(pos);
    const realizedR = initialRiskUsd > 0 ? netPnl / initialRiskUsd : 0;
    const plannedExit = reason === 'TP' ? pos.takeProfit : reason === 'SL' ? pos.stopLoss : price;
    const exitSlip = exitSlippageBps(pos.side, plannedExit, closePrice);

    // Update trade log
    if (trade) {
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
    }

    // Portfolio: remove from risk registry and credit net PnL to shared balance
    this.portfolio.closeTrade(pos.tradeId, netPnl);

    this.activePositions.splice(index, 1);
    this.symbolLastClosedAt.set(pos.symbol, Date.now());

    this.addLog(
      `CLOSE ${pos.symbol} @ ${closePrice.toFixed(4)} (${reason}) ` +
      `Net=${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(2)} gross=${grossPnl.toFixed(2)} fees=${(entryFee + exitFee).toFixed(2)} ` +
      `balance=${this.portfolio.getBalance().toFixed(2)}`
    );

    this.checkLossStreak();
    this.persistState();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private checkLossStreak(): void {
    const recent = this.tradeHistory
      .filter(t => closedTradeNetAmount(t) != null)
      .slice(-LOSS_STREAK_COUNT);

    if (
      recent.length === LOSS_STREAK_COUNT &&
      recent.every(t => (closedTradeNetAmount(t) as number) < 0) &&
      Date.now() >= this.lossStreakPauseUntil
    ) {
      this.lossStreakPauseUntil = Date.now() + LOSS_STREAK_PAUSE_MS;
      this.addLog(`PAUSE 30min — ${LOSS_STREAK_COUNT} consecutive scalp losses`);
    }
  }

  private persistState(): void {
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

  private addLog(msg: string): void {
    const time  = new Date().toLocaleTimeString();
    const entry = `[${time}][SCALP] ${msg}`;
    this.logs.push(entry);
    if (this.logs.length > 100) this.logs.shift();
    console.log(entry);
  }
}
