import React, { useState, useEffect } from "react";
import axios from "axios";
import { motion, AnimatePresence } from "motion/react";
import { PortfolioOverview } from "./components/dashboard/PortfolioOverview";
import { LiveChart } from "./components/dashboard/LiveChart";
import { AgentInsights } from "./components/dashboard/AgentInsights";
import { TradeFeed } from "./components/dashboard/TradeFeed";
import { SystemStatus } from "./components/dashboard/SystemStatus";
import { Shield, Settings, LogOut, Bell, Activity } from "lucide-react";

const SYMBOL_OPTIONS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"] as const;

export default function App() {
  const [status, setStatus] = useState<any>(null);
  const [ohlcv, setOhlcv] = useState<any[]>([]);
  const [insights, setInsights] = useState<any>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string>("BTCUSDT");
  const [loading, setLoading] = useState(true);
  const [activeView, setActiveView] = useState<"dashboard" | "settings" | "activity">("dashboard");

  const fetchStatus = async () => {
    try {
      const res = await axios.get("/api/status");
      setStatus(res.data);
    } catch (err) {
      console.error("Error fetching status:", err);
    }
  };

  const fetchOhlcv = async () => {
    try {
      const res = await axios.get(`/api/ohlcv/${selectedSymbol}`);
      setOhlcv(res.data);
    } catch (err) {
      console.error("Error fetching OHLCV:", err);
    }
  };

  const fetchInsights = async () => {
    try {
      const res = await axios.get(`/api/insights/${selectedSymbol}`);
      setInsights(res.data);
    } catch (err) {
      console.error("Error fetching insights:", err);
    }
  };

  useEffect(() => {
    const init = async () => {
      await Promise.all([fetchStatus(), fetchOhlcv(), fetchInsights()]);
      setLoading(false);
    };
    init();

    const interval = setInterval(() => {
      fetchStatus();
      fetchOhlcv();
      fetchInsights();
    }, 5000);

    return () => clearInterval(interval);
  }, [selectedSymbol]);

  const handleStart = async () => {
    await axios.post("/api/start");
    fetchStatus();
  };

  const handleStop = async () => {
    await axios.post("/api/stop");
    fetchStatus();
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

  return (
    <main className="min-h-screen bg-black text-white selection:bg-white selection:text-black font-sans">
      {/* Noise overlay */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.02] z-[9999] bg-[url('https://grainy-gradients.vercel.app/noise.svg')]" />
      
      {/* Sidebar */}
      <div className="fixed left-0 top-0 bottom-0 w-20 border-r border-white/5 flex flex-col items-center py-8 gap-12 z-50 bg-black">
        <div 
          className="w-10 h-10 bg-white rounded-full flex items-center justify-center cursor-pointer"
          onClick={() => setActiveView("dashboard")}
        >
          <div className="w-5 h-5 bg-black rounded-sm rotate-45" />
        </div>
        
        <div className="flex flex-col gap-8">
          <Shield 
            className={`w-6 h-6 cursor-pointer transition-colors ${activeView === "dashboard" ? "text-white" : "text-white/40 hover:text-white/60"}`} 
            onClick={() => setActiveView("dashboard")}
          />
          <Activity 
            className={`w-6 h-6 cursor-pointer transition-colors ${activeView === "activity" ? "text-white" : "text-white/40 hover:text-white/60"}`} 
            onClick={() => setActiveView("activity")}
          />
          <Settings 
            className={`w-6 h-6 cursor-pointer transition-colors ${activeView === "settings" ? "text-white" : "text-white/40 hover:text-white/60"}`} 
            onClick={() => setActiveView("settings")}
          />
          <Bell className="w-6 h-6 text-white/40 hover:text-white/60 transition-colors cursor-pointer" />
        </div>

        <div className="mt-auto">
          <LogOut 
            className="w-6 h-6 text-white/20 hover:text-white transition-colors cursor-pointer" 
            onClick={() => window.location.reload()}
          />
        </div>
      </div>

      {/* Main Content */}
      <div className="pl-20">
        {/* Header */}
        <header className="px-12 py-8 border-b border-white/5 flex justify-between items-center bg-black/50 backdrop-blur-sm sticky top-0 z-40">
          <div>
            <h1 className="text-xl font-bold uppercase tracking-widest">
              {activeView === "dashboard" && "Medallion Club Dashboard"}
              {activeView === "settings" && "System Configuration"}
              {activeView === "activity" && "Historical Activity"}
            </h1>
            <div className="text-[10px] uppercase tracking-widest text-white/40 mt-1">
              Quantitative Multi-Agent Trading System v1.0.4
            </div>
          </div>
          
          <div className="flex items-center gap-8">
            {activeView === "dashboard" && (
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-widest text-white/40">Symbol</label>
                <select
                  value={selectedSymbol}
                  onChange={(e) => setSelectedSymbol(e.target.value)}
                  className="bg-white/5 border border-white/10 text-xs font-mono uppercase tracking-widest px-4 py-2 rounded-sm text-white focus:outline-none focus:border-white/30 cursor-pointer"
                >
                  {SYMBOL_OPTIONS.map((sym) => (
                    <option key={sym} value={sym} className="bg-black text-white">
                      {sym}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex flex-col items-end">
              <div className="text-[10px] uppercase tracking-widest text-white/40">Market Status</div>
              <div className="text-xs font-bold uppercase tracking-widest flex items-center gap-2">
                <div className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                Live: Binance Spot
              </div>
            </div>
            <div className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center overflow-hidden">
              <img src="https://api.dicebear.com/7.x/initials/svg?seed=MC" alt="User" className="w-full h-full object-cover opacity-80" />
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
              className="p-12 space-y-8"
            >
              <PortfolioOverview 
                balance={safeStatus.balance} 
                activePositions={safeStatus.activePositions} 
              />

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2">
                  <LiveChart data={ohlcv} symbol={selectedSymbol} />
                </div>
                <div>
                  <AgentInsights insights={insights} symbol={selectedSymbol} />
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2">
                  <TradeFeed trades={safeStatus.tradeHistory} />
                </div>
                <div>
                  <SystemStatus 
                    isRunning={safeStatus.isRunning} 
                    logs={safeStatus.logs} 
                    onStart={handleStart} 
                    onStop={handleStop} 
                  />
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
              className="p-12 max-w-4xl"
            >
              <div className="glass p-12 rounded-xl space-y-12">
                <div>
                  <h3 className="text-sm font-bold uppercase tracking-widest mb-8">API Credentials</h3>
                  <div className="space-y-6">
                    <div className="space-y-2">
                      <label className="text-[10px] uppercase tracking-widest text-white/40">Binance API Key</label>
                      <input 
                        type="password" 
                        value="********************************" 
                        readOnly
                        className="w-full bg-white/5 border border-white/10 p-4 font-mono text-xs focus:outline-none focus:border-white/20"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] uppercase tracking-widest text-white/40">Binance Secret Key</label>
                      <input 
                        type="password" 
                        value="********************************" 
                        readOnly
                        className="w-full bg-white/5 border border-white/10 p-4 font-mono text-xs focus:outline-none focus:border-white/20"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-bold uppercase tracking-widest mb-8">Risk Parameters</h3>
                  <div className="grid grid-cols-2 gap-8">
                    <div className="space-y-2">
                      <label className="text-[10px] uppercase tracking-widest text-white/40">Risk Per Trade (%)</label>
                      <div className="p-4 bg-white/5 border border-white/10 font-mono text-xs">1.00</div>
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] uppercase tracking-widest text-white/40">Max Drawdown (%)</label>
                      <div className="p-4 bg-white/5 border border-white/10 font-mono text-xs">15.00</div>
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
              className="p-12"
            >
              <TradeFeed trades={safeStatus.tradeHistory} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </main>
  );
}




