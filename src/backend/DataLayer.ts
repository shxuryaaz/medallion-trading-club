import axios from 'axios';

export interface OHLCV {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class DataLayer {
  private static BASE_URL = 'https://api.binance.com/api/v3';
  private static bannedUntilMs = 0;

  static async fetchOHLCV(symbol: string, interval: string = '5m', limit: number = 100): Promise<OHLCV[]> {
    if (Date.now() < this.bannedUntilMs) {
      const secsLeft = Math.ceil((this.bannedUntilMs - Date.now()) / 1000);
      console.log(`[DataLayer] Still banned. Skipping fetch. ${secsLeft}s remaining.`);
      return [];
    }
    try {
      const response = await axios.get(`${this.BASE_URL}/klines`, {
        params: {
          symbol: symbol.toUpperCase(),
          interval,
          limit
        }
      });

      return response.data.map((k: any) => ({
        time: k[0] / 1000,
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5])
      }));
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 418 || status === 429) {
        const retryAfter = parseInt(error?.response?.headers?.['retry-after'] ?? '60', 10);
        this.bannedUntilMs = Date.now() + retryAfter * 1000;
        console.error(`[DataLayer] Binance banned us (${status}). Pausing all fetches for ${retryAfter}s.`);
      } else {
        console.error(`Error fetching data for ${symbol}:`, error);
      }
      return [];
    }
  }

  static async fetchOHLCVRange(
    symbol: string,
    interval: string,
    startTimeMs: number,
    endTimeMs: number
  ): Promise<OHLCV[]> {
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
        const response = await axios.get(`${this.BASE_URL}/klines`, {
          params: {
            symbol: symbol.toUpperCase(),
            interval,
            startTime: cursor,
            endTime: endTimeMs,
            limit: 1000,
          },
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
    } catch (error) {
      console.error(`Error fetching range for ${symbol}:`, error);
    }

    return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  }

  static async fetchTopCoins(limit: number = 10): Promise<string[]> {
    try {
      const response = await axios.get(`${this.BASE_URL}/ticker/24hr`);
      const tickers = response.data
        .filter((t: any) => t.symbol.endsWith('USDT'))
        .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, limit)
        .map((t: any) => t.symbol);
      return tickers;
    } catch (error) {
      console.error('Error fetching top coins:', error);
      return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
    }
  }
}
