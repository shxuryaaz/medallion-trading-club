import { randomUUID } from 'crypto';
import { DataLayer } from '../DataLayer';
import type { OHLCV } from '../DataLayer';
import type { Position } from '../Engine';
import { computeATR } from '../Engine';
import type { TradeLog } from '../types';
import { PortfolioManager } from '../portfolio/PortfolioManager';
import { WebSocketManager } from '../data/WebSocketManager';
import { StateStore } from '../persistence/StateStore';
import { closedTradeNetAmount, entryExitFees, feeOnNotional, minTpDistanceForFees } from '../fees';
import { DEFAULT_WATCHLIST_PANEL_SYMBOLS } from '../../constants/watchlistPanel.ts';

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

/**
 * Wilder-smoothed RSI. Returns null if there are not enough data points.
 * period = 7 for scalping (faster reaction than the swing engine's 14).
 */
function computeRSI(prices: number[], period = 7): number | null {
  if (prices.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const delta = prices[i] - prices[i - 1];
    avgGain += delta > 0 ? delta : 0;
    avgLoss += delta < 0 ? -delta : 0;
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period + 1; i < prices.length; i++) {
    const delta = prices[i] - prices[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }

  if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
  const rs = avgGain / avgLoss;
  return Math.min(100, Math.max(0, 100 - 100 / (1 + rs)));
}

/**
 * Micro-momentum: direction of price movement over the last `lookback` ticks.
 * Returns 'up' / 'down' / 'flat'.
 */
function microMomentum(prices: number[], lookback = 5): 'up' | 'down' | 'flat' {
  if (prices.length < lookback + 1) return 'flat';
  const slice = prices.slice(-lookback - 1);
  const delta = slice[slice.length - 1] - slice[0];
  const threshold = slice[0] * 0.0001; // 0.01% of price
  if (delta > threshold) return 'up';
  if (delta < -threshold) return 'down';
  return 'flat';
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

function meanAbs(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + Math.abs(x), 0) / arr.length;
}

function tickAcceleration(
  prices: number[],
  n: number,
  side: 'LONG' | 'SHORT'
):
  | { ok: true; strengthRecent: number; strengthPrev: number; sumRecent: number; ratio: number }
  | { ok: false; reason: string } {
  if (prices.length < 2 * n + 1) return { ok: false, reason: 'accel_insufficient' };
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    if (prev === 0) continue;
    returns.push((prices[i] - prev) / prev);
  }
  if (returns.length < 2 * n) return { ok: false, reason: 'accel_insufficient' };
  const lastN = returns.slice(-n);
  const prevN = returns.slice(-2 * n, -n);
  const strengthRecent = meanAbs(lastN);
  const strengthPrev = meanAbs(prevN);
  const sumRecent = lastN.reduce((s, x) => s + x, 0);
  if (strengthPrev < 1e-12) return { ok: false, reason: 'accel_insufficient' };
  const ratio = strengthRecent / strengthPrev;
  if (side === 'LONG') {
    if (sumRecent <= 0) return { ok: false, reason: 'accel_no_drift_up' };
    if (strengthRecent <= strengthPrev * (1 + ACCEL_EPS)) return { ok: false, reason: 'accel_not_increasing' };
  } else {
    if (sumRecent >= 0) return { ok: false, reason: 'accel_no_drift_down' };
    if (strengthRecent <= strengthPrev * (1 + ACCEL_EPS)) return { ok: false, reason: 'accel_not_increasing' };
  }
  return { ok: true, strengthRecent, strengthPrev, sumRecent, ratio };
}

function pullbackOkLong(prices: number[]): { ok: true } | { ok: false; reason: string } {
  if (prices.length < PULLBACK_W) return { ok: false, reason: 'pullback_insufficient' };
  const priorHigh = Math.max(...prices.slice(-PULLBACK_W, -3));
  const pullbackLow = Math.min(...prices.slice(-8, -2));
  const last = prices[prices.length - 1];
  if (!(pullbackLow < priorHigh)) return { ok: false, reason: 'no_pullback_long' };
  if (!(last > pullbackLow)) return { ok: false, reason: 'pullback_no_bounce' };
  if (last > priorHigh) return { ok: false, reason: 'chasing_high' };
  return { ok: true };
}

