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
    <div className="glass p-4 md:p-8 rounded-xl h-full flex flex-col">
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center mb-4 md:mb-8">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${isRunning ? 'bg-white animate-pulse' : 'bg-white/20'}`} />
          <h3 className="text-xs md:text-sm font-bold uppercase tracking-widest truncate">System Logs</h3>
        </div>
        <button
          type="button"
          onClick={isRunning ? onStop : onStart}
          className={`min-h-[44px] px-5 md:px-6 py-2.5 text-[10px] font-bold uppercase tracking-widest transition-all sm:self-start sm:w-auto w-full ${isRunning ? 'border border-white/20 hover:bg-white/5 active:bg-white/10' : 'bg-white text-black hover:bg-white/90 active:bg-white/80'}`}
        >
          {isRunning ? 'Stop' : 'Start'}
        </button>
      </div>

      <div className="flex-1 bg-black/40 rounded-lg p-3 md:p-5 font-mono leading-relaxed overflow-y-auto min-h-[14rem] sm:min-h-[20rem] md:min-h-[28rem] max-h-[50vh] sm:max-h-[60vh] md:max-h-[min(75vh,52rem)] border border-white/5">
        <div className="flex items-center gap-2 text-white/50 mb-3 pb-2 border-b border-white/5 text-[10px] uppercase tracking-widest">
          <Terminal className="w-3 h-3 md:w-4 md:h-4" />
          <span>MEDALLION_LOGS</span>
        </div>
        <div className="space-y-2">
          {logs.slice().reverse().map((log, i) => (
            <div key={i} className="text-white/70 text-[11px] md:text-sm break-all">
              <span className="text-white/25 mr-1.5">{'>'}</span>
              {log}
            </div>
          ))}
          {logs.length === 0 && (
            <div className="text-white/20 text-[11px] uppercase tracking-widest">
              No logs yet...
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
