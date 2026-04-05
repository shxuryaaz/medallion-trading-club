import React from 'react';
import { format } from 'date-fns';

interface TradeFeedProps {
  trades: any[];
}

export const TradeFeed: React.FC<TradeFeedProps> = ({ trades }) => {
  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="p-3 sm:p-4 md:p-6 border-b border-white/5">
        <h3 className="text-xs md:text-sm font-bold uppercase tracking-widest">Trade Feed</h3>
      </div>

      {/* Mobile card view */}
      <div className="md:hidden divide-y divide-white/5 overflow-y-auto max-h-[min(70vh,28rem)] overscroll-contain">
        {trades.slice().reverse().map((trade) => (
          <div key={trade.id} className="px-3 sm:px-4 py-3.5 space-y-2">
            <div className="flex justify-between items-center gap-2">
              <span className="font-mono text-[11px] text-white/50 tabular-nums">
                {format(trade.timestamp, 'HH:mm:ss')}
              </span>
              <span className={`text-[10px] font-medium uppercase tracking-widest shrink-0 ${trade.status === 'OPEN' ? 'text-white animate-pulse' : 'text-white/25'}`}>
                {trade.status}
              </span>
            </div>
            <div className="flex justify-between items-center gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-medium truncate">{trade.symbol}</span>
                <span className={`px-2 py-0.5 rounded-sm text-[10px] font-bold uppercase shrink-0 ${trade.side === 'LONG' ? 'bg-white text-black' : 'bg-white/10 text-white'}`}>
                  {trade.side}
                </span>
              </div>
              <span className={`font-mono text-sm tabular-nums shrink-0 ${typeof trade.pnl === 'number' && trade.pnl >= 0 ? 'text-white' : 'text-white/40'}`}>
                {trade.status === 'CLOSED' && typeof trade.pnl === 'number'
                  ? `${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)}`
                  : 'OPEN'}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-white/35">
              <span>IN ${trade.entryPrice.toFixed(2)}</span>
              {trade.exitPrice && <span>OUT ${trade.exitPrice.toFixed(2)}</span>}
            </div>
          </div>
        ))}
        {trades.length === 0 && (
          <div className="px-4 py-12 text-center text-white/20 text-[11px] uppercase tracking-widest">
            No trades yet
          </div>
        )}
      </div>

      {/* Desktop table view */}
      <div className="hidden md:block overflow-x-auto overflow-y-auto max-h-[min(75vh,52rem)]">
        <table className="w-full text-left text-xs lg:text-sm">
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
