import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import { tradingSystem } from './src/backend/TradingSystem.ts';
import { DataLayer } from './src/backend/DataLayer.ts';
import { ScoringEngine } from './src/backend/Engine.ts';
import { runBacktest } from './src/backend/backtest/BacktestRunner.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get('/api/status', async (req, res) => {
    try {
      await tradingSystem.refreshOpenPositionMarks();
    } catch (e) {
      console.error('[api/status] refreshOpenPositionMarks:', e);
    }
    res.json(tradingSystem.getStatus());
  });

  app.post('/api/start', async (req, res) => {
    await tradingSystem.start();
    res.json({ status: 'started' });
  });

  app.post('/api/stop', (req, res) => {
    tradingSystem.stop();
    res.json({ status: 'stopped' });
  });

  app.get('/api/ohlcv/:symbol', async (req, res) => {
    const { symbol } = req.params;
    const { interval = '5m', limit = '100' } = req.query;
    const data = await DataLayer.fetchOHLCV(symbol, interval as string, parseInt(limit as string));
    res.json(data);
  });

  app.get('/api/insights/:symbol', async (req, res) => {
    const { symbol } = req.params;
    const data = await DataLayer.fetchOHLCV(symbol);
    if (data.length === 0) return res.status(404).json({ error: 'No data' });
    const insights = ScoringEngine.score(data);
    res.json(insights);
  });

  app.get('/api/performance', (req, res) => {
    res.json(tradingSystem.getPerformanceStats());
  });

  app.post('/api/backtest', async (req, res) => {
    try {
      const body = req.body || {};
      const symbol = typeof body.symbol === 'string' ? body.symbol : 'BTCUSDT';
      const interval = typeof body.interval === 'string' ? body.interval : '5m';
      const days = Math.min(30, Math.max(7, parseInt(String(body.days ?? 14), 10) || 14));
      const useAI = Boolean(body.useAI);
      const initialBalance =
        typeof body.initialBalance === 'number' && Number.isFinite(body.initialBalance)
          ? body.initialBalance
          : undefined;

      const result = await runBacktest({
        symbol,
        interval,
        days,
        useAI,
        initialBalance,
      });

      const { logs, trades, ...summary } = result;
      res.json({
        ...summary,
        trades,
        logLineCount: logs.length,
        logsPreview: logs.slice(-200),
      });
    } catch (e) {
      console.error('[api/backtest]', e);
      res.status(500).json({ error: String(e) });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        hmr: false 
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Medallion Club Server running on http://localhost:${PORT}`);
  });
}

startServer();
