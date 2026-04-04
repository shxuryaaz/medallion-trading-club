import fs from 'fs';
import path from 'path';
import type { Position } from '../Engine';
import type { TradeLog } from '../types';

const DATA_DIR = path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'paper-state.json');

export interface PaperStateSnapshot {
  balance: number;
  tradeHistory: TradeLog[];
  activePositions: Position[];
  /** Unix ms: no new entries until this time after 3 consecutive losses. */
  lossStreakPauseUntil?: number;
}

export class StateStore {
  static load(): PaperStateSnapshot | null {
    try {
      if (!fs.existsSync(STATE_FILE)) return null;
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as PaperStateSnapshot;
      if (typeof parsed.balance !== 'number' || !Array.isArray(parsed.tradeHistory) || !Array.isArray(parsed.activePositions)) {
        return null;
      }
      return parsed;
    } catch (e) {
      console.error('[StateStore] load failed:', e);
      return null;
    }
  }

  static save(snapshot: PaperStateSnapshot): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const maxTrades = 500;
      const tradeHistory =
        snapshot.tradeHistory.length > maxTrades
          ? snapshot.tradeHistory.slice(-maxTrades)
          : snapshot.tradeHistory;
      fs.writeFileSync(STATE_FILE, JSON.stringify({ ...snapshot, tradeHistory }, null, 0), 'utf-8');
    } catch (e) {
      console.error('[StateStore] save failed:', e);
    }
  }
}
