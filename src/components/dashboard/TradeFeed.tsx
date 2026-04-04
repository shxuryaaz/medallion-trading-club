import React from 'react';
import { format } from 'date-fns';

interface TradeFeedProps {
  trades: any[];
}

export const TradeFeed: React.FC<TradeFeedProps> = ({ trades }) => {
  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="p-6 border-b border-white/5">
        <h3 className="text-sm font-bold uppercase tracking-widest">Trade Execution Feed</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-white/40 border-b border-white/5">
              <th className="px-6 py-4 font-medium">Time</th>
              <th className="px-6 py-4 font-medium">Symbol</th>
              <th className="px-6 py-4 font-medium">Side</th>
              <th className="px-6 py-4 font-medium">Entry</th>
              <th className="px-6 py-4 font-medium">Exit</th>
              <th className="px-6 py-4 font-medium">PnL</th>
              <th className="px-6 py-4 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {trades.slice().reverse().map((trade) => (
              <tr key={trade.id} className="hover:bg-white/[0.02] transition-colors">
                <td className="px-6 py-4 text-white/40 font-mono text-xs">
                  {format(trade.timestamp, 'HH:mm:ss')}
                </td>
                <td className="px-6 py-4 font-medium">{trade.symbol}</td>
                <td className="px-6 py-4">
                  <span className={`px-2 py-0.5 rounded-sm text-[10px] font-bold uppercase tracking-widest ${trade.side === 'LONG' ? 'bg-white text-black' : 'bg-white/10 text-white'}`}>
                    {trade.side}
                  </span>
                </td>
                <td className="px-6 py-4 font-mono text-xs">${trade.entryPrice.toFixed(2)}</td>
                <td className="px-6 py-4 font-mono text-xs">{trade.exitPrice ? `$${trade.exitPrice.toFixed(2)}` : '-'}</td>
                <td className={`px-6 py-4 font-mono text-xs ${typeof trade.pnl === 'number' && trade.pnl >= 0 ? 'text-white' : 'text-white/40'}`}>
                  {trade.status === 'CLOSED' && typeof trade.pnl === 'number'
                    ? `${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}`
                    : '-'}
                </td>
                <td className="px-6 py-4">
                  <span className={`text-[10px] uppercase tracking-widest ${trade.status === 'OPEN' ? 'text-white animate-pulse' : 'text-white/20'}`}>
                    {trade.status}
                  </span>
                </td>
              </tr>
            ))}
            {trades.length === 0 && (
              <tr>
                <td colSpan={7} className="px-6 py-12 text-center text-white/20 text-xs uppercase tracking-widest">
                  No trades executed in current session
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
