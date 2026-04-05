import { OHLCV } from './DataLayer';

export interface Signal {
  score: number; // 0 to 100
  reason: string;
}

export class TrendAgent {
  static analyze(data: OHLCV[]): Signal {
    if (data.length < 50) return { score: 50, reason: 'Insufficient data' };

    const closes = data.map(d => d.close);
    const ema20 = this.calculateEMA(closes, 20);
    const ema50 = this.calculateEMA(closes, 50);

    const lastEma20 = ema20[ema20.length - 1];
    const lastEma50 = ema50[ema50.length - 1];
    const lastClose = closes[closes.length - 1];

    let score = 50;
    let reason = 'Neutral trend';

    if (lastEma20 > lastEma50 && lastClose > lastEma20) {
      score = 80;
      reason = 'Strong bullish trend (EMA20 > EMA50)';
    } else if (lastEma20 < lastEma50 && lastClose < lastEma20) {
      score = 20;
      reason = 'Strong bearish trend (EMA20 < EMA50)';
    }

    return { score, reason };
  }

  private static calculateEMA(data: number[], period: number): number[] {
    const k = 2 / (period + 1);
    let ema = [data[0]];
    for (let i = 1; i < data.length; i++) {
      ema.push(data[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
  }
}

export class MomentumAgent {
  static analyze(data: OHLCV[]): Signal {
    if (data.length < 14) return { score: 50, reason: 'Insufficient data' };

    const rsi = this.calculateRSI(data.map(d => d.close), 14);
    const lastRsi = rsi[rsi.length - 1];

    let score = 50;
    let reason = 'Neutral momentum';

    // Trend-following: reward RSI strength in trend direction, don't penalize overbought/oversold
    if (lastRsi > 70) {
      score = 80;
      reason = 'Very strong bullish momentum (RSI > 70)';
    } else if (lastRsi > 60) {
      score = 75;
      reason = 'Strong bullish momentum (RSI > 60)';
    } else if (lastRsi > 50) {
      score = 60;
      reason = 'Moderate bullish momentum (RSI > 50)';
    } else if (lastRsi > 40) {
      score = 40;
      reason = 'Moderate bearish momentum (RSI < 50)';
    } else if (lastRsi > 30) {
      score = 25;
      reason = 'Strong bearish momentum (RSI < 40)';
    } else {
      score = 20;
      reason = 'Very strong bearish momentum (RSI < 30)';
    }

    return { score, reason };
  }

  /** Full RSI series (Wilder smoothing); last value matches `analyze()`. */
  static rsiSeries(closes: number[], period: number = 14): number[] {
    return this.calculateRSI(closes, period);
  }

  private static rsiFromAverages(avgGain: number, avgLoss: number): number {
    if (!Number.isFinite(avgGain) || !Number.isFinite(avgLoss)) return 50;
    if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
    const rs = avgGain / avgLoss;
    if (!Number.isFinite(rs) || rs < 0) return 50;
    const rsi = 100 - 100 / (1 + rs);
    if (!Number.isFinite(rsi)) return 50;
    return Math.min(100, Math.max(0, rsi));
  }

  private static calculateRSI(closes: number[], period: number): number[] {
    const gains: number[] = [];
    const losses: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      gains.push(diff > 0 ? diff : 0);
      losses.push(diff < 0 ? -diff : 0);
    }

    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

    const rsi: number[] = [this.rsiFromAverages(avgGain, avgLoss)];

    for (let i = period; i < gains.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
      rsi.push(this.rsiFromAverages(avgGain, avgLoss));
    }

    return rsi;
  }
}

export class PullbackAgent {
  static analyze(data: OHLCV[]): Signal {
    if (data.length < 20) return { score: 50, reason: 'Insufficient data' };

    const closes = data.map(d => d.close);
    const ema20 = this.calculateEMA(closes, 20);
    const lastClose = closes[closes.length - 1];
    const lastEma20 = ema20[ema20.length - 1];

    const distance = (lastClose - lastEma20) / lastEma20;

    let score = 50;
    let reason = 'No pullback detected';

    if (distance > 0 && distance < 0.01) {
      score = 75;
      reason = 'Bullish pullback to EMA20';
    } else if (distance < 0 && distance > -0.01) {
      score = 25;
      reason = 'Bearish pullback to EMA20';
    }

    return { score, reason };
  }

  private static calculateEMA(data: number[], period: number): number[] {
    const k = 2 / (period + 1);
    let ema = [data[0]];
    for (let i = 1; i < data.length; i++) {
      ema.push(data[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
  }
}
