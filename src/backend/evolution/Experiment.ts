import type { StrategyFamily } from './StrategyVersion';

export type ExperimentStatus = 'CREATED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'KILLED';

export interface VersionAllocation {
  versionId: string;
  trafficPct: number;
  maxRiskPct: number;
  maxNotionalPct: number;
}

export interface PromotionCriteria {
  minTrades: number;
  minExpectancyR: number;
  minProfitFactor: number;
  maxDrawdownPct: number;
}

export interface KillCriteria {
  minTrades: number;
  minExpectancyR: number;
  maxDrawdownPct: number;
}

export interface Experiment {
  experimentId: string;
  strategyFamily: StrategyFamily;
  championVersionId: string;
  candidateVersionIds: string[];
  status: ExperimentStatus;
  allocation: VersionAllocation[];
  startAt: number;
  endAt?: number;
  minTradesPerCandidate: number;
  minRuntimeMs: number;
  promotionCriteria: PromotionCriteria;
  killCriteria: KillCriteria;
}
