import React, { memo, useEffect, useRef, useState } from "react";
import axios from "axios";
import {
  createChart,
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { API_BASE_URL } from "../../config";
import type { ScalpSnapshot } from "./ScalpDashboard";

/** Default panel symbols when scalp watchlist is not loaded yet. */
export const WATCHLIST_PANEL_DEFAULT = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "STOUSDT",
  "USDCUSDT",
] as const;

type OhlcvRow = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

const OHLCV_INTERVAL = "5m";
const OHLCV_LIMIT = 80;
const POLL_MS = 8000;
const MINI_CHART_HEIGHT = 104;

type ScalpLite = Pick<
  ScalpSnapshot,
  "currentPrice" | "decision" | "entryScore" | "skipReason"
>;

function decisionStyles(d: ScalpSnapshot["decision"]) {
  if (d === "BUY") return "text-emerald-400/90";
  if (d === "SELL") return "text-rose-400/90";
  return "text-white/35";
}

/** Green/red candles (bull / bear), same palette as `LiveChart.tsx`. */
const WatchlistMiniCandleChart = memo(function WatchlistMiniCandleChart({
  candles,
}: {
  candles: OhlcvRow[] | undefined;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastSigRef = useRef("");

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgba(255,255,255,0.35)",
        fontSize: 10,
        /** Cleaner cards; ensure NOTICE/license is satisfied elsewhere if required. */
        attributionLogo: false,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: "rgba(255,255,255,0.06)" },
      },
      width: el.clientWidth,
      height: MINI_CHART_HEIGHT,
      crosshair: { mode: CrosshairMode.Hidden },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: {
        borderVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
        tickMarkFormatter: () => "",
      },
      handleScroll: false,
      handleScale: false,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
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
    const c = candles;
    const s = seriesRef.current;
    if (!s || !c?.length) return;
    const last = c[c.length - 1];
    const sig = `${c.length}|${last.time}|${last.open}|${last.high}|${last.low}|${last.close}`;
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;
    s.setData(
      c.map((row) => ({
        time: row.time as UTCTimestamp,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
      }))
    );
  }, [candles]);

  return (
    <div
      ref={containerRef}
      className="w-full min-h-[104px] pointer-events-none"
      aria-hidden
    />
  );
});

const WatchlistSymbolCard = memo(function WatchlistSymbolCard({
  symbol,
  candles,
  selected,
  onSelect,
  scalp,
}: {
  symbol: string;
  candles: OhlcvRow[] | undefined;
  selected: boolean;
  onSelect: (sym: string) => void;
  scalp: ScalpLite | null;
}) {
  const price =
    scalp?.currentPrice != null && Number.isFinite(scalp.currentPrice)
      ? scalp.currentPrice
      : candles?.length
        ? candles[candles.length - 1].close
        : null;

  const decision = scalp?.decision ?? "SKIP";
  const score = scalp?.entryScore;

  return (
    <button
      type="button"
      onClick={() => onSelect(symbol)}
      className={[
        "w-full text-left rounded-xl border transition-colors",
        "bg-white/[0.03] border-white/10 hover:border-white/20",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/25",
        selected ? "border-white/35 ring-1 ring-white/20" : "",
      ].join(" ")}
    >
      <div className="px-3 pt-3 pb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-xs font-semibold text-white tracking-wide truncate">
            {symbol}
          </div>
          <div className="font-mono text-sm text-white/90 tabular-nums mt-0.5">
            {price != null ? price.toFixed(price >= 100 ? 2 : 4) : "—"}
          </div>
        </div>
        <div className="shrink-0 text-right space-y-0.5">
          <div
            className={`text-[10px] font-bold uppercase tracking-widest ${decisionStyles(decision)}`}
          >
            {decision}
          </div>
          {score != null && (
            <div className="text-[10px] font-mono text-white/40">sc {score}</div>
          )}
        </div>
      </div>
      <div className="px-1 pb-2">
        {candles?.length ? (
          <WatchlistMiniCandleChart candles={candles} />
        ) : (
          <div
            className="h-[104px] flex items-center justify-center text-[10px] uppercase tracking-widest text-white/25"
          >
            Loading…
          </div>
        )}
      </div>
    </button>
  );
});

export interface WatchlistChartsProps {
  /** Symbols to show; prefer engine watchlist from parent when available. */
  symbols: string[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
}

export const WatchlistCharts: React.FC<WatchlistChartsProps> = ({
  symbols,
  selectedSymbol,
  onSelectSymbol,
}) => {
  const [ohlcvMap, setOhlcvMap] = useState<Record<string, OhlcvRow[]>>({});
  const [scalpMap, setScalpMap] = useState<Record<string, ScalpLite | null>>({});

  const key = symbols.slice().sort().join(",");

  useEffect(() => {
    if (!symbols.length) return;

    let cancelled = false;

    const pull = async () => {
      const ohlcvResults = await Promise.all(
        symbols.map(async (sym) => {
          try {
            const res = await axios.get<OhlcvRow[]>(
              `${API_BASE_URL}/api/ohlcv/${sym}?interval=${OHLCV_INTERVAL}&limit=${OHLCV_LIMIT}`
            );
            return [sym, res.data] as const;
          } catch {
            return [sym, [] as OhlcvRow[]] as const;
          }
        })
      );

      const scalpResults = await Promise.all(
        symbols.map(async (sym) => {
          try {
            const res = await axios.get<ScalpSnapshot>(
              `${API_BASE_URL}/api/scalp/status?symbol=${encodeURIComponent(sym)}`
            );
            const d = res.data;
            const lite: ScalpLite = {
              currentPrice: d.currentPrice,
              decision: d.decision,
              entryScore: d.entryScore,
              skipReason: d.skipReason,
            };
            return [sym, lite] as const;
          } catch {
            return [sym, null] as const;
          }
        })
      );

      if (cancelled) return;

      setOhlcvMap((prev) => {
        const next = { ...prev };
        for (const [sym, rows] of ohlcvResults) {
          if (rows.length) next[sym] = rows;
        }
        return next;
      });

      setScalpMap((prev) => {
        const next = { ...prev };
        for (const [sym, lite] of scalpResults) {
          next[sym] = lite;
        }
        return next;
      });
    };

    void pull();
    const id = window.setInterval(pull, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [key]);

  if (!symbols.length) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs sm:text-sm font-bold uppercase tracking-widest text-white/90">
          Watchlist
        </h2>
        <span className="text-[10px] uppercase tracking-widest text-white/35">{OHLCV_INTERVAL}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4">
        {symbols.map((sym) => (
          <WatchlistSymbolCard
            key={sym}
            symbol={sym}
            candles={ohlcvMap[sym]}
            selected={selectedSymbol === sym}
            onSelect={onSelectSymbol}
            scalp={scalpMap[sym] ?? null}
          />
        ))}
      </div>
    </section>
  );
};
