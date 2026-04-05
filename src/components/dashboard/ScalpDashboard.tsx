import React from "react";
import { format } from "date-fns";
import { Activity, Radio, TrendingDown, TrendingUp, Minus } from "lucide-react";

/** date-fns throws on invalid dates; API/persisted trades may omit or stringify ms. */
function safeFormatTime(ms: unknown, pattern = "HH:mm:ss"): string {
  const n = typeof ms === "string" ? Number(ms) : Number(ms);
  if (!Number.isFinite(n)) return "—";
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return format(d, pattern);
  } catch {
    return "—";
  }
}

export interface ScalpSnapshot {
  engineId: string;
  isRunning: boolean;
  watchlist: string[];
  wsStatus: Record<string, { connected: boolean; bufferSize: number }>;
  symbol: string;
  evaluatedAt: number;
  currentPrice: number | null;
  sparkline: number[];
  htfTrend: "up" | "down" | "flat" | "unknown";
  volShort: number | null;
  decision: "BUY" | "SELL" | "SKIP";
  skipReason?: string;
  entryScore?: number;
  momentumStrength?: number;
  executionNote?: string;
}

interface ScalpPerf {
  winRate: number;
  profitFactor: number | null;
  avgProfit: number;
  avgLoss: number;
  avgWinToAvgLoss: number | null;
  closedTrades: number;
  wins?: number;
  losses?: number;
}

interface ScalpDashboardProps {
  snapshot: ScalpSnapshot | null;
  performance: ScalpPerf | null;
  trades: any[];
  positions: any[];
}

function MiniSparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return (
      <div className="h-12 flex items-center justify-center text-[10px] text-white/30 uppercase tracking-widest">
        No ticks
      </div>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 200;
  const h = 48;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / span) * (h - 4) - 2;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} className="text-white/50" preserveAspectRatio="none">
      <polyline fill="none" stroke="currentColor" strokeWidth="1" points={pts} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function HtfIcon({ trend }: { trend: ScalpSnapshot["htfTrend"] }) {
  if (trend === "up") return <TrendingUp className="w-4 h-4 text-white" />;
  if (trend === "down") return <TrendingDown className="w-4 h-4 text-white" />;
  return <Minus className="w-4 h-4 text-white/50" />;
}

