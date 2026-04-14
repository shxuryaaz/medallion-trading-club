/**
 * WebSocketManager — real-time price feeds + order flow via Binance streams.
 *
 * Subscribes per symbol to:
 *   1. miniTicker  — last price, feeds the rolling tick buffer used by ScalpingEngine
 *   2. aggTrade    — individual aggressor trades (buy vs sell volume) for CVD computation
 *
 * Uses the native WebSocket global (Node.js 22+ / tsconfig lib: DOM).
 * Auto-reconnects with exponential backoff.
 */

const BINANCE_WS_BASE  = 'wss://stream.binance.com:9443/ws';
const BUFFER_SIZE       = 300;   // 5 min of 1s ticks at miniTicker rate
const MIN_RECONNECT_MS  = 1_000;
const MAX_RECONNECT_MS  = 30_000;
/** Rolling window for CVD accumulation (2 minutes). */
const CVD_WINDOW_MS     = 120_000;

interface MiniTickerMsg {
  e: string;  // '24hrMiniTicker'
  s: string;  // 'BTCUSDT'
  c: string;  // last price
}

interface AggTradeMsg {
  e: string;  // 'aggTrade'
  s: string;  // symbol
  q: string;  // quantity (base asset)
  m: boolean; // true = buyer is maker (sell aggressor), false = buy aggressor
}

