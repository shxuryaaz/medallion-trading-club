import React from 'react';
import { motion } from 'motion/react';
import { Brain, Zap, Target } from 'lucide-react';

interface AgentInsightsProps {
  insights: any;
  symbol: string;
}

export const AgentInsights: React.FC<AgentInsightsProps> = ({ insights, symbol }) => {
  if (!insights) return null;

  const { finalScore, signals } = insights;

  return (
    <div className="glass p-4 sm:p-6 md:p-8 rounded-xl h-full">
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-between sm:items-center mb-6 sm:mb-8">
        <h3 className="text-xs sm:text-sm font-bold uppercase tracking-widest break-words">Insights: {symbol}</h3>
        <div className="text-xl sm:text-2xl font-serif italic tabular-nums">{finalScore.toFixed(1)}</div>
      </div>

      <div className="space-y-6 sm:space-y-8">
        <div className="flex gap-3 sm:gap-4">
          <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
            <Brain className="w-5 h-5 text-white/60" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Trend Agent</div>
            <div className="text-xs sm:text-sm font-medium mb-1 leading-snug">{signals.trend.reason}</div>
            <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${signals.trend.score}%` }}
                className="h-full bg-white"
              />
            </div>
          </div>
        </div>

        <div className="flex gap-3 sm:gap-4">
          <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
            <Zap className="w-5 h-5 text-white/60" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Momentum Agent</div>
            <div className="text-xs sm:text-sm font-medium mb-1 leading-snug">{signals.momentum.reason}</div>
            <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${signals.momentum.score}%` }}
                className="h-full bg-white"
              />
            </div>
          </div>
        </div>

        <div className="flex gap-3 sm:gap-4">
          <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
            <Target className="w-5 h-5 text-white/60" />
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Pullback Agent</div>
            <div className="text-xs sm:text-sm font-medium mb-1 leading-snug">{signals.pullback.reason}</div>
            <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${signals.pullback.score}%` }}
                className="h-full bg-white"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
