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
    <div className="glass p-8 rounded-xl h-full">
      <div className="flex justify-between items-center mb-8">
        <h3 className="text-sm font-bold uppercase tracking-widest">Agent Insights: {symbol}</h3>
        <div className="text-2xl font-serif italic">{finalScore.toFixed(1)}</div>
      </div>

      <div className="space-y-8">
        <div className="flex gap-4">
          <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
            <Brain className="w-5 h-5 text-white/60" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Trend Agent</div>
            <div className="text-sm font-medium mb-1">{signals.trend.reason}</div>
            <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${signals.trend.score}%` }}
                className="h-full bg-white"
              />
            </div>
          </div>
        </div>

        <div className="flex gap-4">
          <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
            <Zap className="w-5 h-5 text-white/60" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Momentum Agent</div>
            <div className="text-sm font-medium mb-1">{signals.momentum.reason}</div>
            <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${signals.momentum.score}%` }}
                className="h-full bg-white"
              />
            </div>
          </div>
        </div>

        <div className="flex gap-4">
          <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
            <Target className="w-5 h-5 text-white/60" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-white/40 mb-1">Pullback Agent</div>
            <div className="text-sm font-medium mb-1">{signals.pullback.reason}</div>
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
