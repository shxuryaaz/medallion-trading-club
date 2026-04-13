import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket as WsSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import { PortfolioManager } from './backend/portfolio/PortfolioManager.ts';
import { TradingSystem } from './backend/TradingSystem.ts';
import { ScalpingEngine } from './backend/scalping/ScalpingEngine.ts';
import { StateStore, loadState } from './backend/storage/StateStore.ts';
import { WebSocketManager } from './backend/data/WebSocketManager.ts';
import { DataLayer } from './backend/DataLayer.ts';
import { ScoringEngine } from './backend/Engine.ts';
import { exchange } from './backend/exchange/BinanceClient.ts';
import { runBacktest } from './backend/backtest/BacktestRunner.ts';
import { classifyWatchlistTicks } from './backend/watchlistTickClassify.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  app.use(cors());
  app.use(express.json());

  // ── Engine setup ────────────────────────────────────────────────────────────
  const persisted   = await loadState();
  const portfolio   = new PortfolioManager(persisted.balance);
  const wsManager   = WebSocketManager.getInstance();
  const swingEngine = new TradingSystem(portfolio, persisted.swing);
  const scalpEngine = new ScalpingEngine(portfolio, wsManager, persisted.scalp);

  StateStore.registerSnapshotBuilder(() => ({
    balance: portfolio.getBalance(),
    swing: swingEngine.getPersistSnapshot(),
    scalp: scalpEngine.getPersistSnapshot(),
  }));
  StateStore.scheduleSave();

  // Sync balance from exchange — on startup, then every 5 minutes.
  // No-op when BINANCE_ENABLED is not 'true'.
  const syncBalance = () =>
    exchange.getUsdtBalance()
      .then(liveBalance => { if (liveBalance != null) portfolio.setBalance(liveBalance); })
      .catch(err => console.error('[server] Balance sync failed:', err));

  syncBalance();
  setInterval(syncBalance, 5 * 60 * 1000);

  // ── Routes ──────────────────────────────────────────────────────────────────

  app.get('/ping', (req, res) => {
    const now = new Date().toISOString();
    console.log(`[PING] UptimeRobot hit at ${now}`);
    res.json({ status: 'ok', time: now });
  });

  /**
   * Aggregated status from all engines.
   * Positions and history are merged and sorted newest-first for the frontend.
   * Per-engine breakdown is also included for future UI panels.
   */
  app.get('/api/status', async (req, res) => {
    // Refresh swing marks via REST (as before); scalp uses WS prices in-memory
    try { await swingEngine.refreshOpenPositionMarks(); } catch (e) {
      console.error('[api/status] swing refresh:', e);
    }
    try { await scalpEngine.refreshOpenPositionMarks(); } catch (e) {
      console.error('[api/status] scalp refresh:', e);
    }

    const swingStatus = swingEngine.getStatus();
    const scalpStatus = scalpEngine.getStatus();

    const allPositions = [
      ...swingStatus.activePositions,
      ...scalpStatus.activePositions,
    ];
    const allHistory = [
      ...swingStatus.tradeHistory,
      ...scalpStatus.tradeHistory,
    ].sort((a, b) => b.timestamp - a.timestamp);
    const allLogs = [
      ...swingStatus.logs,
      ...scalpStatus.logs,
    ].sort(); // logs include timestamps in the string — sort brings them into order

    res.json({
      // Top-level fields the frontend already consumes (unchanged shape)
      isRunning:       swingStatus.isRunning || scalpStatus.isRunning,
      balance:         portfolio.getBalance(),
      activePositions: allPositions,
      tradeHistory:    allHistory,
      logs:            allLogs,
      // Per-engine breakdown (new — available for future UI tabs)
      engines: {
        swing: swingStatus,
        scalp: scalpStatus,
      },
      riskSummary: portfolio.getRiskSummary(),
    });
  });

  app.post('/api/start', async (req, res) => {
    await swingEngine.start();
    await scalpEngine.start();
    res.json({ status: 'started' });
  });

  app.post('/api/stop', (req, res) => {
    swingEngine.stop();
    scalpEngine.stop();
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

  app.get('/api/scalp/status', async (req, res) => {
    const symbol =
      typeof req.query.symbol === 'string' && req.query.symbol.length > 0
        ? req.query.symbol.toUpperCase()
        : 'BTCUSDT';
    try {
      const snapshot = await scalpEngine.getDashboardSnapshot(symbol);
      res.json(snapshot);
    } catch (e) {
      console.error('[api/scalp/status]', e);
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/performance', (req, res) => {
    const swingStats = swingEngine.getPerformanceStats();
    const scalpStats = scalpEngine.getPerformanceStats();

    // Combined across both engines (PnL metrics are net of fees)
    const combined = {
      closedTrades: swingStats.closedTrades + scalpStats.closedTrades,
      wins:         swingStats.wins  + scalpStats.wins,
      losses:       swingStats.losses + scalpStats.losses,
      winRate: (swingStats.closedTrades + scalpStats.closedTrades) > 0
        ? (swingStats.wins + scalpStats.wins) / (swingStats.closedTrades + scalpStats.closedTrades)
        : 0,
      totalNetPnl: swingStats.totalNetPnl + scalpStats.totalNetPnl,
    };

    res.json({ combined, swing: swingStats, scalp: scalpStats });
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

      const result = await runBacktest({ symbol, interval, days, useAI, initialBalance });
      const { logs, trades, ...summary } = result;
      res.json({ ...summary, trades, logLineCount: logs.length, logsPreview: logs.slice(-200) });
    } catch (e) {
      console.error('[api/backtest]', e);
      res.status(500).json({ error: String(e) });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      root: path.join(__dirname, '..'),
      server: { middlewareMode: true, hmr: false },
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

  function makeWatchlistPayload() {
    return {
      type: 'watchlist' as const,
      t: Date.now(),
      cards: scalpEngine.getPanelWatchlistSymbols().map((symbol) => {
        const prices = wsManager.getRecentPrices(symbol, 100);
        const sig = scalpEngine.getLastSignal(symbol);
        return {
          symbol,
          prices,
          lastPrice: wsManager.getLatestPrice(symbol),
          connected: wsManager.isConnected(symbol),
          statusLabel: classifyWatchlistTicks(prices),
          signal: sig
            ? { decision: sig.decision, score: sig.score, reason: sig.reason }
            : null,
        };
      }),
    };
  }

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws/watchlist' });
  const watchlistClients = new Set<WsSocket>();
  let watchlistInterval: ReturnType<typeof setInterval> | null = null;

  const broadcastWatchlist = () => {
    if (watchlistClients.size === 0) return;
    const msg = JSON.stringify(makeWatchlistPayload());
    for (const c of watchlistClients) {
      if (c.readyState === WsSocket.OPEN) c.send(msg);
    }
  };

  wss.on('connection', (socket) => {
    watchlistClients.add(socket);
    try {
      socket.send(JSON.stringify(makeWatchlistPayload()));
    } catch {
      /* ignore */
    }
    if (!watchlistInterval) {
      watchlistInterval = setInterval(broadcastWatchlist, 380);
    }
    socket.on('close', () => {
      watchlistClients.delete(socket);
      if (watchlistClients.size === 0 && watchlistInterval) {
        clearInterval(watchlistInterval);
        watchlistInterval = null;
      }
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Medallion Club Server running on http://localhost:${PORT}`);

    // Both engines start fire-and-forget — they never block each other.
    // Swing: async while loop, 5-min cadence
    // Scalp: recursive setTimeout, 4-second cadence + WS bootstrap
    void swingEngine.start().catch((e) => console.error('[server] swing start failed:', e));
    void scalpEngine.start().catch((e) => console.error('[server] scalp start failed:', e));
  });
}

startServer();
