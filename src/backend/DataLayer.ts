import axios from 'axios';

export interface OHLCV {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const KLINE_CACHE = new Map<string, { bars: OHLCV[]; updatedAt: number }>();

/** High-level HTF closes mirror (updated when 1m klines refresh). */
const HTF_CACHE = new Map<string, { data: number[]; lastUpdated: number }>();

/** Static liquid USDT pairs — replaces /api/v3/ticker/24hr (high weight). */
const STATIC_USDT_UNIVERSE = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'ADAUSDT',
  'DOGEUSDT',
  'LINKUSDT',
] as const;

/**
 * REST-minimal Binance access: cached klines, ban-aware, WebSocket-first elsewhere.
 */
export class DataLayer {
  private static BASE_URL = 'https://api.binance.com/api/v3';
  private static bannedUntilMs = 0;
  /** When true, last kline attempt failed or ban left us REST-less. */
  private static wsOnlyRestMode = false;

  private static cacheKey(symbol: string, interval: string, limit: number): string {
    return `${symbol.toUpperCase()}|${interval}|${limit}`;
  }

  static isRestBanned(): boolean {
    return Date.now() < this.bannedUntilMs;
  }

  static getBanRemainingSec(): number {
    return Math.max(0, Math.ceil((this.bannedUntilMs - Date.now()) / 1000));
  }

  private static applyBan(status: number, headers: Record<string, unknown> | undefined): void {
    if (status !== 418 && status !== 429) return;
    const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
    const retryAfter = parseInt(String(raw ?? '60'), 10);
    this.bannedUntilMs = Date.now() + Math.min(Math.max(retryAfter, 10), 600) * 1000;
    console.warn(`[Data] REST paused due to ban (${status}) ~${retryAfter}s`);
    this.wsOnlyRestMode = true;
    console.warn('[Data] WS-only mode active — using caches + live sockets');
  }

  /**
   * Scalp / swing symbol list without ticker/24hr.
   */
  static getStaticScalpWatchlist(limit: number): string[] {
    const n = Math.max(1, Math.min(limit, STATIC_USDT_UNIVERSE.length));
    return [...STATIC_USDT_UNIVERSE.slice(0, n)];
  }

  /**
   * @deprecated No network — use {@link getStaticScalpWatchlist}. Kept for callers expecting Promise.
   */
  static async fetchTopCoins(limit: number = 10): Promise<string[]> {
    console.log('[Data] Static watchlist (no /api/v3/ticker/24hr)');
    return this.getStaticScalpWatchlist(limit);
  }

  /**
   * Cached klines: serves fresh data until TTL; if banned or fetch fails, returns last good bars.
   * @param ttlMs min time between network refreshes (e.g. 120_000 for HTF)
   */
  static async getKlines(symbol: string, interval: string, limit: number, ttlMs: number): Promise<OHLCV[]> {
    const sym = symbol.toUpperCase();
    const key = this.cacheKey(sym, interval, limit);
    const now = Date.now();
    const ent = KLINE_CACHE.get(key);

    if (ent && now - ent.updatedAt < ttlMs && ent.bars.length > 0) {
      return ent.bars;
    }

    if (this.isRestBanned()) {
      if (ent?.bars.length) {
        console.log(`[Data] Using cached HTF (${sym} ${interval}) — REST paused due to ban`);
        return ent.bars;
      }
      console.log(`[Data] REST paused due to ban — no cache for ${sym} ${interval}`);
      this.wsOnlyRestMode = true;
      return [];
    }

    const fresh = await this.fetchKlinesNetwork(sym, interval, limit);
    if (fresh.length > 0) {
      KLINE_CACHE.set(key, { bars: fresh, updatedAt: now });
      if (interval === '1m') {
        HTF_CACHE.set(sym, {
          data: fresh.map((b) => b.close),
          lastUpdated: now,
        });
      }
      if (this.wsOnlyRestMode) {
        this.wsOnlyRestMode = false;
        console.log('[Data] REST usable again after ban/cooldown');
      }
      return fresh;
    }

    if (ent?.bars.length) {
      console.log(`[Data] Using cached HTF (${sym} ${interval}) — network empty or error`);
      return ent.bars;
    }
    return [];
  }

