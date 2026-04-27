import crypto from 'crypto';
import {
  DEFAULT_PARAMETER_SET_ID,
  type ParameterSchema,
  type ParameterSet,
  type StrategyFamily,
} from './ParameterSet';
import { readEvolutionJson, writeEvolutionJson } from './EvolutionStorage';

const PARAMETER_SETS_FILE = 'parameter_sets.json';

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashParameters(parameters: Record<string, number | string | boolean>): string {
  return crypto.createHash('sha256').update(stableStringify(parameters)).digest('hex').slice(0, 12);
}

const DEFAULT_SCHEMAS: ParameterSchema[] = [
  {
    parameterKey: 'profile',
    type: 'enum',
    allowedValues: ['baseline'],
    defaultValue: 'baseline',
    mutation: { mutable: false },
    riskCritical: false,
  },
];

export const DEFAULT_PARAMETER_SETS: ParameterSet[] = [
  defaultParameterSet('swing', DEFAULT_PARAMETER_SET_ID),
  defaultParameterSet('scalp', 'p1-scalp'),
];

function defaultParameterSet(family: StrategyFamily, parameterSetId: string): ParameterSet {
  return {
    parameterSetId,
    strategyFamily: family,
    parameters: { profile: 'baseline' },
    schemaVersion: '1',
    hash: hashParameters({ profile: 'baseline' }),
    createdAt: 0,
    createdBy: 'human',
  };
}

export class ParameterStore {
  private parameterSets: ParameterSet[] = [];
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    const existing = await readEvolutionJson<ParameterSet[]>(PARAMETER_SETS_FILE, []);
    const byId = new Map(existing.map((p) => [p.parameterSetId, p]));
    for (const set of DEFAULT_PARAMETER_SETS) {
      if (!byId.has(set.parameterSetId)) existing.push(set);
    }
    this.parameterSets = existing;
    await this.save();
    this.loaded = true;
  }

  async loadSchema(): Promise<ParameterSchema[]> {
    return DEFAULT_SCHEMAS;
  }

  async all(): Promise<ParameterSet[]> {
    await this.load();
    return [...this.parameterSets];
  }

  static async listParameterSets(): Promise<ParameterSet[]> {
    return parameterStore.all();
  }

  async get(parameterSetId: string): Promise<ParameterSet | null> {
    await this.load();
    return this.parameterSets.find((p) => p.parameterSetId === parameterSetId) ?? null;
  }

  async createParameterSet(params: {
    strategyFamily: StrategyFamily;
    parameters: Record<string, number | string | boolean>;
    createdBy: ParameterSet['createdBy'];
    baseParameterSetId?: string;
    mutationMetadata?: ParameterSet['mutationMetadata'];
  }): Promise<ParameterSet> {
    await this.load();
    const schema = await this.loadSchema();
    this.validateParameterSet(params.parameters, schema, params.baseParameterSetId);

    const hash = hashParameters(params.parameters);
    const parameterSetId = `p-${params.strategyFamily}-${hash}`;
    const existing = this.parameterSets.find((p) => p.parameterSetId === parameterSetId);
    if (existing) return existing;

    const set: ParameterSet = {
      parameterSetId,
      strategyFamily: params.strategyFamily,
      parameters: params.parameters,
      schemaVersion: '1',
      hash,
      createdAt: Date.now(),
      createdBy: params.createdBy,
      baseParameterSetId: params.baseParameterSetId,
      mutationMetadata: params.mutationMetadata,
    };
    this.parameterSets.push(set);
    await this.save();
    return set;
  }

  validateParameterSet(
    parameters: Record<string, number | string | boolean>,
    schema: ParameterSchema[] = DEFAULT_SCHEMAS,
    baseParameterSetId?: string
  ): void {
    const byKey = new Map(schema.map((s) => [s.parameterKey, s]));
    for (const [key, value] of Object.entries(parameters)) {
      const rule = byKey.get(key);
      if (!rule) throw new Error(`[ParameterStore] Unknown parameter: ${key}`);

      if (rule.type === 'number' && typeof value !== 'number') throw new Error(`[ParameterStore] ${key} must be number`);
      if (rule.type === 'integer' && (!Number.isInteger(value))) throw new Error(`[ParameterStore] ${key} must be integer`);
      if (rule.type === 'boolean' && typeof value !== 'boolean') throw new Error(`[ParameterStore] ${key} must be boolean`);
      if (rule.type === 'enum' && !rule.allowedValues?.includes(String(value))) {
        throw new Error(`[ParameterStore] ${key} must be one of ${rule.allowedValues?.join(', ')}`);
      }
      if (typeof value === 'number') {
        if (rule.min !== undefined && value < rule.min) throw new Error(`[ParameterStore] ${key} below min`);
        if (rule.max !== undefined && value > rule.max) throw new Error(`[ParameterStore] ${key} above max`);
      }
    }

    if (baseParameterSetId) {
      const base = this.parameterSets.find((p) => p.parameterSetId === baseParameterSetId);
      if (!base) throw new Error(`[ParameterStore] Base parameter set not found: ${baseParameterSetId}`);
      for (const [key, value] of Object.entries(parameters)) {
        const rule = byKey.get(key);
        const oldValue = base.parameters[key];
        if (!rule || oldValue === undefined || oldValue === value) continue;
        if (!rule.mutation.mutable) throw new Error(`[ParameterStore] ${key} is immutable`);
        if (typeof value === 'number' && typeof oldValue === 'number') {
          if (rule.mutation.maxAbsoluteDelta !== undefined && Math.abs(value - oldValue) > rule.mutation.maxAbsoluteDelta) {
            throw new Error(`[ParameterStore] ${key} absolute delta too large`);
          }
          if (rule.mutation.maxRelativeDeltaPct !== undefined && oldValue !== 0) {
            const rel = Math.abs((value - oldValue) / oldValue);
            if (rel > rule.mutation.maxRelativeDeltaPct) throw new Error(`[ParameterStore] ${key} relative delta too large`);
          }
        }
      }
    }
  }

  private async save(): Promise<void> {
    await writeEvolutionJson(PARAMETER_SETS_FILE, this.parameterSets);
  }
}

export const parameterStore = new ParameterStore();
