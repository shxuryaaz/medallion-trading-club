# Medallion Club Trading System

A dual-engine, AI-gated paper trading platform for cryptocurrency markets. Implements concurrent swing and scalp strategies with composited agent scoring, ATR-based risk management, cross-engine portfolio coordination, and an OpenAI second-opinion layer. Market data is sourced from Binance REST and WebSocket APIs. All execution is simulated (paper trading).

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [System Components](#system-components)
   - [Data Layer](#data-layer)
   - [Swing Engine](#swing-engine)
   - [Scalp Engine](#scalp-engine)
   - [Portfolio Manager](#portfolio-manager)
   - [AI Gate](#ai-gate)
   - [Backtesting Engine](#backtesting-engine)
   - [Persistence Layer](#persistence-layer)
3. [Signal Composition](#signal-composition)
4. [Risk Model](#risk-model)
5. [Tech Stack](#tech-stack)
6. [Installation & Setup](#installation--setup)
7. [Running the System](#running-the-system)
8. [Backtesting CLI](#backtesting-cli)
9. [API Reference](#api-reference)
10. [Project Structure](#project-structure)
11. [Configuration](#configuration)

---

## Architecture Overview

The system is organized into a layered architecture separating data ingestion, signal generation, execution logic, and risk management.

```
                        ┌────────────────────────────────────┐
                        │          React Dashboard           │
                        │  Portfolio · Charts · Trade Feed   │
                        └──────────────┬─────────────────────┘
                                       │ HTTP (polling)
                        ┌──────────────▼─────────────────────┐
                        │          Express Server             │
                        │  /api/status · /api/ohlcv · etc.   │
                        └──────┬───────────────┬─────────────┘
                               │               │
              ┌────────────────▼──┐    ┌───────▼──────────────┐
              │   Swing Engine    │    │    Scalp Engine       │
              │   (15m candles)   │    │  (1m + live ticks)   │
              └────────┬──────────┘    └───────┬──────────────┘
                       │                       │
              ┌────────▼───────────────────────▼──────────────┐
              │               Portfolio Manager                │
              │     Cross-engine risk caps · balance sync      │
              └────────────────────┬───────────────────────────┘
                                   │
         ┌─────────────────────────▼───────────────────────────┐
         │                     Data Layer                       │
         │  Binance REST (cached) · WebSocket (live ticks)     │
         └─────────────────────────────────────────────────────┘
```

Both engines operate concurrently and independently, jointly governed by the PortfolioManager to enforce aggregate risk constraints.

---

## System Components

### Data Layer

**File:** [src/backend/DataLayer.ts](src/backend/DataLayer.ts)

The DataLayer abstracts all Binance API interaction behind a unified interface:

- **REST endpoint:** Binance klines API (`/api/v3/klines`) for historical OHLCV data.
- **WebSocket feed:** `wss://stream.binance.com:9443/ws` with per-symbol `miniTicker` streams delivering close prices at ~1-second intervals.
- **Caching strategy:**
  - 15m swing candles: 5-minute TTL
  - 5m chart data: 3-minute TTL
  - 1m scalp context: 2-minute TTL
  - HTF (high-timeframe) close cache: updated continuously from WebSocket ticks
- **Rate limit handling:** Detects HTTP 418 and 429 responses (Binance IP throttle/ban), reads the `Retry-After` header, and gates all REST calls for the ban duration (minimum 10s, maximum 10 minutes). During a ban window, engines fall back to cached data.

**WebSocketManager:** [src/backend/data/WebSocketManager.ts](src/backend/data/WebSocketManager.ts)

A singleton WebSocket manager that:
- Maintains one persistent connection per subscribed symbol
- Buffers the last 300 ticks per symbol (~5 minutes at 1-second cadence)
- Implements exponential backoff reconnection (1s → 30s cap)
- Supports runtime subscribe/unsubscribe from multiple consumers (scalp engine, watchlist panels)

---

### Swing Engine

**Files:**
- [src/backend/Engine.ts](src/backend/Engine.ts) — Scoring and agent logic
- [src/backend/TradingSystem.ts](src/backend/TradingSystem.ts) — Execution, position management, lifecycle

**Timeframe:** 15-minute candles
**Instruments:** 9 USDT pairs (BTC, ETH, SOL, BNB, XRP, DOGE, AVAX, LINK, PEPE)

#### Scoring Pipeline

The engine computes a composite score ∈ [0, 100] from three independent agents:

| Agent | Weight | Signal Source | Bullish Condition |
|---|---|---|---|
| TrendAgent | 50% | EMA(20) vs EMA(50) | EMA20 > EMA50, slope increasing |
| MomentumAgent | 30% | RSI(14) | RSI > 55 (LONG), < 45 (SHORT) |
| PullbackAgent | 20% | Price proximity to EMA(20) | Price at/above EMA20 (LONG) |

Final score: `0.5 × trend + 0.3 × momentum + 0.2 × pullback`

Thresholds:
- Score > 62 → LONG candidate
- Score < 38 → SHORT candidate
- 38–62 → Neutral / no signal

#### Entry Timing Gates

Score alone is insufficient. Before an entry is staged for AI review, the following structural gates must all pass:

1. EMA20 > EMA50 for at least 3 consecutive bars (trend establishment)
2. EMA slope must be positive and accelerating
3. Price above EMA20 (LONG) or below EMA20 (SHORT)
4. Price breaks the prior 3-candle high (LONG) or low (SHORT), with ±0.3% tolerance
5. RSI(14) > 55 (LONG) or < 45 (SHORT)
6. Candle close must not be in the weakest 30% of its own range (bar quality filter)

#### Trade Management

- **Max concurrent positions:** 2
- **Global reentry cooldown:** 5 minutes after any new entry
- **Per-symbol cooldown:** 30 minutes after any position close on that symbol
- **Loss streak pause:** 1-hour automatic halt after 3 consecutive losing trades
- **Trailing stop logic:**
  - When unrealized profit ≥ 1.5× initial stop distance → SL moved to breakeven
  - When unrealized profit ≥ 2.0× initial stop distance → full trailing stop activation
- **Exit triggers:** Stop loss, take profit, or manual close via API

---

### Scalp Engine

**File:** [src/backend/scalping/ScalpingEngine.ts](src/backend/scalping/ScalpingEngine.ts)

**Timeframe:** 1-minute candles + live WebSocket ticks
**Hold duration:** Seconds to minutes

The scalp engine targets micro-momentum events rather than structural trend setups.

#### Entry Signal Construction

1. **Micro-momentum direction:** Net price change over the last 5 ticks must exceed 0.01% threshold in one direction
2. **Trend confirmation:** EMA(21) and RSI(7) from 1m candles must corroborate the tick direction
3. **Volatility gate:** Short-term volatility (recent ticks) must exceed a long-term baseline floor (prevents flat market entries)
4. **Noise gate:** If the ratio of directional flips in recent ticks exceeds 42%, the signal is rejected as whipsaw
5. **Entry score threshold:** Internal composite score must clear a minimum threshold before execution

#### Exit Logic

- ATR(1m)-based tight stop loss
- Fixed ATR multiple for take profit (smaller multiples than swing)
- No trailing stops; positions closed quickly on TP or SL

#### Diagnostic Logging

Each scalp trade records `scalpEntryQuality` diagnostics: tick momentum value, volatility ratio, flip rate, RSI(7), EMA(21) position, and final composite score. This supports post-hoc signal quality analysis.

---

### Portfolio Manager

**File:** [src/backend/portfolio/PortfolioManager.ts](src/backend/portfolio/PortfolioManager.ts)

The PortfolioManager enforces risk constraints across both engines simultaneously, acting as an atomic gatekeeper for capital allocation.

#### Risk Caps

| Constraint | Limit |
|---|---|
| Total risk across all open positions | 4% of account balance |
| Risk per symbol (any engine combined) | 2% of account balance |
| Max concurrent trades (swing) | 2 |
| Max concurrent trades (scalp) | 3 |

#### Capital Lifecycle

```
Engine signals entry
      ↓
requestCapital(engineId, symbol, riskAmount)   ← atomic check
      ↓ (approved)
Trade opened → registerTrade(engineId, tradeId, symbol, riskAtStop)
      ↓
Position monitored by engine
      ↓
Trade closed → closeTrade(tradeId, pnl) → balance updated & persisted
```

If `requestCapital` fails (cap exceeded), the entry is blocked regardless of signal strength.

---

### AI Gate

**File:** [src/backend/ai/OpenAIService.ts](src/backend/ai/OpenAIService.ts)

The AI gate is the final filter before any swing trade is executed. It queries an OpenAI model with a structured representation of the current signal and recent trading history.

#### Input Payload

```json
{
  "symbol": "BTCUSDT",
  "action": "BUY",
  "score": 74.2,
  "agents": {
    "trend": { "score": 82, "ema20": 95000, "ema50": 93500 },
    "momentum": { "score": 68, "rsi": 61.3 },
    "pullback": { "score": 55 }
  },
  "atr": { "value": 420.5, "pctOfPrice": 0.0044 },
  "trendStrength": { "ema20VsEma50PctSeparation": 0.016 },
  "recentTrades": [
    { "symbol": "ETHUSDT", "side": "LONG", "pnl": 12.4, "outcome": "win" }
  ]
}
```

#### System Prompt (abridged)

> You are a conservative trading risk assistant. You receive numeric agent scores, recent closed-trade outcomes, ATR-based volatility (as fraction of price), trend strength (EMA20 vs EMA50 separation as percent of price), and a proposed direction. Output ONLY valid JSON with keys: `decision` (BUY | SELL | HOLD), `confidence` (0–1), `reasoning` (short string). Use recent losses to be more cautious. Agree with the proposal only when indicators support it; use HOLD when uncertain or conflicting. Never predict specific future prices.

#### Gate Logic

| AI Output | Result |
|---|---|
| `confidence < 0.5` | Entry blocked |
| `decision = HOLD` | Entry blocked |
| `decision` opposes proposed action | Entry blocked |
| Agreement + `confidence ≥ 0.5` | Entry executed |

**Model:** `gpt-4o-mini` (default; overridable via `OPENAI_MODEL` env var)
**Parameters:** temperature=0.2, max_tokens=450

---

### Backtesting Engine

**Files:**
- [src/backend/backtest/BacktestRunner.ts](src/backend/backtest/BacktestRunner.ts)
- [scripts/backtest-cli.ts](scripts/backtest-cli.ts)

The backtesting engine replays historical OHLCV data through the full scoring, timing gate, and (optionally) AI gate pipeline with complete fee and risk simulation.

#### Parameters

| Parameter | Type | Description |
|---|---|---|
| `symbol` | string | e.g. `BTCUSDT` |
| `timeframe` | `5m` \| `15m` | Candle resolution |
| `days` | number | Lookback period (1–365) |
| `useAI` | boolean | Enable/disable AI gate during replay |
| `initialBalance` | number | Starting paper balance (USDT) |

#### Output Metrics

- Initial and final balance
- Total trades, wins, losses, win rate
- Average profit per winning trade, average loss per losing trade
- Profit factor (gross profit / gross loss)
- Maximum drawdown (peak-to-trough)
- Full trade log with entry/exit prices and net PnL per trade

Fees are simulated at 0.1% per side (0.2% round-trip). Minimum take-profit distance is enforced identically to live: `TP distance ≥ 2 × 0.001 × entry price`.

---

### Persistence Layer

**File:** [src/backend/persistence/StateStore.ts](src/backend/persistence/StateStore.ts)

State is persisted to JSON files in the `/data` directory:

| File | Contents |
|---|---|
| `data/swing-state.json` | Trade history, active positions, loss-streak pause flag |
| `data/scalp-state.json` | Same structure, separate engine scope |
| `data/portfolio-state.json` | Current account balance |

- Capped at 500 trades per file (rolling; oldest evicted first)
- One-time migration on boot: legacy `paper-state.json` → split files
- Balance written to disk after every trade close to prevent drift on restart

---

## Signal Composition

The swing engine's three-agent scoring system is designed such that each agent is independently interpretable and can be individually inspected via `/api/insights/:symbol`. The weighting (50/30/20) deliberately prioritizes structural trend alignment over momentum and pullback timing, reflecting the assumption that trend persistence is the most reliable factor in 15m crypto price action.

The scalp engine does not use the same agent framework. It operates on a shorter feedback loop where EMA/RSI signals from 1m candles serve only as direction confirmation, while primary signal generation is tick-based.

---

## Risk Model

### Position-Level Risk

For every trade entered by the swing engine:

```
risk_per_trade  = 0.01 × account_balance
stop_distance   = 2 × ATR(14)
position_size   = risk_per_trade / stop_distance
take_profit     = entry ± (3 × ATR(14))      [risk:reward ≈ 1:1.5]
```

Trailing stop activation:
- At 1.5× stop distance in profit → SL moved to breakeven
- At 2.0× stop distance in profit → SL trails price continuously

### Portfolio-Level Risk

The PortfolioManager caps total risk at 4% of balance regardless of engine count or signal strength. A per-symbol cap of 2% prevents concentration in any single asset.

### Fee Model

```
entry_fee = 0.001 × entry_price × quantity
exit_fee  = 0.001 × exit_price  × quantity
net_pnl   = gross_pnl − entry_fee − exit_fee
```

Minimum TP constraint enforced on all entries:
```
min_tp_distance = 2 × 0.001 × entry_price
```

Any signal where the ATR-derived TP falls below this floor is blocked.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 22+ |
| Language | TypeScript 5.8 |
| Backend framework | Express 4.21 |
| WebSocket client | ws 8.20 |
| HTTP client | Axios 1.14 |
| AI integration | OpenAI SDK 4.77 |
| Frontend framework | React 19 |
| Build tool | Vite 6.2 |
| Styling | Tailwind CSS 4.1 |
| Charts | lightweight-charts 5.1 |
| Animations | Motion 12.23 |
| Persistence | Node.js `fs` (JSON) |
| Market data | Binance REST + WebSocket |

---

## Installation & Setup

**Prerequisites:** Node.js 22+, npm

```bash
git clone <repo-url>
cd medallion-club-trading-system
npm install
```

Create a `.env` file in the project root:

```env
OPENAI_API_KEY=sk-...         # Required for AI gate
OPENAI_MODEL=gpt-4o-mini      # Optional; defaults to gpt-4o-mini
PORT=3000                     # Optional; defaults to 3000
```

`OPENAI_API_KEY` is required only if the AI gate is enabled. Without it, AI-gated entries will be blocked on API call failure.

---

## Running the System

**Development (hot reload):**
```bash
npm run dev
```

**Production build:**
```bash
npm run build
npm start
```

The server starts on port 3000. The React dashboard is served from the same process — navigate to `http://localhost:3000`. Both engines start automatically on server boot, restoring active positions from persisted state.

---

## Backtesting CLI

Run historical simulations directly from the terminal:

```bash
# Syntax
npm run backtest -- <SYMBOL> <DAYS> <TIMEFRAME> [--ai]

# Examples
npm run backtest -- BTCUSDT 30 15m
npm run backtest -- ETHUSDT 14 5m --ai
npm run backtest -- SOLUSDT 90 15m --ai
```

Output includes a complete trade log and summary statistics printed to stdout.

---

## API Reference

All endpoints are served at `http://localhost:3000`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/ping` | Health check (returns `pong`) |
| `GET` | `/api/status` | Aggregated status from both engines |
| `POST` | `/api/start` | Start swing + scalp engines |
| `POST` | `/api/stop` | Stop both engines |
| `GET` | `/api/ohlcv/:symbol` | OHLCV candles for a symbol |
| `GET` | `/api/insights/:symbol` | Per-agent scoring breakdown |
| `GET` | `/api/performance` | Combined win/loss/PnL statistics |
| `GET` | `/api/scalp/status` | Scalp engine dashboard snapshot |
| `POST` | `/api/backtest` | Run backtest with JSON body params |

`/api/status` response merges both engine states and includes: active positions, trade history, balance, engine run state, and current scoring per watched symbol.

---

## Project Structure

```
medallion-club-trading-system/
├── src/
│   ├── backend/
│   │   ├── ai/
│   │   │   └── OpenAIService.ts        # AI gate integration
│   │   ├── backtest/
│   │   │   └── BacktestRunner.ts       # Historical replay engine
│   │   ├── data/
│   │   │   └── WebSocketManager.ts     # Singleton WS manager
│   │   ├── persistence/
│   │   │   └── StateStore.ts           # JSON state read/write
│   │   ├── portfolio/
│   │   │   └── PortfolioManager.ts     # Cross-engine risk coordination
│   │   ├── scalping/
│   │   │   └── ScalpingEngine.ts       # 1m scalp strategy
│   │   ├── Agents.ts                   # TrendAgent, MomentumAgent, PullbackAgent
│   │   ├── DataLayer.ts                # Binance REST + WS abstraction
│   │   ├── Engine.ts                   # Swing scoring engine
│   │   ├── TradingSystem.ts            # Swing execution & lifecycle
│   │   ├── fees.ts                     # Fee model
│   │   └── types.ts                    # Shared TypeScript types
│   ├── components/
│   │   └── dashboard/                  # React dashboard panels
│   ├── constants/                      # App-wide constants
│   ├── App.tsx                         # Root React component
│   ├── config.ts                       # API base URL config
│   ├── main.tsx                        # React DOM mount
│   └── server.ts                       # Express server + route definitions
├── scripts/
│   └── backtest-cli.ts                 # CLI entrypoint for backtests
├── data/                               # Runtime state (gitignored)
│   ├── swing-state.json
│   ├── scalp-state.json
│   └── portfolio-state.json
├── public/                             # Static assets
├── dist/                               # Vite build output
├── .env.example
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Configuration

Behavioral parameters are defined as constants in source rather than runtime config, reflecting their role as design decisions. Key tunables and their locations:

| Parameter | Location | Default |
|---|---|---|
| Swing score thresholds | [src/backend/Engine.ts](src/backend/Engine.ts) | 62 / 38 |
| ATR stop multiplier | [src/backend/TradingSystem.ts](src/backend/TradingSystem.ts) | 2× |
| ATR TP multiplier | [src/backend/TradingSystem.ts](src/backend/TradingSystem.ts) | 3× |
| Risk per trade | [src/backend/TradingSystem.ts](src/backend/TradingSystem.ts) | 1% |
| Max concurrent swing positions | [src/backend/TradingSystem.ts](src/backend/TradingSystem.ts) | 2 |
| Global entry cooldown | [src/backend/TradingSystem.ts](src/backend/TradingSystem.ts) | 5 min |
| Per-symbol reentry cooldown | [src/backend/TradingSystem.ts](src/backend/TradingSystem.ts) | 30 min |
| Loss streak pause | [src/backend/TradingSystem.ts](src/backend/TradingSystem.ts) | 3 losses → 1h |
| Portfolio total risk cap | [src/backend/portfolio/PortfolioManager.ts](src/backend/portfolio/PortfolioManager.ts) | 4% |
| Per-symbol risk cap | [src/backend/portfolio/PortfolioManager.ts](src/backend/portfolio/PortfolioManager.ts) | 2% |
| AI confidence threshold | [src/backend/ai/OpenAIService.ts](src/backend/ai/OpenAIService.ts) | 0.5 |
| Scalp noise gate (flip ratio) | [src/backend/scalping/ScalpingEngine.ts](src/backend/scalping/ScalpingEngine.ts) | 42% |
| Scalp tick window | [src/backend/scalping/ScalpingEngine.ts](src/backend/scalping/ScalpingEngine.ts) | 5 ticks |
| Taker fee rate | [src/backend/fees.ts](src/backend/fees.ts) | 0.10% |
| WS tick buffer | [src/backend/data/WebSocketManager.ts](src/backend/data/WebSocketManager.ts) | 300 ticks |