  /** Default chart/insights: 3 min TTL to limit weight. */
  static async fetchOHLCV(symbol: string, interval: string = '5m', limit: number = 100): Promise<OHLCV[]> {
    return this.getKlines(symbol, interval, limit, 180_000);
  }

  private static async fetchKlinesNetwork(
    symbol: string,
    interval: string,
    limit: number
  ): Promise<OHLCV[]> {
    if (this.isRestBanned()) return [];
    try {
      const response = await axios.get(`${this.BASE_URL}/klines`, {
        params: { symbol, interval, limit },
        timeout: 20_000,
      });

      return (response.data as any[]).map((k: any) => ({
        time: k[0] / 1000,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
    } catch (error: any) {
      const status = error?.response?.status;
      const headers = error?.response?.headers as Record<string, unknown> | undefined;
      if (status === 418 || status === 429) {
        this.applyBan(status, headers);
      } else {
        console.error(`[Data] klines error ${symbol} ${interval}:`, error?.message ?? error);
      }
      return [];
    }
  }

  /** Scalp 1m context: refresh at most every 2 minutes. */
  static async getScalpContext1m(symbol: string, limit: number): Promise<OHLCV[]> {
    return this.getKlines(symbol, '1m', limit, 120_000);
  }

  /** Swing scan 15m — refresh at most every 5 minutes per symbol. */
  static async getSwingScan15m(symbol: string, limit: number = 100): Promise<OHLCV[]> {
    return this.getKlines(symbol, '15m', limit, 300_000);
  }

  /** Mark price fallback (swing) — low frequency. */
  static async getLast1mClose(symbol: string): Promise<number | null> {
    const rows = await this.getKlines(symbol, '1m', 1, 60_000);
    const c = rows[rows.length - 1]?.close;
    return typeof c === 'number' && Number.isFinite(c) ? c : null;
  }

  static getHtfCloses(symbol: string): { data: number[]; lastUpdated: number } | null {
    return HTF_CACHE.get(symbol.toUpperCase()) ?? null;
  }

  static async fetchOHLCVRange(
    symbol: string,
    interval: string,
    startTimeMs: number,
    endTimeMs: number
  ): Promise<OHLCV[]> {
    if (this.isRestBanned()) {
      console.log('[Data] REST paused due to ban — fetchOHLCVRange skipped');
      return [];
    }
    const mapRow = (k: any) => ({
      time: k[0] / 1000,
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    });

    const byTime = new Map<number, OHLCV>();
    let cursor = startTimeMs;

    try {
      while (cursor < endTimeMs) {
        if (this.isRestBanned()) {
          console.log('[Data] REST paused during range fetch — partial data');
          break;
        }
        const response = await axios.get(`${this.BASE_URL}/klines`, {
          params: {
            symbol: symbol.toUpperCase(),
            interval,
            startTime: cursor,
            endTime: endTimeMs,
            limit: 1000,
          },
          timeout: 20_000,
        });

        const rows = response.data as any[];
        if (!rows.length) break;

        for (const k of rows) {
          const o = mapRow(k);
          const tms = o.time * 1000;
          if (tms >= startTimeMs && tms <= endTimeMs) {
            byTime.set(o.time, o);
          }
        }

        const lastOpen = rows[rows.length - 1][0] as number;
        cursor = lastOpen + 1;
        if (rows.length < 1000) break;
      }
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 418 || status === 429) {
        this.applyBan(status, error?.response?.headers);
      } else {
        console.error(`[Data] range error for ${symbol}:`, error?.message ?? error);
      }
    }

    return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  }
}
