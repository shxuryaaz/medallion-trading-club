import React, { useState, useEffect } from "react";
import axios from "axios";
import { API_BASE_URL } from "./config";
import { motion, AnimatePresence } from "motion/react";
import { PortfolioOverview } from "./components/dashboard/PortfolioOverview";
import { LiveChart } from "./components/dashboard/LiveChart";
import { AgentInsights } from "./components/dashboard/AgentInsights";
import { TradeFeed } from "./components/dashboard/TradeFeed";
import { SystemStatus } from "./components/dashboard/SystemStatus";
import { ScalpDashboard, type ScalpSnapshot } from "./components/dashboard/ScalpDashboard";
import { Shield, Settings, LogOut, Bell, Activity } from "lucide-react";

const SYMBOL_OPTIONS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"] as const;

export default function App() {
  const [status, setStatus] = useState<any>(null);
  const [ohlcv, setOhlcv] = useState<any[]>([]);
  const [insights, setInsights] = useState<any>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string>("BTCUSDT");
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState<"dashboard" | "settings" | "activity">("dashboard");
  const [scalpSnapshot, setScalpSnapshot] = useState<ScalpSnapshot | null>(null);
  const [scalpPerformance, setScalpPerformance] = useState<any>(null);

  const fetchStatus = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/api/status`);
      setStatus(res.data);
    } catch (err) {
      console.error("Error fetching status:", err);
    }
  };

  const fetchOhlcv = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/api/ohlcv/${selectedSymbol}?interval=15m`);
      setOhlcv(res.data);
    } catch (err) {
      console.error("Error fetching OHLCV:", err);
    }
  };

  const fetchInsights = async () => {
    try {
      const res = await axios.get(`${API_BASE_URL}/api/insights/${selectedSymbol}`);
      setInsights(res.data);
    } catch (err) {
      console.error("Error fetching insights:", err);
    }
  };

  const fetchScalpDashboard = async () => {
    try {
      const [snapRes, perfRes] = await Promise.all([
        axios.get<ScalpSnapshot>(`${API_BASE_URL}/api/scalp/status?symbol=${selectedSymbol}`),
        axios.get(`${API_BASE_URL}/api/performance`),
      ]);
      setScalpSnapshot(snapRes.data);
      setScalpPerformance(perfRes.data?.scalp ?? null);
    } catch (err) {
      console.error("Error fetching scalp dashboard:", err);
    }
  };

  useEffect(() => {
    const init = async () => {
      await Promise.all([fetchStatus(), fetchOhlcv(), fetchInsights(), fetchScalpDashboard()]);
      setLoading(false);
    };
    init();

    const interval = setInterval(() => {
      fetchStatus();
      fetchOhlcv();
      fetchInsights();
      fetchScalpDashboard();
    }, 5000);

    return () => clearInterval(interval);
  }, [selectedSymbol]);

  const handleStart = async () => {
    try {
      await axios.post(`${API_BASE_URL}/api/start`);
      fetchStatus();
    } catch (err) {
      console.error("Error starting trading system:", err);
    }
  };

  const handleStop = async () => {
    try {
      await axios.post(`${API_BASE_URL}/api/stop`);
      fetchStatus();
    } catch (err) {
      console.error("Error stopping trading system:", err);
    }
  };

  const safeStatus = status ?? {
    isRunning: false,
    balance: 0,
    activePositions: [],
    tradeHistory: [],
    logs: [],
  };

  if (loading) {
    return (
      <div className="min-h-dvh pt-safe px-4 bg-black flex items-center justify-center">
        <motion.div
          animate={{ opacity: [0.2, 1, 0.2] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="text-[10px] sm:text-xs uppercase tracking-[0.35em] sm:tracking-[0.5em] text-white/40 px-6 text-center max-w-[min(100%,20rem)]"
        >
          Initializing Medallion Club Systems...
        </motion.div>
      </div>
    );
  }

  const navItems = [
    { view: "dashboard" as const, icon: Shield, label: "Trade" },
    { view: "activity" as const, icon: Activity, label: "Activity" },
    { view: "settings" as const, icon: Settings, label: "Settings" },
  ];

  return (
    <main className="min-h-dvh overflow-x-hidden bg-black text-white selection:bg-white selection:text-black font-sans">
      {/* Noise overlay */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.02] z-[9999] bg-[url('https://grainy-gradients.vercel.app/noise.svg')]" />

      {/* Desktop Sidebar */}
      <div className="hidden md:flex fixed left-0 top-0 bottom-0 w-20 border-r border-white/5 flex-col items-center py-8 gap-12 z-50 bg-black">
        <div
          className="w-10 h-10 bg-white rounded-full flex items-center justify-center cursor-pointer"
          onClick={() => setActiveView("dashboard")}
        >
          <div className="w-5 h-5 bg-black rounded-sm rotate-45" />
        </div>

        <div className="flex flex-col gap-8">
          {navItems.map(({ view, icon: Icon }) => (
            <Icon
              key={view}
              className={`w-6 h-6 cursor-pointer transition-colors ${activeView === view ? "text-white" : "text-white/40 hover:text-white/60"}`}
              onClick={() => setActiveView(view)}
            />
          ))}
          <Bell className="w-6 h-6 text-white/40 hover:text-white/60 transition-colors cursor-pointer" />
        </div>

        <div className="mt-auto">
          <LogOut
            className="w-6 h-6 text-white/20 hover:text-white transition-colors cursor-pointer"
            onClick={() => window.location.reload()}
          />
        </div>
      </div>

      {/* Mobile Bottom Nav — 44px+ touch targets, safe area */}
      <div
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-black/95 backdrop-blur-sm border-t border-white/10 flex items-stretch justify-around px-2"
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom, 0px))" }}
      >
        {navItems.map(({ view, icon: Icon, label }) => (
          <button
            key={view}
            type="button"
            onClick={() => setActiveView(view)}
            className="flex flex-1 flex-col items-center justify-center gap-1 min-h-[52px] max-w-[33%] py-2 active:bg-white/5 rounded-t-lg"
          >
            <Icon className={`w-6 h-6 shrink-0 transition-colors ${activeView === view ? "text-white" : "text-white/35"}`} />
            <span className={`text-[10px] font-medium uppercase tracking-widest transition-colors ${activeView === view ? "text-white" : "text-white/35"}`}>
              {label}
            </span>
          </button>
        ))}
      </div>

      {/* Main Content */}
      <div className="md:pl-20 pb-nav-mobile md:pb-0">
        {/* Header */}
        <header className="pt-safe px-4 md:px-12 py-3 md:py-8 border-b border-white/5 flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center bg-black/50 backdrop-blur-sm sticky top-0 z-40">
          <div className="min-w-0">
            <h1 className="text-base md:text-xl font-bold uppercase tracking-widest truncate">
              {activeView === "dashboard" && "Medallion Club"}
              {activeView === "settings" && "Configuration"}
              {activeView === "activity" && "Activity"}
            </h1>
            <div className="text-[10px] md:text-[10px] uppercase tracking-widest text-white/40 mt-0.5">
              Multi-Agent Trading System
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:gap-4 md:gap-8">
            {activeView === "dashboard" && (
              <select
                value={selectedSymbol}
                onChange={(e) => setSelectedSymbol(e.target.value)}
                className="bg-white/5 border border-white/10 text-sm font-mono uppercase tracking-wider px-3 py-2.5 min-h-[44px] rounded-sm text-white focus:outline-none focus:border-white/30 cursor-pointer w-full sm:w-auto sm:min-w-[140px]"
              >
                {SYMBOL_OPTIONS.map((sym) => (
                  <option key={sym} value={sym} className="bg-black text-white">
                    {sym}
                  </option>
                ))}
              </select>
            )}
            <div className="flex items-center gap-2 shrink-0">
              <div className="w-2 h-2 bg-white rounded-full animate-pulse shrink-0" />
              <span className="text-[10px] md:text-xs font-bold uppercase tracking-widest text-white/80">Live</span>
            </div>
          </div>
        </header>

        <AnimatePresence mode="wait">
          {activeView === "dashboard" && (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="px-3 sm:px-4 md:p-12 py-4 md:py-12 space-y-4 md:space-y-8"
            >
              <PortfolioOverview
                balance={safeStatus.balance}
                activePositions={safeStatus.activePositions}
              />

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-8">
                <div className="lg:col-span-2">
                  <LiveChart data={ohlcv} symbol={selectedSymbol} />
                </div>
                <div>
                  <AgentInsights insights={insights} symbol={selectedSymbol} />
                </div>
              </div>

              <ScalpDashboard
                snapshot={scalpSnapshot}
                performance={scalpPerformance}
                trades={safeStatus.tradeHistory}
                positions={safeStatus.activePositions}
              />

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-8">
                <div className="lg:col-span-2">
                  <SystemStatus
                    isRunning={safeStatus.isRunning}
                    logs={safeStatus.logs}
                    onStart={handleStart}
                    onStop={handleStop}
                  />
                </div>
                <div>
                  <TradeFeed trades={safeStatus.tradeHistory} />
                </div>
              </div>
            </motion.div>
          )}

          {activeView === "settings" && (
            <motion.div
              key="settings"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="px-3 sm:px-4 md:p-12 py-4 md:py-12 max-w-4xl mx-auto w-full"
            >
              <div className="glass p-4 sm:p-6 md:p-12 rounded-xl space-y-6 md:space-y-12">
                <div>
                  <h3 className="text-sm font-bold uppercase tracking-widest mb-6">API Credentials</h3>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-[10px] uppercase tracking-widest text-white/40">Binance API Key</label>
                      <input
                        type="password"
                        value="********************************"
                        readOnly
                        className="w-full bg-white/5 border border-white/10 p-3 min-h-[44px] font-mono text-base md:text-xs focus:outline-none focus:border-white/20"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] uppercase tracking-widest text-white/40">Binance Secret Key</label>
                      <input
                        type="password"
                        value="********************************"
                        readOnly
                        className="w-full bg-white/5 border border-white/10 p-3 min-h-[44px] font-mono text-base md:text-xs focus:outline-none focus:border-white/20"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-bold uppercase tracking-widest mb-6">Risk Parameters</h3>
                  <div className="grid grid-cols-2 gap-4 md:gap-8">
                    <div className="space-y-2">
                      <label className="text-[10px] uppercase tracking-widest text-white/40">Risk Per Trade (%)</label>
                      <div className="p-3 bg-white/5 border border-white/10 font-mono text-xs">1.00</div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] uppercase tracking-widest text-white/40">Max Drawdown (%)</label>
                      <div className="p-3 bg-white/5 border border-white/10 font-mono text-xs">15.00</div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeView === "activity" && (
            <motion.div
              key="activity"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="px-3 sm:px-4 md:p-12 py-4 md:py-12"
            >
              <TradeFeed trades={safeStatus.tradeHistory} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </main>
  );
}
