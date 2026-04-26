import crypto from 'crypto';
import type { StrategyFamily, StrategyVersion } from './StrategyVersion';
import { readEvolutionJson, writeEvolutionJson } from './EvolutionStorage';
import { DEFAULT_PARAMETER_SETS, ParameterStore } from './ParameterStore';

const VERSIONS_FILE = 'strategy_versions.json';
const ACTIVE_FILE = 'active_versions.json';

const now = () => Date.now();

export const DEFAULT_STRATEGY_VERSIONS: StrategyVersion[] = [
  {
    strategyVersionId: 'v1',
    strategyFamily: 'swing',
    codeVersion: process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || 'local',
    parameterSetId: 'p1',
    status: 'CHAMPION',
    createdAt: 0,
    activatedAt: 0,
    immutableHash: 'bootstrap-v1-swing-p1',
    notes: 'Initial swing strategy version',
  },
  {
    strategyVersionId: 'v1-scalp',
    strategyFamily: 'scalp',
    codeVersion: process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || 'local',
    parameterSetId: 'p1-scalp',
    status: 'CHAMPION',
    createdAt: 0,
    activatedAt: 0,
    immutableHash: 'bootstrap-v1-scalp-p1-scalp',
    notes: 'Initial scalp strategy version',
  },
];

const DEFAULT_ACTIVE: Record<StrategyFamily, string> = {
  swing: 'v1',
  scalp: 'v1-scalp',
};

function versionHash(version: Omit<StrategyVersion, 'immutableHash'>): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(version))
    .digest('hex')
    .slice(0, 16);
}

function buildVersionId(strategyFamily: StrategyFamily, parameterSetId: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const shortHash = crypto
    .createHash('sha256')
    .update(`${strategyFamily}:${parameterSetId}:${stamp}:${Math.random()}`)
    .digest('hex')
    .slice(0, 6);
  return `${strategyFamily}-${stamp}-${shortHash}`;
}

export class StrategyVersionManager {
  static async listVersions(): Promise<StrategyVersion[]> {
    return readEvolutionJson<StrategyVersion[]>(VERSIONS_FILE, DEFAULT_STRATEGY_VERSIONS);
  }

  static async getActiveVersion(strategyFamily: StrategyFamily): Promise<StrategyVersion> {
    const [versions, active] = await Promise.all([
      this.listVersions(),
      readEvolutionJson<Record<StrategyFamily, string>>(ACTIVE_FILE, DEFAULT_ACTIVE),
    ]);
    const activeId = active[strategyFamily] ?? DEFAULT_ACTIVE[strategyFamily];
    return (
      versions.find((v) => v.strategyFamily === strategyFamily && v.strategyVersionId === activeId) ??
      versions.find((v) => v.strategyFamily === strategyFamily && v.status === 'CHAMPION') ??
      DEFAULT_STRATEGY_VERSIONS.find((v) => v.strategyFamily === strategyFamily)!
    );
  }

  static async setActiveVersion(strategyFamily: StrategyFamily, versionId: string): Promise<void> {
    const versions = await this.listVersions();
    if (!versions.some((v) => v.strategyFamily === strategyFamily && v.strategyVersionId === versionId)) {
      throw new Error(`Unknown ${strategyFamily} strategy version: ${versionId}`);
    }
    const active = await readEvolutionJson<Record<StrategyFamily, string>>(ACTIVE_FILE, DEFAULT_ACTIVE);
    active[strategyFamily] = versionId;
    await writeEvolutionJson(ACTIVE_FILE, active);
  }

  static async createVersion(
    parentVersionId: string | undefined,
    parameterSetId: string
  ): Promise<StrategyVersion> {
    const [versions, params] = await Promise.all([
      this.listVersions(),
      ParameterStore.listParameterSets(),
    ]);
    const parameterSet = params.find((p) => p.parameterSetId === parameterSetId);
    if (!parameterSet) throw new Error(`Unknown parameter set: ${parameterSetId}`);

    if (parentVersionId && !versions.some((v) => v.strategyVersionId === parentVersionId)) {
      throw new Error(`Unknown parent strategy version: ${parentVersionId}`);
    }

    const base: Omit<StrategyVersion, 'immutableHash'> = {
      strategyVersionId: buildVersionId(parameterSet.strategyFamily, parameterSetId),
      strategyFamily: parameterSet.strategyFamily,
      codeVersion: process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || 'local',
      parameterSetId,
      parentVersionId,
      status: 'CREATED',
      createdAt: now(),
    };

    const version: StrategyVersion = {
      ...base,
      immutableHash: versionHash(base),
    };

    await writeEvolutionJson(VERSIONS_FILE, [...versions, version]);
    return version;
  }

  static async retireVersion(versionId: string): Promise<void> {
    const versions = await this.listVersions();
    const idx = versions.findIndex((v) => v.strategyVersionId === versionId);
    if (idx === -1) throw new Error(`Unknown strategy version: ${versionId}`);
    const version = versions[idx];
    if (version.status === 'RETIRED' || version.status === 'KILLED') return;
    versions[idx] = { ...version, status: 'RETIRED', retiredAt: now() };
    await writeEvolutionJson(VERSIONS_FILE, versions);
  }

  static async ensureDefaults(): Promise<void> {
    const params = await ParameterStore.listParameterSets();
    const missingParams = DEFAULT_PARAMETER_SETS.filter(
      (p) => !params.some((existing) => existing.parameterSetId === p.parameterSetId)
    );
    if (missingParams.length > 0) {
      await writeEvolutionJson('parameter_sets.json', [...params, ...missingParams]);
    }

    const versions = await this.listVersions();
    const missingVersions = DEFAULT_STRATEGY_VERSIONS.filter(
      (v) => !versions.some((existing) => existing.strategyVersionId === v.strategyVersionId)
    );
    if (missingVersions.length > 0) {
      await writeEvolutionJson(VERSIONS_FILE, [...versions, ...missingVersions]);
    }

    const active = await readEvolutionJson<Record<StrategyFamily, string>>(ACTIVE_FILE, DEFAULT_ACTIVE);
    await writeEvolutionJson(ACTIVE_FILE, { ...DEFAULT_ACTIVE, ...active });
    await readEvolutionJson('experiments.json', []);
  }
}
