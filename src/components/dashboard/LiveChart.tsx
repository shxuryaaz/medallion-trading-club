import React, { useEffect, useRef } from 'react';
import { createChart, ColorType, IChartApi, ISeriesApi, CandlestickSeries } from 'lightweight-charts';

interface OHLCV {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface LiveChartProps {
  data: OHLCV[];
  symbol: string;
}

export const LiveChart: React.FC<LiveChartProps> = ({ data, symbol }) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chartHeight = () => (typeof window !== 'undefined' && window.innerWidth < 768 ? 260 : 400);

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#888',
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
      },
      width: chartContainerRef.current.clientWidth,
      height: chartHeight(),
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        timeVisible: true,
        secondsVisible: false,
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
      },
    });

    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderVisible: false,
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    chartRef.current = chart;
    seriesRef.current = candlestickSeries;

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartHeight(),
        });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    if (seriesRef.current && data.length > 0) {
      seriesRef.current.setData(data);
    }
  }, [data]);

  return (
    <div className="relative glass p-4 sm:p-6 rounded-xl overflow-hidden">
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center mb-4 sm:mb-6">
        <h3 className="text-xs sm:text-sm font-bold uppercase tracking-widest flex items-center gap-2 min-w-0">
          <div className="w-2 h-2 bg-white rounded-full animate-pulse shrink-0" />
          <span className="truncate">Live: {symbol}</span>
        </h3>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-widest text-white/40 shrink-0">
          <span>15M</span>
          <span>Binance</span>
        </div>
      </div>
      <div ref={chartContainerRef} className="w-full touch-pan-x" />
    </div>
  );
};
