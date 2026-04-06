import { Signal, TrendAgent, MomentumAgent, PullbackAgent } from './Agents';
import { OHLCV } from './DataLayer';
import { OpenAIService, type AiSecondOpinion } from './ai/OpenAIService';

/** ATR period and multiples for stop / take-profit (volatility-scaled). */
const ATR_PERIOD = 14;
const ATR_STOP_MULT = 2;
const ATR_TP_MULT = 3;
export const RISK_PER_TRADE = 0.01;
const MIN_STOP_DISTANCE_FRAC = 1e-6;

export function computeATR(data: OHLCV[], period: number = ATR_PERIOD): number | null {
  if (data.length < period + 1) return null;

  const tr: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const high = data[i].high;
    const low = data[i].low;
    const prevClose = data[i - 1].close;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

const MIN_ATR_TO_PRICE = 0.00025;
const MIN_EMA_SPREAD_TO_PRICE = 0.0004; // was 0.0008 — allow early-stage trends

/** Skip if ATR% or EMA spread is weak (choppy / low conviction). */
const LOW_REGIME_ATR_PCT = 0.00045;
const LOW_REGIME_EMA_SPREAD = 0.0004; // was 0.0008 — allow moderate EMA separation

/** If atr/price is below this (but still passes MIN_ATR), use half risk budget. */
export const LOW_ATR_HALVE_RISK_PCT = 0.00032;

/** Inclusive neutral band — no directional trade. */
const SCORE_NEUTRAL_LOW = 40; // was 35
const SCORE_NEUTRAL_HIGH = 60; // was 65

/** Strong long only if score > this. */
const SCORE_STRONG_LONG_MIN = 62; // was 68 — allow moderate bullish signals
/** Strong short only if score < this. */
const SCORE_STRONG_SHORT_MAX = 38; // was 32 — allow moderate bearish signals

type EntryScoreClass =
  | { kind: 'neutral' }
  | { kind: 'weak_long' }
  | { kind: 'weak_short' }
  | { kind: 'strong'; side: 'LONG' | 'SHORT' };

function classifyEntryScore(finalScore: number): EntryScoreClass {
  if (finalScore >= SCORE_NEUTRAL_LOW && finalScore <= SCORE_NEUTRAL_HIGH) {
    return { kind: 'neutral' };
  }
  if (finalScore > SCORE_NEUTRAL_HIGH && finalScore <= SCORE_STRONG_LONG_MIN) {
    return { kind: 'weak_long' };
  }
  if (finalScore >= SCORE_STRONG_SHORT_MAX && finalScore < SCORE_NEUTRAL_LOW) {
    return { kind: 'weak_short' };
  }
  if (finalScore > SCORE_STRONG_LONG_MIN) {
    return { kind: 'strong', side: 'LONG' };
  }
  return { kind: 'strong', side: 'SHORT' };
}

const OVEREXTENDED_ATR_MULT = 2.0;
const BREAKOUT_LOOKBACK = 3;
const RSI_LONG_MIN = 55;
const RSI_SHORT_MAX = 45;

type EntryTimingFail = {
  ok: false;
  reason: string;
  skipCause:
    | 'entry_timing'
    | 'trend_not_accelerating'
    | 'no_breakout'
    | 'overextended_move'
    | 'weak_trend_persistence'
    | 'breakout_not_sustained'
    | 'weak_candle_close';
};

function longBreakoutAtBar(data: OHLCV[], barIndex: number, pad: number): boolean {
  if (barIndex < BREAKOUT_LOOKBACK + 1) return false;
  const from = barIndex - BREAKOUT_LOOKBACK - 1;
  const to = barIndex - 2;
  const px = data[barIndex].close;
  let maxHigh = data[from].high;
  for (let i = from + 1; i <= to; i++) {
    maxHigh = Math.max(maxHigh, data[i].high);
  }
  return px > maxHigh + pad;
}

function shortBreakoutAtBar(data: OHLCV[], barIndex: number, pad: number): boolean {
  if (barIndex < BREAKOUT_LOOKBACK + 1) return false;
  const from = barIndex - BREAKOUT_LOOKBACK - 1;
  const to = barIndex - 2;
  const px = data[barIndex].close;
  let minLow = data[from].low;
  for (let i = from + 1; i <= to; i++) {
    minLow = Math.min(minLow, data[i].low);
  }
  return px < minLow - pad;
}

type EntryTimingOk = { ok: true; scorePenalty: number; timingTags: string[] };

function entryTimingGates(data: OHLCV[], side: 'LONG' | 'SHORT'): EntryTimingOk | EntryTimingFail {
  let scorePenalty = 0;
  const timingTags: string[] = [];

  if (data.length < 55) {
    return {
      ok: false,
      reason: 'insufficient_bars_for_entry_timing',
      skipCause: 'entry_timing',
    };
  }

  const closes = data.map((d) => d.close);
  const e20 = emaSeries(closes, 20);
  const e50 = emaSeries(closes, 50);
  const n = e20.length;
  const ema20Now = e20[n - 1];
  const ema20Prev = e20[n - 2];
  const ema50Now = e50[n - 1];
  const ema50Prev = e50[n - 2];
  const price = closes[closes.length - 1];
  const prev = data[data.length - 2];

  for (let k = 0; k < 3; k++) {
    const i = n - 1 - k;
    if (side === 'LONG') {
      if (e20[i] <= e50[i]) {
        return {
          ok: false,
          reason: `long_ema20_not_above_ema50_for_3_bars_at_offset_${k}`,
          skipCause: 'weak_trend_persistence',
        };
      }
    } else if (e20[i] >= e50[i]) {
      return {
        ok: false,
        reason: `short_ema20_not_below_ema50_for_3_bars_at_offset_${k}`,
        skipCause: 'weak_trend_persistence',
      };
    }
  }

  const slope = e20[n - 1] - e20[n - 3];
  if (side === 'LONG') {
    if (slope <= 0) {
      return {
        ok: false,
        reason: 'long_ema20_slope_not_positive',
        skipCause: 'trend_not_accelerating',
      };
    }
  } else {
    if (slope >= 0) {
      return {
        ok: false,
        reason: 'short_ema20_slope_not_negative',
        skipCause: 'trend_not_accelerating',
      };
    }
  }

  const atr = computeATR(data);
  const lastIdx = data.length - 1;
  const prevIdx = data.length - 2;

  // 0.3% tolerance: allow entry when close is within 0.3% of the breakout level
  // 0.1% (~$67 on BTC) was too tight for 15m candles — increased to ~$200
  const brkPad = price * 0.003;

  if (side === 'LONG') {
    if (!longBreakoutAtBar(data, lastIdx, -brkPad)) {
      return {
        ok: false,
        reason: 'long_close_not_above_prior_3_highs',
        skipCause: 'no_breakout',
      };
    }
    if (!longBreakoutAtBar(data, prevIdx, -brkPad)) {
      return {
        ok: false,
        reason: 'long_breakout_not_sustained_prev_candle',
        skipCause: 'breakout_not_sustained',
      };
    }
  } else {
    if (!shortBreakoutAtBar(data, lastIdx, -brkPad)) {
      return {
        ok: false,
        reason: 'short_close_not_below_prior_3_lows',
        skipCause: 'no_breakout',
      };
    }
    if (!shortBreakoutAtBar(data, prevIdx, -brkPad)) {
      return {
        ok: false,
        reason: 'short_breakout_not_sustained_prev_candle',
        skipCause: 'breakout_not_sustained',
      };
    }
  }

  if (atr != null && atr > 0) {
    const dist = Math.abs(price - ema20Now);
    if (dist > OVEREXTENDED_ATR_MULT * atr) {
      return {
        ok: false,
        reason: 'price_overextended_vs_ema20',
        skipCause: 'overextended_move',
      };
    }
  }

  if (side === 'LONG') {
    if (price <= ema20Now) {
      return { ok: false, reason: 'long_price_not_above_ema20', skipCause: 'entry_timing' };
    }
    if (ema20Now <= ema20Prev) {
      return { ok: false, reason: 'long_ema20_not_rising', skipCause: 'entry_timing' };
    }
    if (ema50Now <= ema50Prev) {
      return { ok: false, reason: 'long_ema50_not_rising', skipCause: 'entry_timing' };
    }
    if (prev.close <= prev.open) {
      scorePenalty += 5;
      timingTags.push('long_prev_candle_not_bullish');
    }
  } else {
    if (price >= ema20Now) {
      return { ok: false, reason: 'short_price_not_below_ema20', skipCause: 'entry_timing' };
    }
    if (ema20Now >= ema20Prev) {
      return { ok: false, reason: 'short_ema20_not_falling', skipCause: 'entry_timing' };
    }
    if (ema50Now >= ema50Prev) {
      return { ok: false, reason: 'short_ema50_not_falling', skipCause: 'entry_timing' };
    }
    if (prev.close >= prev.open) {
      scorePenalty += 5;
      timingTags.push('short_prev_candle_not_bearish');
    }
  }

  const cur = data[data.length - 1];
  const candleRange = cur.high - cur.low;
  if (side === 'LONG') {
    if (cur.close < cur.low + 0.7 * candleRange) {
      return { ok: false, reason: 'weak_candle_close', skipCause: 'weak_candle_close' };
    }
  } else if (cur.close > cur.low + 0.3 * candleRange) {
    return { ok: false, reason: 'weak_candle_close', skipCause: 'weak_candle_close' };
  }

  const rsi = MomentumAgent.rsiSeries(closes, 14);
  if (rsi.length < 2) {
    return { ok: false, reason: 'rsi_insufficient', skipCause: 'entry_timing' };
  }
  const rNow = rsi[rsi.length - 1];
  const rPrev = rsi[rsi.length - 2];

  if (side === 'LONG') {
    if (rNow <= RSI_LONG_MIN || rNow <= rPrev) {
      return {
        ok: false,
        reason: 'long_rsi_not_above_55_or_not_rising',
        skipCause: 'entry_timing',
      };
    }
  } else {
    if (rNow >= RSI_SHORT_MAX || rNow >= rPrev) {
      return {
        ok: false,
        reason: 'short_rsi_not_below_45_or_not_falling',
        skipCause: 'entry_timing',
      };
    }
  }

  return { ok: true, scorePenalty, timingTags };
}

export function analyzeMarketForTrading(data: OHLCV[]): {
  ok: boolean;
  reason: string;
  atr: number | null;
  atrPct: number;
  emaSpreadPct: number;
} {
  const close = data[data.length - 1]?.close ?? 0;
  if (data.length < 55 || close <= 0) {
    return { ok: true, reason: '', atr: null, atrPct: 0, emaSpreadPct: 0 };
  }

  const atr = computeATR(data);
  const atrPct = atr != null && atr > 0 ? atr / close : 0;
  const closes = data.map((d) => d.close);
  const e20 = emaSeries(closes, 20);
  const e50 = emaSeries(closes, 50);
  const ema20 = e20[e20.length - 1];
  const ema50 = e50[e50.length - 1];
  const emaSpreadPct = Math.abs(ema20 - ema50) / close;

  if (atr != null && atrPct > 0 && atrPct < MIN_ATR_TO_PRICE) {
    return { ok: false, reason: 'low_volatility', atr, atrPct, emaSpreadPct };
  }
  if (emaSpreadPct < MIN_EMA_SPREAD_TO_PRICE) {
    return { ok: false, reason: 'sideways_market', atr, atrPct, emaSpreadPct };
  }

  if (atrPct < LOW_REGIME_ATR_PCT || emaSpreadPct < LOW_REGIME_EMA_SPREAD) {
    return { ok: false, reason: 'low_regime', atr, atrPct, emaSpreadPct };
  }

  return { ok: true, reason: '', atr, atrPct, emaSpreadPct };
}

export interface AiEnrichmentContext {
  recentTrades: { symbol: string; side: string; pnl: number; outcome: 'win' | 'loss' | 'flat' }[];
  atr: number | null;
  atrPercentOfPrice: number;
  trendStrengthPercent: number;
}

export class ScoringEngine {
  static score(data: OHLCV[]): { finalScore: number; signals: { trend: Signal; momentum: Signal; pullback: Signal } } {
    const trend = TrendAgent.analyze(data);
    const momentum = MomentumAgent.analyze(data);
    const pullback = PullbackAgent.analyze(data);

    const finalScore = trend.score * 0.5 + momentum.score * 0.3 + pullback.score * 0.2;

    return {
      finalScore,
      signals: {
        trend,
        momentum,
        pullback,
      },
    };
  }

  static async evaluateTradeOpportunity(
    symbol: string,
    data: OHLCV[],
    enrichment?: AiEnrichmentContext
  ): Promise<{
    execute: boolean;
    side?: 'LONG' | 'SHORT';
    finalScore: number;
    signals: { trend: Signal; momentum: Signal; pullback: Signal };
    ai: AiSecondOpinion | null;
    reason: string;
    skipCause?: string;
  }> {
    const scored = ScoringEngine.score(data);
    const { finalScore, signals } = scored;
    const lastPrice = data[data.length - 1].close;

    const band = classifyEntryScore(finalScore);
    if (band.kind === 'neutral') {
      return {
        execute: false,
        finalScore,
        signals,
        ai: null,
        reason: `Score ${finalScore.toFixed(1)} in neutral band (${SCORE_NEUTRAL_LOW}–${SCORE_NEUTRAL_HIGH}); no directional signal`,
        skipCause: 'score_neutral',
      };
    }
    if (band.kind === 'weak_long') {
      return {
        execute: false,
        finalScore,
        signals,
        ai: null,
        reason: `Marginal long score ${finalScore.toFixed(1)} in (${SCORE_NEUTRAL_HIGH},${SCORE_STRONG_LONG_MIN}]; need >${SCORE_STRONG_LONG_MIN}`,
        skipCause: 'weak_signal_filtered',
      };
    }
    if (band.kind === 'weak_short') {
      return {
        execute: false,
        finalScore,
        signals,
        ai: null,
        reason: `Marginal short score ${finalScore.toFixed(1)} in [${SCORE_STRONG_SHORT_MAX},${SCORE_NEUTRAL_LOW}); need <${SCORE_STRONG_SHORT_MAX}`,
        skipCause: 'weak_signal_filtered',
      };
    }

    const side = band.side;
    const proposedAction: 'BUY' | 'SELL' = side === 'LONG' ? 'BUY' : 'SELL';

    const gates = entryTimingGates(data, side);
    if (gates.ok === false) {
      return {
        execute: false,
        side,
        finalScore,
        signals,
        ai: null,
        reason: `Entry timing: ${gates.reason}`,
        skipCause: gates.skipCause,
      };
    }

    const adjustedScore = finalScore - gates.scorePenalty;
    const bandAfter = classifyEntryScore(adjustedScore);
    if (bandAfter.kind !== 'strong' || bandAfter.side !== side) {
      const tagStr = gates.timingTags.length ? gates.timingTags.join(',') : 'penalty';
      return {
        execute: false,
        side,
        finalScore,
        signals,
        ai: null,
        reason: `Entry timing: ${tagStr} → score ${adjustedScore.toFixed(1)} (need strong ${side})`,
        skipCause: 'entry_timing',
      };
    }

    const ai = await OpenAIService.getSecondOpinion({
      symbol,
      lastPrice,
      finalScore: adjustedScore,
      signals,
      proposedAction,
      enrichment,
    });

    if (!ai) {
      return {
        execute: false,
        side: side ?? undefined,
        finalScore,
        signals,
        ai: null,
        reason: 'OpenAI unavailable or invalid response',
        skipCause: 'openai_unavailable',
      };
    }

    if (ai.confidence < 0.5) {
      return {
        execute: false,
        side: side ?? undefined,
        finalScore,
        signals,
        ai,
        reason: `AI confidence too low (${ai.confidence.toFixed(2)})`,
        skipCause: 'ai_low_confidence',
      };
    }

    const agrees =
      (side === 'LONG' && ai.decision === 'BUY') || (side === 'SHORT' && ai.decision === 'SELL');

    if (!agrees) {
      return {
        execute: false,
        side: side ?? undefined,
        finalScore,
        signals,
        ai,
        reason: `AI disagrees (got ${ai.decision}, need ${proposedAction})`,
        skipCause: 'ai_disagreement',
      };
    }

    const timingNote =
      gates.timingTags.length > 0 ? `[timing: ${gates.timingTags.join(',')}] ` : '';

    return {
      execute: true,
      side: side!,
      finalScore: adjustedScore,
      signals,
      ai,
      reason: timingNote + ai.reasoning,
    };
  }

  static evaluateNumericOnly(data: OHLCV[]): {
    execute: boolean;
    side?: 'LONG' | 'SHORT';
    finalScore: number;
    signals: { trend: Signal; momentum: Signal; pullback: Signal };
    reason: string;
    skipCause?: string;
  } {
    const scored = ScoringEngine.score(data);
    const { finalScore, signals } = scored;

    const band = classifyEntryScore(finalScore);
    if (band.kind === 'neutral') {
      return {
        execute: false,
        finalScore,
        signals,
        reason: `Score ${finalScore.toFixed(1)} in neutral band (${SCORE_NEUTRAL_LOW}–${SCORE_NEUTRAL_HIGH}); no directional signal`,
        skipCause: 'score_neutral',
      };
    }
    if (band.kind === 'weak_long') {
      return {
        execute: false,
        finalScore,
        signals,
        reason: `Marginal long score ${finalScore.toFixed(1)} in (${SCORE_NEUTRAL_HIGH},${SCORE_STRONG_LONG_MIN}]; need >${SCORE_STRONG_LONG_MIN}`,
        skipCause: 'weak_signal_filtered',
      };
    }
    if (band.kind === 'weak_short') {
      return {
        execute: false,
        finalScore,
        signals,
        reason: `Marginal short score ${finalScore.toFixed(1)} in [${SCORE_STRONG_SHORT_MAX},${SCORE_NEUTRAL_LOW}); need <${SCORE_STRONG_SHORT_MAX}`,
        skipCause: 'weak_signal_filtered',
      };
    }

    const side = band.side;
    const gates = entryTimingGates(data, side);
    if (gates.ok === false) {
      return {
        execute: false,
        side,
        finalScore,
        signals,
        reason: `Entry timing: ${gates.reason}`,
        skipCause: gates.skipCause,
      };
    }

    const adjustedScore = finalScore - gates.scorePenalty;
    const bandAfter = classifyEntryScore(adjustedScore);
    if (bandAfter.kind !== 'strong' || bandAfter.side !== side) {
      const tagStr = gates.timingTags.length ? gates.timingTags.join(',') : 'penalty';
      return {
        execute: false,
        side,
        finalScore,
        signals,
        reason: `Entry timing: ${tagStr} → score ${adjustedScore.toFixed(1)} (need strong ${side})`,
        skipCause: 'entry_timing',
      };
    }

    const timingNote =
      gates.timingTags.length > 0 ? `[timing: ${gates.timingTags.join(',')}] ` : '';

    return {
      execute: true,
      side,
      finalScore: adjustedScore,
      signals,
      reason:
        timingNote + (side === 'LONG' ? 'Numeric long signal' : 'Numeric short signal'),
    };
  }
}

export interface Position {
  tradeId: string;
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  amount: number;
  side: 'LONG' | 'SHORT';
  stopLoss: number;
  takeProfit: number;
  timestamp: number;
  initialStopDist: number; // ATR-based stop distance at entry, used for trailing stop logic
  engineId?: string; // 'swing' | 'scalp' — which engine owns this position
}

export class RiskAgent {
  static calculatePosition(
    balance: number,
    price: number,
    side: 'LONG' | 'SHORT',
    ohlcv: OHLCV[],
    riskDollarsBudget?: number
  ): Position | null {
    const atr = computeATR(ohlcv, ATR_PERIOD);
    if (atr == null || atr <= 0) return null;

    const stopDist = ATR_STOP_MULT * atr;
    const tpDist = ATR_TP_MULT * atr;

    const stopLoss = side === 'LONG' ? price - stopDist : price + stopDist;
    const takeProfit = side === 'LONG' ? price + tpDist : price - tpDist;

    const riskPerUnit = Math.abs(price - stopLoss);
    if (riskPerUnit < price * MIN_STOP_DISTANCE_FRAC) return null;

    const defaultRisk = balance * RISK_PER_TRADE;
    const riskDollars = Math.min(
      defaultRisk,
      typeof riskDollarsBudget === 'number' && Number.isFinite(riskDollarsBudget) && riskDollarsBudget > 0
        ? riskDollarsBudget
        : defaultRisk
    );
    if (riskDollars <= 0 || !Number.isFinite(riskDollars)) return null;

    const amount = riskDollars / riskPerUnit;

    return {
      tradeId: '',
      symbol: '',
      entryPrice: price,
      currentPrice: price,
      unrealizedPnl: 0,
      amount,
      side,
      stopLoss,
      takeProfit,
      timestamp: Date.now(),
      initialStopDist: stopDist,
    };
  }
}
