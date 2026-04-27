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
  executedQty: number;
}

export interface BinanceUserTrade {
  id: number;
  orderId: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  quoteQty: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  time: number;
  buyer: boolean;
  maker: boolean;
  positionSide: string;
}

function parseNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : 0;
}

function parseOrderResult(data: Record<string, unknown>): OrderResult | null {
  const orderId = Number(data.orderId);
  let executedQty = parseNumber(data.executedQty);
  let avgPrice = parseNumber(data.avgPrice);

  if (avgPrice <= 0) {
    avgPrice = parseNumber(data.price);
  }

  const cumQuote = parseNumber(data.cumQuote);
  if (avgPrice <= 0 && executedQty > 0 && cumQuote > 0) {
    avgPrice = cumQuote / executedQty;
  }

  const fills = Array.isArray(data.fills) ? data.fills : [];
  if ((avgPrice <= 0 || executedQty <= 0) && fills.length > 0) {
    let fillQty = 0;
    let fillQuote = 0;
    for (const raw of fills) {
      if (typeof raw !== 'object' || raw === null) continue;
      const fill = raw as Record<string, unknown>;
      const qty = parseNumber(fill.qty ?? fill.quantity);
      const price = parseNumber(fill.price);
      if (qty <= 0 || price <= 0) continue;
      fillQty += qty;
      fillQuote += qty * price;
    }
    if (fillQty > 0) {
      executedQty = executedQty > 0 ? executedQty : fillQty;
      avgPrice = avgPrice > 0 ? avgPrice : fillQuote / fillQty;
    }
  }

  if (!Number.isFinite(orderId) || orderId <= 0 || executedQty <= 0 || avgPrice <= 0) {
    return null;
  }
  return { orderId, avgPrice, executedQty };
}

function parseUserTrade(raw: Record<string, unknown>): BinanceUserTrade | null {
  const id = Number(raw.id);
  const orderId = Number(raw.orderId);
  const symbol = String(raw.symbol ?? '');
  const sideRaw = String(raw.side ?? '');
  const side = sideRaw === 'BUY' || sideRaw === 'SELL' ? sideRaw : null;
  const price = parseNumber(raw.price);
  const qty = parseNumber(raw.qty);
  const quoteQty = parseNumber(raw.quoteQty);
  const realizedPnl = parseNumber(raw.realizedPnl);
  const commission = parseNumber(raw.commission);
  const time = Number(raw.time);

  if (
    !Number.isFinite(id) ||
    !Number.isFinite(orderId) ||
    !symbol ||
    side == null ||
    price <= 0 ||
    qty <= 0 ||
    !Number.isFinite(time)
  ) {
    return null;
  }

  return {
    id,
    orderId,
    symbol,
    side,
    price,
    qty,
    quoteQty,
    realizedPnl,
    commission,
    commissionAsset: String(raw.commissionAsset ?? ''),
    time,
    buyer: Boolean(raw.buyer),
    maker: Boolean(raw.maker),
    positionSide: String(raw.positionSide ?? 'BOTH'),
  };
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
   * Returns confirmed fill details on success, null on failure.
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
        newOrderRespType: 'RESULT',
      }) as Record<string, unknown>;

      const result = parseOrderResult(data);
      if (!result) {
        console.error(`[BinanceClient] placeMarketOrder: invalid fill response for ${symbol}`);
        return null;
      }
      console.log(
        `[BinanceClient] OPEN ${side} ${symbol} qty=${result.executedQty} orderId=${result.orderId} avgPrice=${result.avgPrice}`
      );
      return result;
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
   * Returns confirmed fill details on success, null on failure.
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
        newOrderRespType: 'RESULT',
      }) as Record<string, unknown>;

      const result = parseOrderResult(data);
      if (!result) {
        console.error(`[BinanceClient] closePosition: invalid fill response for ${symbol}`);
        return null;
      }
      console.log(
        `[BinanceClient] CLOSE ${side} ${symbol} qty=${result.executedQty} orderId=${result.orderId} avgPrice=${result.avgPrice}`
      );
      return result;
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
   * Fetch recent account fills from Binance USDT-M Futures.
   * This is raw exchange history: it can recover fills/PnL/fees, but not bot-only
   * fields such as strategy reason, planned SL/TP, or R unless those were logged locally.
   */
  async getRecentUserTrades(params: {
    symbol: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<BinanceUserTrade[]> {
    if (!this.enabled) return [];

    const limit = Math.min(1000, Math.max(1, params.limit ?? 100));
    const req: Record<string, string | number> = {
      symbol: params.symbol.toUpperCase(),
      limit,
    };
    if (typeof params.startTime === 'number' && Number.isFinite(params.startTime)) {
      req.startTime = Math.floor(params.startTime);
    }
    if (typeof params.endTime === 'number' && Number.isFinite(params.endTime)) {
      req.endTime = Math.floor(params.endTime);
    }

    try {
      const data = await this.signedGet('/fapi/v1/userTrades', req);
      if (!Array.isArray(data)) return [];
      return data
        .map((row) => (typeof row === 'object' && row !== null ? parseUserTrade(row as Record<string, unknown>) : null))
        .filter((row): row is BinanceUserTrade => row !== null)
        .sort((a, b) => b.time - a.time);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data as Record<string, unknown>)?.msg ?? err.message
        : String(err);
      console.error(`[BinanceClient] getRecentUserTrades failed ${params.symbol}: ${msg}`);
      return [];
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
