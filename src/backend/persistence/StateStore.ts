import fs from 'fs';
import path from 'path';
import type { Position } from '../Engine';
import type { TradeLog } from '../types';

const DATA_DIR = path.join(process.cwd(), 'data');

// Per-engine snapshot (no balance — PortfolioManager owns that)
export interface EngineStateSnapshot {
  tradeHistory: TradeLog[];
  activePositions: Position[];
  lossStreakPauseUntil?: number;
}

// Legacy snapshot format from paper-state.json (balance included)
export interface PaperStateSnapshot extends EngineStateSnapshot {
  balance: number;
}

// Portfolio-level state (balance only)
export interface PortfolioStateSnapshot {
  balance: number;
}

function filePath(key: string): string {
  return path.join(DATA_DIR, `${key}-state.json`);
}

function readJson<T>(fp: string): T | null {
  try {
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (e) {
    console.error(`[StateStore] read failed (${fp}):`, e);
    return null;
  }
}

function writeJson(fp: string, data: unknown): void {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(data, null, 0), 'utf-8');
  } catch (e) {
    console.error(`[StateStore] write failed (${fp}):`, e);
  }
}

export class StateStore {
  /**
   * Load per-engine state.
   * Falls back to legacy paper-state.json when key === 'swing' and the new file
   * doesn't exist yet (one-time migration on first boot after refactor).
   */
  static load(key: string): EngineStateSnapshot | null {
    const newFile = filePath(key);
    const snap = readJson<EngineStateSnapshot>(newFile);
    if (snap && Array.isArray(snap.tradeHistory) && Array.isArray(snap.activePositions)) {
      return snap;
    }

    // One-time migration: swing engine was previously paper-state.json
    if (key === 'swing') {
      const legacy = readJson<PaperStateSnapshot>(path.join(DATA_DIR, 'paper-state.json'));
      if (legacy && Array.isArray(legacy.tradeHistory) && Array.isArray(legacy.activePositions)) {
        console.log('[StateStore] Migrating paper-state.json → swing-state.json');
        this.save('swing', legacy);
        return legacy;
      }
    }

    return null;
  }

  static save(key: string, snapshot: EngineStateSnapshot): void {
    const maxTrades = 500;
    const capped: EngineStateSnapshot = {
      ...snapshot,
      tradeHistory:
        snapshot.tradeHistory.length > maxTrades
          ? snapshot.tradeHistory.slice(-maxTrades)
          : snapshot.tradeHistory,
    };
    writeJson(filePath(key), capped);
  }

  static loadPortfolio(): PortfolioStateSnapshot | null {
    const snap = readJson<PortfolioStateSnapshot>(filePath('portfolio'));
    if (snap && typeof snap.balance === 'number') return snap;

    // Migration: read starting balance from legacy paper-state.json
    const legacy = readJson<PaperStateSnapshot>(path.join(DATA_DIR, 'paper-state.json'));
    if (legacy && typeof legacy.balance === 'number') {
      console.log(`[StateStore] Migrating balance from paper-state.json: ${legacy.balance}`);
      const portfolioSnap = { balance: legacy.balance };
      this.savePortfolio(portfolioSnap);
      return portfolioSnap;
    }

    return null;
  }

  static savePortfolio(snapshot: PortfolioStateSnapshot): void {
    writeJson(filePath('portfolio'), snapshot);
  }
}
