import axios from 'axios';
import crypto from 'crypto';

// ── Binance USDT-M Futures endpoints ─────────────────────────────────────────
// Testnet migrated from testnet.binancefuture.com to demo-fapi.binance.com (2025/2026)
const TESTNET_BASE = 'https://demo-fapi.binance.com';
const LIVE_BASE    = 'https://fapi.binance.com';

// Quantity decimal precision per symbol (base asset, rounded DOWN to avoid over-sell)
const QUANTITY_PRECISION: Record<string, number> = {
  BTCUSDT:  3,
  ETHUSDT:  3,
  BNBUSDT:  2,
  SOLUSDT:  0,
  XRPUSDT:  0,
  DOGEUSDT: 0,
  AVAXUSDT: 1,
  LINKUSDT: 1,
  PEPEUSDT: 0,
  STOUSDT:  0,
  USDCUSDT: 0,
};

function roundQty(qty: number, symbol: string): number {
  const precision = QUANTITY_PRECISION[symbol] ?? 3;
  const factor = Math.pow(10, precision);
  return Math.floor(qty * factor) / factor;
}

function buildSignature(params: Record<string, string | number>, secret: string): string {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

// ── BinanceClient ─────────────────────────────────────────────────────────────

export interface OrderResult {
  orderId: number;
  avgPrice: number;
}

export class BinanceClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly enabled: boolean;
  private readonly isTestnet: boolean;

  constructor() {
    this.apiKey    = process.env.BINANCE_API_KEY    ?? '';
    this.apiSecret = process.env.BINANCE_API_SECRET ?? '';
    this.isTestnet = process.env.BINANCE_TESTNET !== 'false'; // default true (safe)
    this.baseUrl   = this.isTestnet ? TESTNET_BASE : LIVE_BASE;
    this.enabled   =
      process.env.BINANCE_ENABLED === 'true' &&
      this.apiKey.length > 0 &&
      this.apiSecret.length > 0;

    if (this.enabled) {
      console.log(
        `[BinanceClient] Live trading ENABLED — ${this.isTestnet ? 'TESTNET ⚠️' : 'LIVE 🔴'}`
      );
    } else {
      console.log('[BinanceClient] Paper trading mode (BINANCE_ENABLED not set or keys missing)');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ── Signed HTTP helpers ───────────────────────────────────────────────────

  private async signedPost(
    path: string,
    params: Record<string, string | number>
  ): Promise<unknown> {
    const allParams = { ...params, timestamp: Date.now(), recvWindow: 60000 };
    const signature = buildSignature(allParams, this.apiSecret);
    const body = new URLSearchParams(
      Object.entries({ ...allParams, signature }).map(([k, v]) => [k, String(v)])
    ).toString();

    const res = await axios.post(`${this.baseUrl}${path}`, body, {
      headers: {
        'X-MBX-APIKEY': this.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10_000,
    });
    return res.data;
  }

  private async signedGet(
    path: string,
    params: Record<string, string | number> = {}
  ): Promise<unknown> {
    const allParams = { ...params, timestamp: Date.now(), recvWindow: 60000 };
    const signature = buildSignature(allParams, this.apiSecret);
    const query = new URLSearchParams(
      Object.entries({ ...allParams, signature }).map(([k, v]) => [k, String(v)])
    ).toString();

    const res = await axios.get(`${this.baseUrl}${path}?${query}`, {
      headers: { 'X-MBX-APIKEY': this.apiKey },
      timeout: 10_000,
    });
    return res.data;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Place a market entry order.
   * Returns orderId + avgPrice on success, null on failure (system stays in paper mode).
   */
  async placeMarketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number
  ): Promise<OrderResult | null> {
    if (!this.enabled) return null;

    const qty = roundQty(quantity, symbol);
    if (qty <= 0) {
      console.error(`[BinanceClient] placeMarketOrder: zero qty after rounding for ${symbol} (raw=${quantity})`);
      return null;
    }

    try {
      const data = await this.signedPost('/fapi/v1/order', {
        symbol,
        side,
        type: 'MARKET',
        quantity: String(qty),
      }) as Record<string, unknown>;

      const orderId  = Number(data.orderId);
      const avgPrice = parseFloat(String(data.avgPrice ?? data.price ?? '0'));
      console.log(
        `[BinanceClient] OPEN ${side} ${symbol} qty=${qty} orderId=${orderId} avgPrice=${avgPrice}`
      );
      return { orderId, avgPrice };
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data as Record<string, unknown>)?.msg ?? err.message
        : String(err);
      console.error(`[BinanceClient] placeMarketOrder failed ${symbol}: ${msg}`);
      return null;
    }
  }

  /**
   * Close an existing position with a reduceOnly market order.
   * Returns fill price on success, null on failure (caller falls back to last known price).
   */
  async closePosition(
    symbol: string,
    side: 'LONG' | 'SHORT',
    quantity: number
  ): Promise<OrderResult | null> {
    if (!this.enabled) return null;

    const closeSide: 'BUY' | 'SELL' = side === 'LONG' ? 'SELL' : 'BUY';
    const qty = roundQty(quantity, symbol);
    if (qty <= 0) return null;

    try {
      const data = await this.signedPost('/fapi/v1/order', {
        symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: String(qty),
        reduceOnly: 'true',
      }) as Record<string, unknown>;

      const orderId  = Number(data.orderId);
      const avgPrice = parseFloat(String(data.avgPrice ?? data.price ?? '0'));
      console.log(
        `[BinanceClient] CLOSE ${side} ${symbol} qty=${qty} orderId=${orderId} avgPrice=${avgPrice}`
      );
      return { orderId, avgPrice };
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data as Record<string, unknown>)?.msg ?? err.message
        : String(err);
      console.error(`[BinanceClient] closePosition failed ${symbol}: ${msg}`);
      return null;
    }
  }

  /**
   * Fetch available USDT balance from the futures account.
   * Returns null on failure — caller keeps the existing local balance.
   */
  async getUsdtBalance(): Promise<number | null> {
    if (!this.enabled) return null;

    try {
      const data = await this.signedGet('/fapi/v2/account') as Record<string, unknown>;
      // totalMarginBalance = wallet balance + unrealized PnL — true account equity
      const balance = parseFloat(String(data.totalMarginBalance));
      console.log(`[BinanceClient] Fetched USDT equity: ${balance.toFixed(2)}`);
      return balance;
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data as Record<string, unknown>)?.msg ?? err.message
        : String(err);
      console.error(`[BinanceClient] getUsdtBalance failed: ${msg}`);
      return null;
    }
  }

  /**
   * Fetch the current funding rate for a symbol from /fapi/v1/premiumIndex.
   * Returns null on failure. Caller should cache the result (30-min TTL is typical).
   */
  async getFundingRate(symbol: string): Promise<number | null> {
    if (!this.enabled) return null;

    try {
      const data = await this.signedGet('/fapi/v1/premiumIndex', { symbol }) as Record<string, unknown>;
      const rate = parseFloat(String(data.lastFundingRate ?? data.fundingRate ?? ''));
      if (!Number.isFinite(rate)) return null;
      return rate;
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data as Record<string, unknown>)?.msg ?? err.message
        : String(err);
      console.error(`[BinanceClient] getFundingRate failed ${symbol}: ${msg}`);
      return null;
    }
  }

  /**
   * Set leverage for a symbol before first trade.
   * Silently skips on failure — default exchange leverage will be used.
   */
  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (!this.enabled) return;

    try {
      await this.signedPost('/fapi/v1/leverage', { symbol, leverage });
      console.log(`[BinanceClient] Set leverage ${leverage}x for ${symbol}`);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data as Record<string, unknown>)?.msg ?? err.message
        : String(err);
      console.error(`[BinanceClient] setLeverage failed ${symbol}: ${msg}`);
    }
  }
}

// Singleton — imported by both engines and TradingSystem
export const exchange = new BinanceClient();
