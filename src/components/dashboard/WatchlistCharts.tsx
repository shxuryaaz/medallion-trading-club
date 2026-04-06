import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { DEFAULT_WATCHLIST_PANEL_SYMBOLS } from "../../constants/watchlistPanel";

/** @deprecated Use DEFAULT_WATCHLIST_PANEL_SYMBOLS — kept for imports that expect this name. */
export const WATCHLIST_PANEL_DEFAULT = DEFAULT_WATCHLIST_PANEL_SYMBOLS;

const MINI_HEIGHT = 100;
const MAX_POINTS = 100;

export type WatchlistWsStatusLabel = "NOISE" | "TREND" | "VOL LOW";

export type WatchlistCardSignal = {
  decision: "BUY" | "SELL" | "SKIP";
  score: number;
  reason: string;
};

type WatchlistCardPayload = {
  symbol: string;
  prices: number[];
  lastPrice: number | null;
  connected: boolean;
  statusLabel: WatchlistWsStatusLabel;
  signal?: WatchlistCardSignal | null;
};

type WatchlistMessage = {
  type: "watchlist";
  t: number;
  cards: WatchlistCardPayload[];
};

function watchlistWsUrl(): string {
  if (typeof window === "undefined") return "";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/watchlist`;
}

function statusLabelClass(label: WatchlistWsStatusLabel): string {
  if (label === "NOISE") return "text-amber-400/90";
  if (label === "TREND") return "text-emerald-400/90";
  return "text-white/35";
}

function pricesToLineData(prices: number[]): { time: UTCTimestamp; value: number }[] {
  return prices.map((value, i) => ({
    time: (1_000_000 + i) as UTCTimestamp,
    value,
  }));
}

/** Avoid chart re-renders when only `signal` (or other card fields) change. */
function priceSeriesMemoEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  return a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
}

const WatchlistMiniLineChart = memo(
  function WatchlistMiniLineChart({ prices }: { prices: number[] }) {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const sigRef = useRef("");

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const chart = createChart(el, {
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: "rgba(255,255,255,0.3)",
          fontSize: 9,
          attributionLogo: false,
        },
        grid: {
          vertLines: { visible: false },
          horzLines: { color: "rgba(255,255,255,0.05)" },
        },
        width: el.clientWidth,
        height: MINI_HEIGHT,
        crosshair: { mode: CrosshairMode.Hidden },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
        timeScale: {
          visible: false,
          borderVisible: false,
        },
        handleScroll: false,
        handleScale: false,
      });

      const series = chart.addSeries(LineSeries, {
        color: "rgba(34,197,94,0.85)",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });

      chartRef.current = chart;
      seriesRef.current = series;

      const ro = new ResizeObserver(() => {
        if (!containerRef.current || !chartRef.current) return;
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      });
      ro.observe(el);

      return () => {
        ro.disconnect();
        chart.remove();
        chartRef.current = null;
        seriesRef.current = null;
      };
    }, []);

    useEffect(() => {
      const s = seriesRef.current;
      if (!s || prices.length === 0) return;
      const sig = `${prices.length}|${prices[0]}|${prices[prices.length - 1]}`;
      if (sig === sigRef.current) return;
      sigRef.current = sig;
      s.setData(pricesToLineData(prices));
    }, [prices]);

    return <div ref={containerRef} className="w-full min-h-[100px] pointer-events-none" aria-hidden />;
  },
  (prev, next) => priceSeriesMemoEqual(prev.prices, next.prices)
);

const WatchlistSymbolCard = memo(function WatchlistSymbolCard({
  card,
  selected,
  onSelect,
}: {
  card: WatchlistCardPayload;
  selected: boolean;
  onSelect: (sym: string) => void;
}) {
  const { symbol, prices, lastPrice, connected, statusLabel, signal } = card;
  const chartPrices = prices.length > MAX_POINTS ? prices.slice(-MAX_POINTS) : prices;
  const display =
    lastPrice != null && Number.isFinite(lastPrice)
      ? lastPrice
      : prices.length > 0
        ? prices[prices.length - 1]
        : null;

  const reasonTitle = signal?.reason ?? "";

  return (
    <button
      type="button"
      title={reasonTitle || undefined}
      onClick={() => onSelect(symbol)}
      className={[
        "w-full text-left rounded-xl border transition-colors",
        "bg-white/[0.03] border-white/10 hover:border-white/20",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25",
        selected ? "border-white/35 ring-1 ring-white/20" : "",
      ].join(" ")}
    >
      <div className="px-3 pt-3 pb-1 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-white tracking-wide truncate flex items-center gap-1.5">
            {symbol}
            {!connected && (
              <span className="text-[9px] font-normal uppercase text-white/25 shrink-0">off</span>
            )}
          </div>
          <div className="font-mono text-sm text-white/90 tabular-nums mt-0.5">
            {display != null ? (display >= 100 ? display.toFixed(2) : display.toFixed(4)) : "—"}
          </div>
          <div className="text-xs mt-1 font-mono">
            {signal ? (
              <>
                <span
                  className={
                    signal.decision === "BUY"
                      ? "text-green-400"
                      : signal.decision === "SELL"
                        ? "text-red-400"
                        : "text-neutral-500"
                  }
                >
                  {signal.decision}
                </span>
                <span className="ml-2 text-neutral-500">({signal.score})</span>
              </>
            ) : (
              <span className="text-neutral-600">No signal</span>
            )}
          </div>
        </div>
        <div
          className={`text-[10px] font-bold uppercase tracking-widest shrink-0 ${statusLabelClass(statusLabel)}`}
        >
          {statusLabel}
        </div>
      </div>
      <div className="px-1 pb-2">
        {prices.length >= 2 ? (
          <WatchlistMiniLineChart prices={chartPrices} />
        ) : (
          <div className="h-[100px] flex items-center justify-center text-[10px] uppercase tracking-widest text-white/25">
            Awaiting ticks…
          </div>
        )}
      </div>
    </button>
  );
});

export interface WatchlistChartsProps {
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
}

export const WatchlistCharts: React.FC<WatchlistChartsProps> = ({ selectedSymbol, onSelectSymbol }) => {
  const [cards, setCards] = useState<WatchlistCardPayload[]>(() =>
    [...DEFAULT_WATCHLIST_PANEL_SYMBOLS].map((symbol) => ({
      symbol,
      prices: [],
      lastPrice: null,
      connected: false,
      statusLabel: "VOL LOW" as const,
      signal: null,
    }))
  );
  const [streamOk, setStreamOk] = useState(false);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<WatchlistCardPayload[] | null>(null);

  const flushPending = useCallback(() => {
    rafRef.current = null;
    const p = pendingRef.current;
    if (!p) return;
    pendingRef.current = null;
    setCards(p);
  }, []);

  const scheduleCards = useCallback(
    (next: WatchlistCardPayload[]) => {
      pendingRef.current = next;
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(flushPending);
    },
    [flushPending]
  );

  useEffect(() => {
    const url = watchlistWsUrl();
    if (!url) return;

    let ws: WebSocket | null = null;
    let alive = true;

    const connect = () => {
      ws = new WebSocket(url);
      ws.onopen = () => {
        if (alive) setStreamOk(true);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string) as WatchlistMessage;
          if (msg.type !== "watchlist" || !Array.isArray(msg.cards)) return;
          scheduleCards(msg.cards);
        } catch {
          /* ignore */
        }
      };
      ws.onerror = () => {
        if (alive) setStreamOk(false);
      };
      ws.onclose = () => {
        if (alive) setStreamOk(false);
        if (alive) window.setTimeout(connect, 2000);
      };
    };

    connect();

    return () => {
      alive = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      ws?.close();
    };
  }, [scheduleCards]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs sm:text-sm font-bold uppercase tracking-widest text-white/90">Watchlist</h2>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-white/35">
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${streamOk ? "bg-emerald-400 animate-pulse" : "bg-white/25"}`}
          />
          <span>Live WS</span>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4">
        {cards.map((card) => (
          <WatchlistSymbolCard
            key={card.symbol}
            card={card}
            selected={selectedSymbol === card.symbol}
            onSelect={onSelectSymbol}
          />
        ))}
      </div>
    </section>
  );
};
