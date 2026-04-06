/**
 * Tick-only regime label for watchlist cards (no REST / OHLCV).
 * Heuristic: low volatility → VOL LOW, high flip ratio → NOISE, else TREND.
 */
export type WatchlistStatusLabel = "NOISE" | "TREND" | "VOL LOW";

export function classifyWatchlistTicks(prices: number[]): WatchlistStatusLabel {
  if (prices.length < 15) return "VOL LOW";
  const rets: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const p0 = prices[i - 1];
    if (p0 <= 0) continue;
    rets.push((prices[i] - p0) / p0);
  }
  if (rets.length < 10) return "VOL LOW";
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / rets.length;
  const v = Math.sqrt(variance);
  if (!Number.isFinite(v) || v < 8e-6) return "VOL LOW";
  let flips = 0;
  for (let i = 1; i < rets.length; i++) {
    if (rets[i] * rets[i - 1] < 0) flips++;
  }
  const flipRatio = flips / Math.max(1, rets.length - 1);
  if (flipRatio > 0.42) return "NOISE";
  return "TREND";
}
