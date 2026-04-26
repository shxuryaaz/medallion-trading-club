export type StrategyFamily = 'swing' | 'scalp';

export type ParameterValue = number | string | boolean;
export const DEFAULT_PARAMETER_SET_ID = 'p1';
export const DEFAULT_SCALP_PARAMETER_SET_ID = 'p1-scalp';

export interface ParameterMutationRule {
  mutable: boolean;
  maxRelativeDeltaPct?: number;
  maxAbsoluteDelta?: number;
  stepSize?: number;
}

export interface ParameterSchema {
  parameterKey: string;
  type: 'number' | 'integer' | 'boolean' | 'enum';
  min?: number;
  max?: number;
  allowedValues?: string[];
  defaultValue: ParameterValue;
  mutation: ParameterMutationRule;
  riskCritical: boolean;
}

export interface ParameterSet {
  parameterSetId: string;
  strategyFamily: StrategyFamily;
  parameters: Record<string, ParameterValue>;
  schemaVersion: string;
  hash: string;
  createdAt: number;
  createdBy: 'human' | 'mutation-engine';
  baseParameterSetId?: string;
  mutationMetadata?: {
    mutationRunId: string;
    changedKeys: string[];
    rationale: string;
  };
}

export interface ParameterDelta {
  parameterKey: string;
  oldValue: ParameterValue;
  newValue: ParameterValue;
}
