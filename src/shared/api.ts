import {Issue} from './schema';
import {CompatibilityReport, Direction} from './compat';

export type UnknownPolicy = 'fail' | 'passthrough';

export interface CompareInput {
  v1: unknown;
  v2: unknown;
  policy: UnknownPolicy;
}

export interface CompareResponse {
  policy: UnknownPolicy;
  lint: { v1: Issue[]; v2: Issue[] };
  report: CompatibilityReport;
  cache: {
    keys: { backward: string; forward: string };
    hits: { backward: boolean; forward: boolean };
    totalMs: number;
  };
}

export type {CompatibilityReport, Counterexample, DirectionResult, Direction, UnionHop} from './compat';
