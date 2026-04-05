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
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4 md:gap-6">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass p-4 sm:p-6 md:p-8 rounded-xl"
      >
        <div className="text-[10px] uppercase tracking-[0.2em] text-white/40 mb-1 sm:mb-2">Current Balance</div>
        <div className="text-2xl sm:text-3xl md:text-4xl font-serif italic tabular-nums break-all">${balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
      </motion.div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="glass p-4 sm:p-6 md:p-8 rounded-xl"
      >
        <div className="text-[10px] uppercase tracking-[0.2em] text-white/40 mb-1 sm:mb-2">Unrealized PnL</div>
        <div className={`text-2xl sm:text-3xl md:text-4xl font-serif italic tabular-nums ${totalPnL >= 0 ? 'text-white' : 'text-white/60'}`}>
          {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
        </div>
      </motion.div>

      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="glass p-4 sm:p-6 md:p-8 rounded-xl"
      >
        <div className="text-[10px] uppercase tracking-[0.2em] text-white/40 mb-1 sm:mb-2">Active Trades</div>
        <div className="text-2xl sm:text-3xl md:text-4xl font-serif italic tabular-nums">{activePositions.length}</div>
      </motion.div>
    </div>
  );
};
