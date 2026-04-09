/**
 * Back-compat re-export — unified persistence lives in `storage/StateStore.ts`.
 */
export type { EngineStateSnapshot, PersistedState } from '../storage/StateStore';
export {
  StateStore,
  loadState,
  registerSnapshotBuilder,
  scheduleSave,
  saveState,
  saveStateNow,
} from '../storage/StateStore';