interface SymbolState {
  buffer: number[];
  ws: WebSocket | null;
  reconnectDelay: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

/** Rolling trade-flow entry stored per aggTrade tick. */
interface AggTradeEntry {
  ts: number;       // epoch ms
  buyVol: number;   // base qty if buy-aggressor, else 0
  sellVol: number;  // base qty if sell-aggressor, else 0
}

interface AggTradeState {
  entries: AggTradeEntry[];
  ws: WebSocket | null;
  reconnectDelay: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export class WebSocketManager {
  private static instance: WebSocketManager | null = null;
  private symbols   = new Map<string, SymbolState>();
  private aggTrades = new Map<string, AggTradeState>();

  private constructor() {}

  static getInstance(): WebSocketManager {
    if (!this.instance) this.instance = new WebSocketManager();
    return this.instance;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Subscribe to a symbol's miniTicker + aggTrade streams.
   * Optionally seed the price buffer with historical prices from REST bootstrap.
   */
  subscribe(symbol: string, seedPrices?: number[]): void {
    if (!this.symbols.has(symbol)) {
      const state: SymbolState = {
        buffer: seedPrices ? seedPrices.slice(-BUFFER_SIZE) : [],
        ws: null,
        reconnectDelay: MIN_RECONNECT_MS,
        reconnectTimer: null,
      };
      this.symbols.set(symbol, state);
      this.connect(symbol);
    }

    if (!this.aggTrades.has(symbol)) {
      const aggState: AggTradeState = {
        entries: [],
        ws: null,
        reconnectDelay: MIN_RECONNECT_MS,
        reconnectTimer: null,
      };
      this.aggTrades.set(symbol, aggState);
      this.connectAggTrade(symbol);
    }
  }

  unsubscribe(symbol: string): void {
    // miniTicker
    const state = this.symbols.get(symbol);
    if (state) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      this.symbols.delete(symbol);
      if (state.ws) try { state.ws.close(); } catch { /* ignore */ }
    }
    // aggTrade
    const aggState = this.aggTrades.get(symbol);
    if (aggState) {
      if (aggState.reconnectTimer) clearTimeout(aggState.reconnectTimer);
      this.aggTrades.delete(symbol);
      if (aggState.ws) try { aggState.ws.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Cumulative Volume Delta over the last `windowMs` milliseconds.
   * cvd > 0 → buy pressure dominates; cvd < 0 → sell pressure dominates.
   * Returns null if no aggTrade data is available for the symbol yet.
   */
  getCVD(symbol: string, windowMs = 30_000): { buyVol: number; sellVol: number; cvd: number } | null {
    const aggState = this.aggTrades.get(symbol);
    if (!aggState || aggState.entries.length === 0) return null;

    const cutoff = Date.now() - windowMs;
    let buyVol = 0;
    let sellVol = 0;
    for (const e of aggState.entries) {
      if (e.ts < cutoff) continue;
      buyVol  += e.buyVol;
      sellVol += e.sellVol;
    }
    return { buyVol, sellVol, cvd: buyVol - sellVol };
  }

  getLatestPrice(symbol: string): number | null {
    const buf = this.symbols.get(symbol)?.buffer;
    if (!buf || buf.length === 0) return null;
    return buf[buf.length - 1];
  }

  /**
   * Returns a copy of recent prices, oldest first.
   * limit defaults to the entire buffer.
   */
  getRecentPrices(symbol: string, limit?: number): number[] {
    const buf = this.symbols.get(symbol)?.buffer ?? [];
    return limit ? buf.slice(-limit) : buf.slice();
  }

  /**
   * Whether the buffer has enough ticks to compute indicators.
   * Requires at least 25 ticks (covers EMA21 + RSI7 comfortably).
   */
  isReady(symbol: string, minTicks = 25): boolean {
    return (this.symbols.get(symbol)?.buffer.length ?? 0) >= minTicks;
  }

  isConnected(symbol: string): boolean {
    return this.symbols.get(symbol)?.ws?.readyState === WebSocket.OPEN;
  }

  getConnectionStatus(): Record<string, { connected: boolean; bufferSize: number }> {
    const status: Record<string, { connected: boolean; bufferSize: number }> = {};
    for (const [sym, state] of this.symbols) {
      status[sym] = {
        connected: state.ws?.readyState === WebSocket.OPEN,
        bufferSize: state.buffer.length,
      };
    }
    return status;
  }

  // ── Connection management ─────────────────────────────────────────────────

  private connect(symbol: string): void {
    const state = this.symbols.get(symbol);
    if (!state) return;

    const url = `${BINANCE_WS_BASE}/${symbol.toLowerCase()}@miniTicker`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error(`[WS] Failed to construct socket for ${symbol}:`, e);
      this.scheduleReconnect(symbol);
      return;
    }

    state.ws = ws;

    ws.onopen = () => {
      console.log(`[WS] Connected: ${symbol} (buffer=${state.buffer.length})`);
      state.reconnectDelay = MIN_RECONNECT_MS; // reset backoff on success
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as MiniTickerMsg;
        if (msg.e === '24hrMiniTicker' && msg.c) {
          const price = parseFloat(msg.c);
          if (price > 0 && Number.isFinite(price)) {
            this.pushPrice(symbol, price);
          }
        }
      } catch {
        // Silently ignore malformed messages
      }
    };

    ws.onerror = (event: Event) => {
      // Log only; 'close' fires next and triggers reconnect
      console.error(`[WS] Error on ${symbol}:`, (event as ErrorEvent).message ?? 'unknown');
    };

    ws.onclose = () => {
      state.ws = null;
      // Only reconnect if we still want this symbol
      if (this.symbols.has(symbol)) {
        this.scheduleReconnect(symbol);
      }
    };
  }

  private scheduleReconnect(symbol: string): void {
    const state = this.symbols.get(symbol);
    if (!state) return;

    // Cancel any pending timer
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);

    const delay = state.reconnectDelay;
    // Exponential backoff, capped at MAX_RECONNECT_MS
    state.reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_MS);

    console.log(`[WS] Reconnecting ${symbol} in ${delay}ms`);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      this.connect(symbol);
    }, delay);
  }

  private pushPrice(symbol: string, price: number): void {
    const state = this.symbols.get(symbol);
    if (!state) return;
    state.buffer.push(price);
    if (state.buffer.length > BUFFER_SIZE) state.buffer.shift();
  }

  // ── aggTrade stream ───────────────────────────────────────────────────────

  private connectAggTrade(symbol: string): void {
    const aggState = this.aggTrades.get(symbol);
    if (!aggState) return;

    const url = `${BINANCE_WS_BASE}/${symbol.toLowerCase()}@aggTrade`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnectAggTrade(symbol);
      return;
    }

    aggState.ws = ws;

    ws.onopen = () => {
      aggState.reconnectDelay = MIN_RECONNECT_MS;
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as AggTradeMsg;
        if (msg.e !== 'aggTrade') return;
        const qty = parseFloat(msg.q);
        if (!Number.isFinite(qty) || qty <= 0) return;

        // m=false → buy aggressor (taker lifted the ask)
        // m=true  → sell aggressor (taker hit the bid)
        const entry: AggTradeEntry = {
          ts:      Date.now(),
          buyVol:  msg.m ? 0 : qty,
          sellVol: msg.m ? qty : 0,
        };
        aggState.entries.push(entry);

        // Evict entries older than CVD_WINDOW_MS (2× buffer to keep some history)
        const cutoff = Date.now() - CVD_WINDOW_MS;
        while (aggState.entries.length > 0 && aggState.entries[0].ts < cutoff) {
          aggState.entries.shift();
        }
      } catch {
        // ignore malformed
      }
    };

    ws.onerror = () => { /* close fires next */ };

    ws.onclose = () => {
      aggState.ws = null;
      if (this.aggTrades.has(symbol)) this.scheduleReconnectAggTrade(symbol);
    };
  }

  private scheduleReconnectAggTrade(symbol: string): void {
    const aggState = this.aggTrades.get(symbol);
    if (!aggState) return;
    if (aggState.reconnectTimer) clearTimeout(aggState.reconnectTimer);
    const delay = aggState.reconnectDelay;
    aggState.reconnectDelay = Math.min(delay * 2, MAX_RECONNECT_MS);
    aggState.reconnectTimer = setTimeout(() => {
      aggState.reconnectTimer = null;
      this.connectAggTrade(symbol);
    }, delay);
  }
}
