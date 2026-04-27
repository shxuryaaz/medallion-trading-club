export type StrategyFamily = 'swing' | 'scalp';

export type StrategyVersionStatus =
  | 'CREATED'
  | 'BACKTESTING'
  | 'PAPER_TESTING'
  | 'CANARY'
  | 'ACTIVE'
  | 'CHAMPION'
  | 'RETIRED'
  | 'KILLED';

export interface StrategyVersion {
  strategyVersionId: string;
  strategyFamily: StrategyFamily;
  codeVersion: string;
  parameterSetId: string;
  parentVersionId?: string;
  status: StrategyVersionStatus;
  createdAt: number;
  activatedAt?: number;
  retiredAt?: number;
  immutableHash: string;
  notes?: string;
}

export interface ActiveVersions {
  swing: string;
  scalp: string;
}

export const DEFAULT_STRATEGY_VERSION_ID = 'v1';
export const DEFAULT_PARAMETER_SET_ID = 'p1';
