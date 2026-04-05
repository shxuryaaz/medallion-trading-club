import React from 'react';
import { motion } from 'motion/react';
import { Terminal } from 'lucide-react';

interface SystemStatusProps {
  isRunning: boolean;
  logs: string[];
  onStart: () => void;
  onStop: () => void;
}

export const SystemStatus: React.FC<SystemStatusProps> = ({ isRunning, logs, onStart, onStop }) => {
  return (
    <div className="glass p-8 rounded-xl h-full flex flex-col">
      <div className="flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${isRunning ? 'bg-white animate-pulse' : 'bg-white/20'}`} />
          <h3 className="text-sm font-bold uppercase tracking-widest">System Status</h3>
        </div>
        <button 
          onClick={isRunning ? onStop : onStart}
          className={`px-6 py-2 text-[10px] font-bold uppercase tracking-widest transition-all ${isRunning ? 'border border-white/20 hover:bg-white/5' : 'bg-white text-black hover:bg-white/90'}`}
        >
          {isRunning ? 'Stop Engine' : 'Start Engine'}
        </button>
      </div>

      <div className="flex-1 bg-black/40 rounded-lg p-5 font-mono text-sm leading-relaxed overflow-y-auto min-h-[28rem] max-h-[min(75vh,52rem)] border border-white/5">
        <div className="flex items-center gap-2 text-white/50 mb-4 pb-2 border-b border-white/5 text-xs uppercase tracking-widest">
          <Terminal className="w-4 h-4" />
          <span>MEDALLION_CLUB_LOGS</span>
        </div>
        <div className="space-y-1.5">
          {logs.slice().reverse().map((log, i) => (
            <div key={i} className="text-white/70">
              <span className="text-white/25 mr-2">{'>'}</span>
              {log}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
