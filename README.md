<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Medallion Club Trading System

Full-stack paper trading dashboard: rule-based scoring, optional OpenAI second opinion on executions, Binance public market data.

View your app in AI Studio: https://ai.studio/apps/96b3da2b-a384-479f-b305-4be79c048cf4

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` or `.env.local` and set `OPENAI_API_KEY` (required for the hybrid AI gate on live scans; insights polling stays numeric-only).
3. Run the app: `npm run dev`

Paper state (balance, open positions, trade history) is stored under `data/paper-state.json`.
