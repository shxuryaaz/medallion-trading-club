import React from 'react';
import { motion } from 'motion/react';
import { TrendingUp, TrendingDown, Activity } from 'lucide-react';

interface PortfolioProps {
  balance: number;
  activePositions: any[];
}

export const PortfolioOverview: React.FC<PortfolioProps> = ({ balance, activePositions }) => {
  const totalPnL = activePositions.reduce(
    (acc, pos) => acc + (typeof pos.unrealizedPnl === 'number' ? pos.unrealizedPnl : 0),
    0
  );
  
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass p-8 rounded-xl"
      >
        <div className="text-[10px] uppercase tracking-[0.2em] text-white/40 mb-2">Current Balance</div>
        <div className="text-4xl font-serif italic">${balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
      </motion.div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="glass p-8 rounded-xl"
      >
        <div className="text-[10px] uppercase tracking-[0.2em] text-white/40 mb-2">Unrealized PnL</div>
        <div className={`text-4xl font-serif italic ${totalPnL >= 0 ? 'text-white' : 'text-white/60'}`}>
          {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
        </div>
      </motion.div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="glass p-8 rounded-xl"
      >
        <div className="text-[10px] uppercase tracking-[0.2em] text-white/40 mb-2">Active Trades</div>
        <div className="text-4xl font-serif italic">{activePositions.length}</div>
      </motion.div>
    </div>
  );
};
