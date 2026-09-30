import {
  Schema,
  applyDefaultPolicy,
  canonicalize,
  lintSchema,
  parseSchema,
} from '../shared/schema';
import { Direction, DirectionResult, compareSchemas } from '../shared/compat';
import { CompareInput, CompareResponse } from '../shared/api';

export type {CompareInput, CompareResponse} from '../shared/api';

// Cache keys include BOTH the compatibility direction and the unknown-branch
// policy: the same schema pair can be backward-compatible under one policy and
// incompatible under the other, and each direction is cached independently.
const directionCache = new Map<string, { result: DirectionResult; ms: number }>();
const CACHE_LIMIT = 512;

export class BadSchemaError extends Error {
  constructor(public readonly issues: import('../shared/schema').Issue[]) {
    super('invalid schema');
  }
}

function evictIfNeeded(cache: Map<string, unknown>): void {
  while (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

function getDirection(
  direction: Direction,
  policy: 'fail' | 'passthrough',
  v1: Schema,
  v2: Schema,
): { result: DirectionResult; hit: boolean; ms: number; key: string } {
  const key = `compat:${direction}:${policy}:${canonicalize(v1)}::${canonicalize(v2)}`;
  const cached = directionCache.get(key);
  if (cached) return { result: cached.result, hit: true, ms: 0, key };

  // A miss computes both directions once (they share the checker pair) and
  // stores each under its own direction-bearing key, so the sibling lookup
  // immediately hits.
  const started = Date.now();
  const report = compareSchemas(v1, v2);
  const ms = Date.now() - started;
  const backwardKey = `compat:backward:${policy}:${canonicalize(v1)}::${canonicalize(v2)}`;
  const forwardKey = `compat:forward:${policy}:${canonicalize(v1)}::${canonicalize(v2)}`;
  evictIfNeeded(directionCache);
  directionCache.set(backwardKey, { result: report.backward, ms });
  evictIfNeeded(directionCache);
  directionCache.set(forwardKey, { result: report.forward, ms });
  const result = direction === 'backward' ? report.backward : report.forward;
  return { result, hit: false, ms, key };
}

export function compareInput(input: CompareInput): CompareResponse {
  const policy = input.policy === 'passthrough' ? 'passthrough' : 'fail';
  const parsed1 = parseSchema(input.v1);
  const parsed2 = parseSchema(input.v2);
  if (parsed1.errors.length || parsed2.errors.length || !parsed1.schema || !parsed2.schema) {
    throw new BadSchemaError([...parsed1.errors, ...parsed2.errors]);
  }
  const v1 = applyDefaultPolicy(parsed1.schema, policy);
  const v2 = applyDefaultPolicy(parsed2.schema, policy);
  const lint = { v1: lintSchema(v1), v2: lintSchema(v2) };

  const b = getDirection('backward', policy, v1, v2);
  const f = getDirection('forward', policy, v1, v2);
  return {
    policy,
    lint,
    report: {
      backward: b.result,
      forward: f.result,
      fullyCompatible: b.result.compatible && f.result.compatible,
    },
    cache: {
      keys: { backward: b.key, forward: f.key },
      hits: { backward: b.hit, forward: f.hit },
      totalMs: b.ms + f.ms,
    },
  };
}

export function resetCacheForTests(): void {
  directionCache.clear();
}