export const ScalpDashboard: React.FC<ScalpDashboardProps> = ({
  snapshot,
  performance,
  trades,
  positions,
}) => {
  const scalpTrades = trades.filter((t) => t.source === "scalp");

  const rowForTrade = (trade: any) => {
    const pos =
      trade.status === "OPEN"
        ? positions.find((p: any) => p.tradeId === trade.id && p.engineId === "scalp")
        : null;
    const cur =
      pos && typeof pos.currentPrice === "number" ? pos.currentPrice : trade.exitPrice ?? trade.entryPrice;
    const pnl =
      pos && typeof pos.unrealizedPnl === "number"
        ? pos.unrealizedPnl
        : typeof trade.pnl === "number"
          ? trade.pnl
          : null;
    const score = trade.scalpEntryQuality?.score;

    return (
      <tr key={trade.id} className="border-b border-white/[0.06] hover:bg-white/[0.02]">
        <td className="py-3 px-2 font-mono text-[10px] text-white/40">{safeFormatTime(trade.timestamp)}</td>
        <td className="py-3 px-2 font-medium text-xs">{trade.symbol}</td>
        <td className="py-3 px-2 font-mono text-xs">${trade.entryPrice?.toFixed(4) ?? "—"}</td>
        <td className="py-3 px-2 font-mono text-xs">${typeof cur === "number" ? cur.toFixed(4) : "—"}</td>
        <td className="py-3 px-2 font-mono text-xs">
          {pnl == null ? (
            "—"
          ) : pnl >= 0 ? (
            <span className="text-emerald-400">+{pnl.toFixed(2)}</span>
          ) : (
            <span className="text-red-400">{pnl.toFixed(2)}</span>
          )}
        </td>
        <td className="py-3 px-2 font-mono text-xs text-white/60">{score != null ? score : "—"}</td>
        <td className="py-3 px-2 text-[10px] uppercase text-white/30">{trade.status}</td>
      </tr>
    );
  };

  const sym = snapshot?.symbol ?? "—";
  const ws = snapshot?.wsStatus?.[sym];

  return (
    <div className="border border-white/10 rounded-xl bg-black overflow-hidden">
      <div className="px-4 md:px-6 py-4 border-b border-white/10 flex items-center gap-2">
        <Activity className="w-4 h-4 text-white/60" />
        <h2 className="text-xs md:text-sm font-bold uppercase tracking-widest">Scalping</h2>
      </div>

      <div className="p-4 md:p-6 space-y-6 md:space-y-8">
        {/* Section 1 — Live status */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-white/40 mb-3">Live status</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div className="border border-white/10 rounded-lg px-3 py-2.5">
              <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">Engine</div>
              <div className="font-mono">
                {snapshot?.isRunning ? (
                  <span className="text-white">Running</span>
                ) : (
                  <span className="text-white/50">Stopped</span>
                )}
              </div>
            </div>
            <div className="border border-white/10 rounded-lg px-3 py-2.5 sm:col-span-2">
              <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1">Watchlist</div>
              <div className="font-mono text-white/80 break-all">
                {snapshot?.watchlist?.length ? snapshot.watchlist.join(", ") : "—"}
              </div>
            </div>
            <div className="border border-white/10 rounded-lg px-3 py-2.5 sm:col-span-3">
              <div className="text-[10px] text-white/40 uppercase tracking-wider mb-1 flex items-center gap-1">
                <Radio className="w-3 h-3" /> WebSocket ({sym})
              </div>
              <div className="font-mono text-white/80">
                {ws ? (
                  <>
                    {ws.connected ? "Connected" : "Disconnected"} · buffer {ws.bufferSize} ticks
                  </>
                ) : (
                  "—"
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Section 2 — Signal insights */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-white/40 mb-3">Signal (selected symbol)</h3>
          {!snapshot ? (
            <div className="text-xs text-white/30">Loading…</div>
          ) : (
            <div className="border border-white/10 rounded-lg p-4 space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <div className="text-[10px] text-white/40 uppercase mb-1">Entry score</div>
                  <div className="text-lg font-mono text-white">
                    {snapshot.decision === "SKIP" ? "—" : snapshot.entryScore ?? "—"}
                    <span className="text-white/30 text-xs ml-1">/ 100</span>
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-white/40 uppercase mb-1">Momentum</div>
                  <div className="text-sm font-mono text-white/90 break-all">
                    {snapshot.momentumStrength != null ? snapshot.momentumStrength.toExponential(2) : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-white/40 uppercase mb-1">Vol (short)</div>
                  <div className="text-sm font-mono text-white/90 break-all">
                    {snapshot.volShort != null ? snapshot.volShort.toExponential(2) : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-white/40 uppercase mb-1">HTF trend</div>
                  <div className="flex items-center gap-2 text-sm text-white capitalize">
                    <HtfIcon trend={snapshot.htfTrend} />
                    {snapshot.htfTrend}
                  </div>
                </div>
              </div>
              <div className="pt-2 border-t border-white/10">
                <div className="text-[10px] text-white/40 uppercase mb-2">Decision</div>
                <div className="flex flex-wrap items-center gap-3">
                  {snapshot.decision === "BUY" && (
                    <span className="text-sm font-bold uppercase tracking-widest text-white">Buy</span>
                  )}
                  {snapshot.decision === "SELL" && (
                    <span className="text-sm font-bold uppercase tracking-widest text-white">Sell</span>
                  )}
                  {snapshot.decision === "SKIP" && (
                    <span className="text-sm font-bold uppercase tracking-widest text-white/60">Skip</span>
                  )}
                  {snapshot.decision === "SKIP" && snapshot.skipReason && (
                    <span className="text-xs font-mono text-white/50 break-all">{snapshot.skipReason}</span>
                  )}
                </div>
                {snapshot.executionNote && (
                  <div className="mt-2 text-[10px] font-mono text-white/40">
                    Execution: {snapshot.executionNote}
                  </div>
                )}
                <div className="mt-1 text-[10px] text-white/30 font-mono">
                  Evaluated {safeFormatTime(snapshot.evaluatedAt)}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Section 3 — Price + sparkline */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-white/40 mb-3">Live price</h3>
          <div className="border border-white/10 rounded-lg p-4">
            <div className="flex justify-between items-baseline mb-2">
              <span className="text-[10px] text-white/40 uppercase">{snapshot?.symbol ?? "—"}</span>
              <span className="text-xl font-mono text-white">
                {snapshot?.currentPrice != null ? snapshot.currentPrice.toFixed(4) : "—"}
              </span>
            </div>
            <MiniSparkline values={snapshot?.sparkline ?? []} />
          </div>
        </section>

        {/* Section 4 — Scalp trades */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-white/40 mb-3">Scalp trades</h3>
          <div className="border border-white/10 rounded-lg overflow-x-auto">
            <table className="w-full text-left text-xs min-w-[640px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-white/40 border-b border-white/10">
                  <th className="py-2 px-2 font-medium">Time</th>
                  <th className="py-2 px-2 font-medium">Symbol</th>
                  <th className="py-2 px-2 font-medium">Entry</th>
                  <th className="py-2 px-2 font-medium">Current</th>
                  <th className="py-2 px-2 font-medium">PnL</th>
                  <th className="py-2 px-2 font-medium">Score</th>
                  <th className="py-2 px-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {scalpTrades.slice(0, 24).map(rowForTrade)}
                {scalpTrades.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-white/30 text-[10px] uppercase tracking-widest">
                      No scalp trades
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Section 5 — Performance */}
        <section>
          <h3 className="text-[10px] uppercase tracking-widest text-white/40 mb-3">Scalp performance</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="border border-white/10 rounded-lg px-3 py-3">
              <div className="text-[10px] text-white/40 uppercase mb-1">Win rate</div>
              <div className="font-mono text-white">
                {performance && performance.closedTrades > 0
                  ? `${(performance.winRate * 100).toFixed(1)}%`
                  : "—"}
              </div>
              <div className="text-[10px] text-white/30 mt-0.5">{performance?.closedTrades ?? 0} closed</div>
            </div>
            <div className="border border-white/10 rounded-lg px-3 py-3">
              <div className="text-[10px] text-white/40 uppercase mb-1">Profit factor</div>
              <div className="font-mono text-white">
                {performance?.profitFactor == null ? "—" : performance.profitFactor.toFixed(2)}
              </div>
            </div>
            <div className="border border-white/10 rounded-lg px-3 py-3">
              <div className="text-[10px] text-white/40 uppercase mb-1">Avg win</div>
              <div className="font-mono text-emerald-400">
                {performance && (performance.wins ?? 0) > 0 ? `+${performance.avgProfit.toFixed(2)}` : "—"}
              </div>
            </div>
            <div className="border border-white/10 rounded-lg px-3 py-3">
              <div className="text-[10px] text-white/40 uppercase mb-1">Avg loss</div>
              <div className="font-mono text-red-400">
                {performance && (performance.losses ?? 0) > 0 ? performance.avgLoss.toFixed(2) : "—"}
              </div>
            </div>
          </div>
          {performance?.avgWinToAvgLoss != null && (
            <div className="mt-2 text-[10px] font-mono text-white/40">
              Avg win / |avg loss|: {performance.avgWinToAvgLoss.toFixed(2)}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
