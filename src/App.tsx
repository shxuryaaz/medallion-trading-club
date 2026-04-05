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
      <div className="min-h-screen bg-black flex items-center justify-center">
        <motion.div
          animate={{ opacity: [0.2, 1, 0.2] }}
          transition={{ duration: 2, repeat: Infinity }}
          className="text-[10px] uppercase tracking-[0.5em] text-white/40"
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
    <main className="min-h-screen bg-black text-white selection:bg-white selection:text-black font-sans">
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

      {/* Mobile Bottom Nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-black border-t border-white/10 flex items-center justify-around px-4 py-3">
        {navItems.map(({ view, icon: Icon, label }) => (
          <button
            key={view}
            onClick={() => setActiveView(view)}
            className="flex flex-col items-center gap-1"
          >
            <Icon className={`w-5 h-5 transition-colors ${activeView === view ? "text-white" : "text-white/30"}`} />
            <span className={`text-[9px] uppercase tracking-widest transition-colors ${activeView === view ? "text-white" : "text-white/30"}`}>
              {label}
            </span>
          </button>
        ))}
      </div>

      {/* Main Content */}
      <div className="md:pl-20 pb-20 md:pb-0">
        {/* Header */}
        <header className="px-4 md:px-12 py-4 md:py-8 border-b border-white/5 flex justify-between items-center bg-black/50 backdrop-blur-sm sticky top-0 z-40">
          <div>
            <h1 className="text-sm md:text-xl font-bold uppercase tracking-widest">
              {activeView === "dashboard" && "Medallion Club"}
              {activeView === "settings" && "Configuration"}
              {activeView === "activity" && "Activity"}
            </h1>
            <div className="text-[9px] md:text-[10px] uppercase tracking-widest text-white/40 mt-0.5">
              Multi-Agent Trading System
            </div>
          </div>

          <div className="flex items-center gap-3 md:gap-8">
            {activeView === "dashboard" && (
              <select
                value={selectedSymbol}
                onChange={(e) => setSelectedSymbol(e.target.value)}
                className="bg-white/5 border border-white/10 text-xs font-mono uppercase tracking-widest px-2 md:px-4 py-1.5 md:py-2 rounded-sm text-white focus:outline-none focus:border-white/30 cursor-pointer"
              >
                {SYMBOL_OPTIONS.map((sym) => (
                  <option key={sym} value={sym} className="bg-black text-white">
                    {sym}
                  </option>
                ))}
              </select>
            )}
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
              <span className="text-[9px] md:text-xs font-bold uppercase tracking-widest hidden sm:block">Live</span>
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
              className="p-4 md:p-12 space-y-4 md:space-y-8"
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
              className="p-4 md:p-12 max-w-4xl"
            >
              <div className="glass p-6 md:p-12 rounded-xl space-y-8 md:space-y-12">
                <div>
                  <h3 className="text-sm font-bold uppercase tracking-widest mb-6">API Credentials</h3>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-[10px] uppercase tracking-widest text-white/40">Binance API Key</label>
                      <input
                        type="password"
                        value="********************************"
                        readOnly
                        className="w-full bg-white/5 border border-white/10 p-3 font-mono text-xs focus:outline-none focus:border-white/20"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] uppercase tracking-widest text-white/40">Binance Secret Key</label>
                      <input
                        type="password"
                        value="********************************"
                        readOnly
                        className="w-full bg-white/5 border border-white/10 p-3 font-mono text-xs focus:outline-none focus:border-white/20"
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
              className="p-4 md:p-12"
            >
              <TradeFeed trades={safeStatus.tradeHistory} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </main>
  );
}
