import fs from 'fs/promises';
import path from 'path';
import type { Position } from '../Engine';
import type { TradeLog } from '../types';

const DATA_DIR = process.env.DATA_DIR?.trim() || path.join(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DEBOUNCE_MS = 200;
const MAX_TRADES_PER_ENGINE = 500;
const LIVE_TRADING_ENABLED = process.env.BINANCE_ENABLED === 'true';
const REQUIRE_PERSISTED_STATE_ON_LIVE =
  process.env.REQUIRE_PERSISTED_STATE === 'true' ||
  process.env.REQUIRE_PERSISTED_STATE_ON_LIVE === 'true';

/** Per-engine persisted slice (swing / scalp). */
export interface EngineStateSnapshot {
  tradeHistory: TradeLog[];
  activePositions: Position[];
  lossStreakPauseUntil?: number;
  performanceLockoutUntil?: number;
  softPauseUntil?: number;
  riskMultiplier?: number;
}

/** Unified file shape (single `state.json`). */
export type PersistedState = {
  balance: number;
  swing: EngineStateSnapshot;
  scalp: EngineStateSnapshot;
};

/** @deprecated Legacy combined paper file */
interface PaperStateSnapshot extends EngineStateSnapshot {
  balance: number;
}

function freshState(): PersistedState {
  return {
    balance: 10_000,
    swing: { tradeHistory: [], activePositions: [] },
    scalp: { tradeHistory: [], activePositions: [] },
  };
}

function warnFreshLiveState(reason: string): void {
  console.warn(
    `[STATE] WARNING: starting with fresh empty state while BINANCE_ENABLED=true (${reason}). ` +
      `Trading will continue, but local trade history/open-position memory may be incomplete. ` +
      `Configure DATA_DIR to durable storage when available. stateFile=${STATE_FILE}`
  );
}

function normalizeEngine(e: Partial<EngineStateSnapshot> | null | undefined): EngineStateSnapshot {
  return {
    tradeHistory: Array.isArray(e?.tradeHistory) ? e!.tradeHistory : [],
    activePositions: Array.isArray(e?.activePositions) ? e!.activePositions : [],
    lossStreakPauseUntil:
      typeof e?.lossStreakPauseUntil === 'number' && Number.isFinite(e.lossStreakPauseUntil)
        ? e.lossStreakPauseUntil
        : undefined,
    performanceLockoutUntil:
      typeof e?.performanceLockoutUntil === 'number' && Number.isFinite(e.performanceLockoutUntil)
        ? e.performanceLockoutUntil
        : undefined,
    softPauseUntil:
      typeof e?.softPauseUntil === 'number' && Number.isFinite(e.softPauseUntil)
        ? e.softPauseUntil
        : undefined,
    riskMultiplier:
      typeof e?.riskMultiplier === 'number' && Number.isFinite(e.riskMultiplier)
        ? e.riskMultiplier
        : undefined,
  };
}

function capEngine(snap: EngineStateSnapshot): EngineStateSnapshot {
  const th = snap.tradeHistory;
  return {
    ...snap,
    tradeHistory:
      th.length > MAX_TRADES_PER_ENGINE ? th.slice(-MAX_TRADES_PER_ENGINE) : th,
  };
}

function capPersisted(state: PersistedState): PersistedState {
  return {
    balance: state.balance,
    swing: capEngine(state.swing),
    scalp: capEngine(state.scalp),
  };
}

function tradeCounts(state: PersistedState): { open: number; closed: number } {
  const closed = (hist: TradeLog[]) => hist.filter((t) => t.status === 'CLOSED').length;
  return {
    open: state.swing.activePositions.length + state.scalp.activePositions.length,
    closed: closed(state.swing.tradeHistory) + closed(state.scalp.tradeHistory),
  };
}

async function readJsonFile<T>(fp: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(fp, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function atomicWriteState(state: PersistedState): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(state, null, 0);
  const tmp = path.join(DATA_DIR, `.state.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, payload, 'utf8');
  try {
    await fs.rename(tmp, STATE_FILE);
  } catch {
    await fs.rm(STATE_FILE, { force: true }).catch(() => {});
    await fs.rename(tmp, STATE_FILE);
  }
}

async function tryMigrateLegacy(): Promise<PersistedState | null> {
  const portfolioPath = path.join(DATA_DIR, 'portfolio-state.json');
  const swingPath = path.join(DATA_DIR, 'swing-state.json');
  const scalpPath = path.join(DATA_DIR, 'scalp-state.json');
  const paperPath = path.join(DATA_DIR, 'paper-state.json');

  const portfolio = await readJsonFile<{ balance: number }>(portfolioPath);
  const swingFile = await readJsonFile<EngineStateSnapshot>(swingPath);
  const scalpFile = await readJsonFile<EngineStateSnapshot>(scalpPath);
  const paper = await readJsonFile<PaperStateSnapshot>(paperPath);

  const hasAny =
    portfolio != null ||
    swingFile != null ||
    scalpFile != null ||
    (paper != null &&
      Array.isArray((paper as PaperStateSnapshot).tradeHistory) &&
      Array.isArray((paper as PaperStateSnapshot).activePositions));

  if (!hasAny) return null;

  let balance = 10_000;
  if (portfolio && typeof portfolio.balance === 'number' && Number.isFinite(portfolio.balance)) {
    balance = portfolio.balance;
  } else if (paper && typeof paper.balance === 'number' && Number.isFinite(paper.balance)) {
    balance = paper.balance;
  }

  let swing: EngineStateSnapshot;
  if (swingFile && Array.isArray(swingFile.tradeHistory) && Array.isArray(swingFile.activePositions)) {
    swing = normalizeEngine(swingFile);
  } else if (paper && Array.isArray(paper.tradeHistory) && Array.isArray(paper.activePositions)) {
    swing = normalizeEngine(paper);
  } else {
    swing = { tradeHistory: [], activePositions: [] };
  }

  const scalp =
    scalpFile && Array.isArray(scalpFile.tradeHistory) && Array.isArray(scalpFile.activePositions)
      ? normalizeEngine(scalpFile)
      : { tradeHistory: [], activePositions: [] };

  const merged: PersistedState = { balance, swing, scalp };
  try {
    await atomicWriteState(capPersisted(merged));
    console.log('[STATE] Migrated legacy JSON files → state.json');
  } catch (e) {
    console.warn('[STATE] Migration assembled in memory but failed to write state.json:', e);
  }
  return merged;
}

function validatePersisted(raw: unknown): PersistedState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.balance !== 'number' || !Number.isFinite(o.balance)) return null;
  if (typeof o.swing !== 'object' || o.swing === null) return null;
  if (typeof o.scalp !== 'object' || o.scalp === null) return null;
  const sw = o.swing as Record<string, unknown>;
  const sc = o.scalp as Record<string, unknown>;
  if (!Array.isArray(sw.tradeHistory) || !Array.isArray(sw.activePositions)) return null;
  if (!Array.isArray(sc.tradeHistory) || !Array.isArray(sc.activePositions)) return null;
  return {
    balance: o.balance,
    swing: normalizeEngine(sw as unknown as Partial<EngineStateSnapshot>),
    scalp: normalizeEngine(sc as unknown as Partial<EngineStateSnapshot>),
  };
}

/**
 * Load persisted trading state. Missing state stays non-fatal by default so free
 * ephemeral hosts can keep trading; set REQUIRE_PERSISTED_STATE_ON_LIVE=true to
 * make missing/invalid live state fatal.
 */
export async function loadState(): Promise<PersistedState> {
  let fallbackReason = 'state.json missing';
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const valid = validatePersisted(parsed);
    if (valid) {
      const normalized: PersistedState = {
        balance: valid.balance,
        swing: normalizeEngine(valid.swing),
        scalp: normalizeEngine(valid.scalp),
      };
      const { open, closed } = tradeCounts(normalized);
      console.log(
        `[STATE] Loaded balance=${normalized.balance.toFixed(2)} open=${open} closed=${closed}`
      );
      return normalized;
    }
    fallbackReason = 'state.json invalid or incomplete shape';
    console.warn('[STATE] state.json invalid or incomplete shape — fallback / migrate');
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err?.code !== 'ENOENT') {
      fallbackReason = 'state.json unreadable or corrupted';
      console.warn('[STATE] state.json unreadable or corrupted — fallback / migrate:', e);
    }
  }

  const migrated = await tryMigrateLegacy();
  if (migrated) {
    const { open, closed } = tradeCounts(migrated);
    console.log(`[STATE] Loaded balance=${migrated.balance.toFixed(2)} open=${open} closed=${closed}`);
    return migrated;
  }

  if (LIVE_TRADING_ENABLED) {
    if (REQUIRE_PERSISTED_STATE_ON_LIVE) {
      throw new Error(
        `[STATE] Refusing to start with fresh empty state while BINANCE_ENABLED=true (${fallbackReason}). ` +
          `Configure DATA_DIR to durable storage and restore ${STATE_FILE}, or unset REQUIRE_PERSISTED_STATE_ON_LIVE.`
      );
    }
    warnFreshLiveState(fallbackReason);
  }

  const fresh = freshState();
  console.log(`[STATE] Loaded balance=${fresh.balance.toFixed(2)} open=0 closed=0 (fresh defaults)`);
  return fresh;
}

let snapshotBuilder: (() => PersistedState) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight = false;

/**
 * Register how to build the full snapshot (called once from server after engines exist).
 */
export function registerSnapshotBuilder(fn: () => PersistedState): void {
  snapshotBuilder = fn;
}

/** Debounced persist of full state (balance + both engines). */
export function scheduleSave(): void {
  if (!snapshotBuilder) return;
  if (debounceTimer != null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void flushSave();
  }, DEBOUNCE_MS);
}

/** Alias: debounced `saveState` on any balance / trade change. */
export const saveState = scheduleSave;

async function flushSave(): Promise<void> {
  if (!snapshotBuilder || flushInFlight) return;
  flushInFlight = true;
  try {
    const state = capPersisted(snapshotBuilder());
    await atomicWriteState(state);
    const { open, closed } = tradeCounts(state);
    console.log(
      `[STATE] Saved balance=${state.balance.toFixed(2)} open=${open} closed=${closed}`
    );
  } catch (e) {
    console.error('[STATE] Save failed:', e);
  } finally {
    flushInFlight = false;
  }
}

/** @internal For tests / shutdown hooks */
export async function saveStateNow(): Promise<void> {
  if (!snapshotBuilder) return;
  const state = capPersisted(snapshotBuilder());
  await atomicWriteState(state);
}

/** Static facade matching older call sites. */
export class StateStore {
  static loadState = loadState;
  static registerSnapshotBuilder = registerSnapshotBuilder;
  /** Debounced full save (replaces legacy per-key save). */
  static scheduleSave = scheduleSave;
  static saveState = saveState;
  static saveStateNow = saveStateNow;
}
