/**
 * WebSocketManager — real-time price feeds via Binance miniTicker streams.
 *
 * Uses the native WebSocket global (Node.js 22+ / tsconfig lib: DOM).
 * Maintains a rolling price buffer per symbol.
 * Auto-reconnects with exponential backoff.
 */

const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws';
const BUFFER_SIZE      = 300;  // 5 min of 1s ticks at miniTicker rate
const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

interface MiniTickerMsg {
  e: string;  // event type: '24hrMiniTicker'
  s: string;  // symbol e.g. 'BTCUSDT'
  c: string;  // close (last) price
}

interface SymbolState {
  buffer: number[];
  ws: WebSocket | null;
  reconnectDelay: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export class WebSocketManager {
  private static instance: WebSocketManager | null = null;
  private symbols = new Map<string, SymbolState>();

  private constructor() {}

  static getInstance(): WebSocketManager {
    if (!this.instance) this.instance = new WebSocketManager();
    return this.instance;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Subscribe to a symbol's miniTicker stream.
   * Optionally seed the buffer with historical prices from REST bootstrap.
   */
  subscribe(symbol: string, seedPrices?: number[]): void {
    if (this.symbols.has(symbol)) return;

    const state: SymbolState = {
      buffer: seedPrices ? seedPrices.slice(-BUFFER_SIZE) : [],
      ws: null,
      reconnectDelay: MIN_RECONNECT_MS,
      reconnectTimer: null,
    };
    this.symbols.set(symbol, state);
    this.connect(symbol);
  }

  unsubscribe(symbol: string): void {
    const state = this.symbols.get(symbol);
    if (!state) return;
    if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
    if (state.ws) {
      // Prevent reconnect loop by removing state before close fires
      this.symbols.delete(symbol);
      try { state.ws.close(); } catch { /* ignore */ }
    } else {
      this.symbols.delete(symbol);
    }
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
}