function pullbackOkShort(prices: number[]): { ok: true } | { ok: false; reason: string } {
  if (prices.length < PULLBACK_W) return { ok: false, reason: 'pullback_insufficient' };
  const priorLow = Math.min(...prices.slice(-PULLBACK_W, -3));
  const pullbackHigh = Math.max(...prices.slice(-8, -2));
  const last = prices[prices.length - 1];
  if (!(pullbackHigh > priorLow)) return { ok: false, reason: 'no_pullback_short' };
  if (!(last < pullbackHigh)) return { ok: false, reason: 'pullback_no_bounce' };
  if (last < priorLow) return { ok: false, reason: 'chasing_low' };
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
const LOOP_INTERVAL_MS     = 4_000;           // scan every 4 seconds
const TRADE_COOLDOWN_MS    = 60_000;          // 1 min global cooldown between scalp opens
const SYMBOL_POST_CLOSE_COOLDOWN_MS = 75_000; // per-symbol after close (30–120s band)
const LOSS_STREAK_PAUSE_MS = 30 * 60_000;     // 30 min pause after 5 consecutive losses
const LOSS_STREAK_COUNT    = 5;               // losses in a row before pause
const MAX_POSITIONS        = 3;               // max concurrent scalp trades
const NOTIONAL_FRAC        = 0.08;            // 8% of balance per trade notional
const MIN_EMA_SPREAD_PCT   = 0.00025;         // EMA9/21 must be at least ~0.025% apart
const MIN_RSI_LONG         = 50;              // RSI must be above this for LONG
const MAX_RSI_SHORT        = 50;              // RSI must be below this for SHORT
const MAX_RSI_LONG_ENTRY   = 70;              // overextension — no LONG if RSI above this
const MIN_RSI_SHORT_ENTRY  = 30;              // overextension — no SHORT if RSI below this
const MAX_STRETCH_FROM_EMA = 0.0025;          // max |price-ema21|/ema21 for entry (0.25%)
const MIN_MOM_LOOKBACK     = 5;
const MIN_MOM_PCT          = 0.000105;        // min |Δprice|/price over lookback (~30% relaxed vs prior)
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
const ATR_PERIOD_SCALP     = 14;
const ATR_STOP_MULT        = 1.25;
const SL_MIN_PCT           = 0.0025;          // 0.25% floor on stop distance
const SL_MAX_PCT           = 0.005;           // 0.50% cap
const SL_TIGHTEN_MULT      = 0.9;             // slightly tighter stop vs raw ATR clamp
const TP_RR                = 2.2;             // baseline RR on SL distance
const TP_MIN_R_MULT        = 1.5;             // TP distance >= this × SL distance

// Entry quality — acceleration, pullback, noise, score, sizing
const ACCEL_BLOCK_N        = 5;
const ACCEL_EPS            = 0.08;            // recent block must exceed prior by ~8%
const PULLBACK_W           = 20;
const NOISE_K              = 28;
const MICRO_NOISE_FLOOR    = 5e-7;
const FLIP_MAX             = 14;
const CONSISTENCY_MIN      = 0.08;
const ENTRY_SCORE_MIN      = 35;
const SCORE_SIZE_MIN       = 0.45;            // size scale at minimum qualifying score

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

  private minBufferTicksFor(symbol: string): number {
    const ent = this.ohlcvCache.get(symbol);
    if (ent && ent.bars.length >= HTF_MIN_5M_BARS * 5) return MIN_BUFFER_TICKS;
    return MIN_BUFFER_TICKS_COLD;
  }

  constructor(portfolio: PortfolioManager, ws: WebSocketManager) {
    this.portfolio = portfolio;
    this.ws        = ws;

    const snap = StateStore.load(ENGINE_ID);
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
    this.scheduleLoop();
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

  /** Cached 1m bars + pseudo-5m EMA trend; network refresh rate-limited in DataLayer.getScalpContext1m. */
  private async ensureScalpMarketContext(symbol: string): Promise<ScalpMarketContext | null> {
    try {
      const bars = await DataLayer.getScalpContext1m(symbol, OHLCV_FETCH_LIMIT);
      if (bars.length < HTF_MIN_5M_BARS * 5) return null;
      this.ohlcvCache.set(symbol, { bars, fetchedAt: Date.now() });
      const flags = htfTrendFlags(bars);
      if (flags == null) return null;
      return {
        ohlcv: bars,
        allowsLong: flags.allowsLong,
        allowsShort: flags.allowsShort,
        htfSpreadPct: flags.htfSpreadPct,
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
  private monitorPositions(): void {
    for (let i = this.activePositions.length - 1; i >= 0; i--) {
      const pos   = this.activePositions[i];
      const price = this.ws.getLatestPrice(pos.symbol);
      if (price == null) continue;

      this.applyMark(pos, price);

      let closeReason: string | null = null;
      if (pos.side === 'LONG') {
        if (price <= pos.stopLoss)  closeReason = 'SL';
        if (price >= pos.takeProfit) closeReason = 'TP';
      } else {
        if (price >= pos.stopLoss)  closeReason = 'SL';
        if (price <= pos.takeProfit) closeReason = 'TP';
      }

      if (closeReason) this.closePosition(i, price, closeReason);
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

      const entry = this.evaluateEntry(symbol, prices, ctx);

      if (!entry.ok) {
        this.addLog(`SKIP ${symbol} cause=${entry.reason}`);
        continue;
      }

      const price = this.ws.getLatestPrice(symbol)!;
      this.openTrade(symbol, price, entry.side, entry.reason, ctx.ohlcv, {
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
    const volPack = tickReturnVolatility(prices, VOL_SHORT_RETURNS, VOL_LONG_RETURNS);
    const volShort = volPack?.shortVol ?? 0;
    const last = prices[prices.length - 1];

    // ── STRUCTURE layer (1m candles) ───────────────────────────────────────
    const candles = ctx.ohlcv;
    const closes = candles.map((c) => c.close);
    if (closes.length < 30) return { ok: false, reason: 'structure_insufficient' };

    const cEma9 = computeEMA(closes, 9);
    const cEma21 = computeEMA(closes, 21);
    const cRsi = computeRSI(closes, 7);
    if (cRsi == null) return { ok: false, reason: 'rsi_insufficient' };
    const prevClose = closes[closes.length - 2];
    const candleMom = prevClose > 0 ? (closes[closes.length - 1] - prevClose) / prevClose : 0;

    let structureBias: 'LONG' | 'SHORT' | null = null;
    if (cEma9 > cEma21 && cRsi > 50 && candleMom > 0) structureBias = 'LONG';
    else if (cEma9 < cEma21 && cRsi < 50 && candleMom < 0) structureBias = 'SHORT';

    console.log(
      `[SCALP][STRUCTURE] ${symbol} ${structureBias ?? 'NONE'} ` +
        `ema=${cEma9.toFixed(4)}/${cEma21.toFixed(4)} rsi=${cRsi.toFixed(1)} mom=${(candleMom * 100).toFixed(3)}%`
    );

    if (structureBias == null) {
      return {
        ok: false,
        reason: `no_signal(structure ema=${cEma9 > cEma21 ? 'bull' : 'bear'} rsi=${cRsi.toFixed(1)} mom=${(candleMom * 100).toFixed(3)}%)`,
      };
    }

    // ── TRIGGER layer (ticks) ──────────────────────────────────────────────
    if (prices.length < 2) return { ok: false, reason: 'trigger_insufficient' };
    const t = prices;
    const a = t[t.length - 1];
    const b = t[t.length - 2];
    const microTrendUp = a > b;
    const microTrendDown = a < b;

    if (structureBias === 'LONG' && !microTrendUp) {
      return { ok: false, reason: 'trigger_not_confirmed_long' };
    }
    if (structureBias === 'SHORT' && !microTrendDown) {
      return { ok: false, reason: 'trigger_not_confirmed_short' };
    }
    const triggerConfirmed = structureBias === 'LONG' ? microTrendUp : microTrendDown;
    console.log(
      `[SCALP][TRIGGER] ${symbol} ${
        structureBias === 'LONG' ? 'micro_up_confirmed' : 'micro_down_confirmed'
      }`
    );

    // Soft filters / penalties
    const spread = Math.abs(cEma9 - cEma21) / Math.max(Math.abs(cEma21), 1e-12);
    let penalty = 0;
    if (spread < MIN_EMA_SPREAD_PCT) penalty += 6;
    if (structureBias === 'LONG' && !ctx.allowsLong) penalty += 10;
    if (structureBias === 'SHORT' && !ctx.allowsShort) penalty += 10;

    const returns = lastKReturns(prices, NOISE_K);
    if (returns.length > 0) {
      const signedSum = returns.reduce((s, r) => s + (Math.abs(r) > MICRO_NOISE_FLOOR ? Math.sign(r) : 0), 0);
      const consistency = Math.abs(signedSum) / returns.length;
      if (consistency < CONSISTENCY_MIN) penalty += 5;
    }

    const accelRatio = 1 + Math.min(Math.abs(candleMom) / Math.max(MIN_MOM_PCT, 1e-12), 1);
    let score = entryQualityScore({
      accelRatio,
      volShort,
      tickSpread: spread,
      htfSpreadPct: ctx.htfSpreadPct,
      last,
      ema21: cEma21,
    });
    score = Math.max(0, Math.round(score - penalty));
    if (structureBias != null && triggerConfirmed) {
      score = Math.min(100, score + 5);
    }

    const hasTrigger = triggerConfirmed;
    const overrideAllowed = structureBias != null && hasTrigger && score >= ENTRY_SCORE_MIN;
    if (score < ENTRY_SCORE_MIN && !overrideAllowed) {
      return { ok: false, reason: `score_below_${ENTRY_SCORE_MIN}(${score})` };
    }

    console.log(`[SCALP][ENTRY] ${symbol} ${structureBias} score=${score}`);
    return {
      ok: true,
      side: structureBias,
      score,
      momentumStrength: Math.abs(candleMom),
      volShort,
      reason: `${structureBias} structure+trigger score=${score} penalty=${penalty}`,
    };
  }

  // ── Trade execution ───────────────────────────────────────────────────────

  private openTrade(
    symbol: string,
    price: number,
    side: 'LONG' | 'SHORT',
    signalReason: string,
    ohlcv: OHLCV[],
    entryQuality: { score: number; momentumStrength: number; volShort: number }
  ): void {
    const atr = computeATR(ohlcv, ATR_PERIOD_SCALP);
    if (atr == null || atr <= 0) {
      this.addLog(`SKIP ${symbol} ${side} cause=atr_unavailable`);
      return;
    }

    const balance  = this.portfolio.getBalance();
    const scale    = scoreToNotionalScale(entryQuality.score);
    const notional = balance * NOTIONAL_FRAC * scale;
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

    const riskReward = tpDist / slDist;

    // Portfolio gate — synchronous check + register (atomic in Node.js)
    const allocation = this.portfolio.requestCapital(ENGINE_ID, symbol, riskAmt);
    if (!allocation.approved) {
      this.addLog(`SKIP ${symbol} ${side} cause=${allocation.reason}`);
      return;
    }

    const tradeId = randomUUID();

    const position: Position = {
      tradeId,
      symbol,
      entryPrice:    price,
      currentPrice:  price,
      unrealizedPnl: 0,
      amount,
      side,
      stopLoss:      sl,
      takeProfit:    tp,
      timestamp:     Date.now(),
      initialStopDist: slDist,
      engineId:      ENGINE_ID,
    };

    const trade: TradeLog = {
      id:         tradeId,
      symbol,
      side,
      entryPrice: price,
      amount,
      status:     'OPEN',
      timestamp:  Date.now(),
      source:     'scalp',
      scalpEntryQuality: {
        score: entryQuality.score,
        momentumStrength: entryQuality.momentumStrength,
        volShort: entryQuality.volShort,
      },
      scalpRiskReward: {
        slDistance: slDist,
        tpDistance: tpDist,
        riskReward,
      },
    };

    // Register with portfolio (synchronous — no await between requestCapital and here)
    this.portfolio.registerTrade(ENGINE_ID, tradeId, symbol, riskAmt);

    this.activePositions.push(position);
    this.tradeHistory.push(trade);
    this.lastTradeOpenedAt = Date.now();

    this.persistState();
    this.addLog(
      `OPEN ${side} ${symbol} @ ${price.toFixed(4)} ` +
      `SL=${sl.toFixed(4)} TP=${tp.toFixed(4)} ` +
      `slDist=${slDist.toFixed(6)} tpDist=${tpDist.toFixed(6)} R:R=${riskReward.toFixed(2)} ` +
      `size=${notional.toFixed(2)}$ scale=${scale.toFixed(2)} ` +
      `score=${entryQuality.score} momStr=${entryQuality.momentumStrength.toExponential(2)} ` +
      `volShort=${entryQuality.volShort.toExponential(2)} | ${signalReason}`
    );
  }

  private closePosition(index: number, price: number, reason: string): void {
    const pos = this.activePositions[index];

    const grossPnl = pos.side === 'LONG'
      ? (price - pos.entryPrice) * pos.amount
      : (pos.entryPrice - price) * pos.amount;

    const { entryFee, exitFee } = entryExitFees(pos.entryPrice, price, pos.amount);
    const netPnl = grossPnl - entryFee - exitFee;

    // Update trade log
    const trade = this.tradeHistory.find(t => t.id === pos.tradeId);
    if (trade) {
      trade.exitPrice     = price;
      trade.grossPnl      = grossPnl;
      trade.entryFee      = entryFee;
      trade.exitFee       = exitFee;
      trade.netPnl        = netPnl;
      trade.pnl           = netPnl;
      trade.status        = 'CLOSED';
      trade.exitTimestamp = Date.now();
    }

    // Portfolio: remove from risk registry and credit net PnL to shared balance
    this.portfolio.closeTrade(pos.tradeId, netPnl);

    this.activePositions.splice(index, 1);
    this.symbolLastClosedAt.set(pos.symbol, Date.now());

    this.addLog(
      `CLOSE ${pos.symbol} @ ${price.toFixed(4)} (${reason}) ` +
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
    StateStore.save(ENGINE_ID, {
      tradeHistory:        this.tradeHistory,
      activePositions:     this.activePositions,
      lossStreakPauseUntil: this.lossStreakPauseUntil > Date.now()
        ? this.lossStreakPauseUntil
        : undefined,
    });
  }

  private addLog(msg: string): void {
    const time  = new Date().toLocaleTimeString();
    const entry = `[${time}][SCALP] ${msg}`;
    this.logs.push(entry);
    if (this.logs.length > 100) this.logs.shift();
    console.log(entry);
  }
}
