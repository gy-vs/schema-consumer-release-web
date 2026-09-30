// Bidirectional compatibility engine for schemas with discriminated unions.
//
// Producer/consumer view (old = v1, new = v2):
//   backward (向后兼容): NEW producers -> OLD consumers.
//       Holds iff every instance valid under v2 is accepted by v1.
//   forward  (向前兼容): OLD producers -> NEW consumers.
//       Holds iff every instance valid under v1 is accepted by v2.
//   full     (完全兼容): both directions.
//
// The three verdicts are returned independently and never folded into one
// boolean. Every failure carries a MINIMAL counterexample instance plus the
// union hops it routes through, and the instance is proven by running BOTH
// validators: producer accepts, consumer rejects.

import {
  Issue,
  ObjectSchema,
  Schema,
  UnionSchema,
  freshUnknownValue,
  minimalBranchObject,
  minimalInstance,
  validateSchema,
} from './schema';

export type Direction = 'backward' | 'forward';

export type HopKind = 'explicit' | 'default' | 'open';

export interface UnionHop {
  at: string;             // JSON pointer of the union node
  discriminator: string;  // discriminator field name
  value: string;          // discriminator value carried by the instance
  kind: HopKind;          // how the PRODUCER routes this value
  producerStrategy: 'fail' | 'passthrough' | 'default';
  consumerStrategy: 'fail' | 'passthrough' | 'default';
  mappedFrom?: string;    // value reuse: other side routes this value elsewhere
}

export interface Counterexample {
  instance: unknown;
  unionPath: UnionHop[];
  validatesAs: { producer: boolean; consumer: boolean };
  producerErrors: Issue[];
  consumerErrors: Issue[];
  reason: string;
  validatedBy: { producer: 'v1' | 'v2'; consumer: 'v1' | 'v2' };
}

export interface DirectionResult {
  direction: Direction;
  producer: 'v1' | 'v2';
  consumer: 'v1' | 'v2';
  compatible: boolean;
  unknownPolicy: { v1: StrategyInfo; v2: StrategyInfo };
  counterexamples: Counterexample[]; // minimal first
}

export interface StrategyInfo {
  topLevel: 'fail' | 'passthrough' | 'default' | 'n/a';
  explicitValues: string[];
}

export interface CompatibilityReport {
  backward: DirectionResult; // v2 producer -> v1 consumer
  forward: DirectionResult;  // v1 producer -> v2 consumer
  fullyCompatible: boolean;
}

type TrailItem =
  | { t: 'field'; name: string }
  | { t: 'hop'; hop: UnionHop };
type Trail = TrailItem[];

interface Failure {
  trail: Trail;
  seed: unknown; // producer-valid instance for the node at the end of the trail
  reason: string;
}

type StrategyMode = 'fail' | 'passthrough' | 'default';

function branchMap(u: UnionSchema): Map<string, { value: string; payload: ObjectSchema }> {
  // last write wins, matching the effective routing semantics of a validator
  return new Map((u.branches ?? []).map(b => [b.value, b]));
}
function modeOf(u: UnionSchema): StrategyMode {
  return u.unknown?.mode ?? 'fail';
}
function defaultPayloadOf(u: UnionSchema): ObjectSchema {
  if (u.unknown?.mode !== 'default') throw new Error('union has no default payload');
  return u.unknown.defaultPayload;
}
function ptrChild(ptr: string, key: string): string {
  return ptr === '$' ? `$.${key}` : `${ptr}.${key}`;
}
function branchPtr(ptr: string, value: string): string {
  return `${ptr}<${value}>`;
}
function defaultPtr(ptr: string): string {
  return `${ptr}<default>`;
}

// Build a root instance by replaying the trail: each field step nests into a
// minimal object, each hop materializes the routed branch payload (with the
// discriminator injected). The seed replaces the node at the trail's end.
function materialize(root: Schema, trail: Trail, seed: unknown): unknown {
  if (trail.length === 0) return seed;
  const [item, ...rest] = trail;
  if (item.t === 'field') {
    if (root.kind !== 'object') throw new Error('trail/object mismatch');
    const out = minimalInstance(root) as Record<string, unknown>;
    out[item.name] = materialize(root.fields![item.name]!.schema, rest, seed);
    return out;
  }
  const u = root as UnionSchema;
  const hop = item.hop;
  if (hop.kind === 'open') {
    if (rest.length) throw new Error('open hop cannot carry a payload trail');
    return { [u.discriminator]: hop.value };
  }
  const payload =
    hop.kind === 'explicit'
      ? branchMap(u).get(hop.value)!.payload
      : defaultPayloadOf(u);
  if (rest.length === 0) {
    return { ...(seed as Record<string, unknown>), [u.discriminator]: hop.value };
  }
  const next = rest[0]!;
  if (next.t !== 'field') throw new Error('field step expected after branch hop');
  const base = minimalBranchObject(payload, u.discriminator, hop.value);
  base[next.name] = materialize(payload.fields![next.name]!.schema, rest.slice(1), seed);
  return base;
}

// Object instance with every declared field (optionals included) populated.
function fullObject(schema: ObjectSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(schema.fields ?? {})) {
    out[key] = minimalInstance(schema.fields![key]!.schema);
  }
  return out;
}

export class CompatibilityChecker {
  constructor(
    private readonly v1: Schema,
    private readonly v2: Schema,
  ) {}

  check(direction: Direction): DirectionResult {
    const producer = direction === 'backward' ? this.v2 : this.v1;
    const consumer = direction === 'backward' ? this.v1 : this.v2;
    const producerLabel = direction === 'backward' ? ('v2' as const) : ('v1' as const);
    const consumerLabel = direction === 'backward' ? ('v1' as const) : ('v2' as const);

    const failures: Failure[] = [];
    this.compare(producer, consumer, [], '$', failures);

    const proven: Counterexample[] = [];
    for (const failure of failures) {
      const instance = materialize(producer, failure.trail, failure.seed);
      const producerErrors = validateSchema(producer, instance);
      const consumerErrors = validateSchema(consumer, instance);
      const producerOk = producerErrors.length === 0;
      const consumerOk = consumerErrors.length === 0;
      // Proof gate: a counterexample must pass the producer validator and
      // fail the consumer validator. Anything else is an engine error and is
      // dropped rather than reported.
      if (producerOk && !consumerOk) {
        proven.push({
          instance,
          unionPath: failure.trail.filter(i => i.t === 'hop').map(i => (i as { hop: UnionHop }).hop),
          validatesAs: { producer: true, consumer: false },
          producerErrors: producerErrors.slice(0, 5),
          consumerErrors: consumerErrors.slice(0, 5),
          reason: failure.reason,
          validatedBy: { producer: producerLabel, consumer: consumerLabel },
        });
      }
    }

    return {
      direction,
      producer: producerLabel,
      consumer: consumerLabel,
      compatible: proven.length === 0,
      unknownPolicy: { v1: this.strategyInfo(this.v1), v2: this.strategyInfo(this.v2) },
      counterexamples: this.minimize(proven),
    };
  }

  private strategyInfo(s: Schema): StrategyInfo {
    if (s.kind !== 'union') return { topLevel: 'n/a', explicitValues: [] };
    return { topLevel: modeOf(s), explicitValues: (s.branches ?? []).map(b => b.value) };
  }

  private compare(p: Schema, c: Schema, trail: Trail, ptr: string, failures: Failure[]): void {
    if (p.kind !== c.kind) {
      failures.push({
        trail,
        seed: minimalInstance(p),
        reason: `kind mismatch at ${ptr}: producer is ${p.kind}, consumer expects ${c.kind}`,
      });
      return;
    }
    if (p.kind === 'string' || p.kind === 'boolean' || p.kind === 'number' || p.kind === 'integer') {
      if (p.kind !== c.kind) {
        failures.push({ trail, seed: minimalInstance(p), reason: `primitive kind mismatch at ${ptr}` });
      }
      return;
    }
    if (p.kind === 'object') this.compareObjects(p, c as ObjectSchema, trail, ptr, failures);
    else this.compareUnions(p as UnionSchema, c as UnionSchema, trail, ptr, failures);
  }

  private compareObjects(
    p: ObjectSchema,
    c: ObjectSchema,
    trail: Trail,
    ptr: string,
    failures: Failure[],
    allowedExtra?: string,
  ): void {
    const pFields = p.fields ?? {};
    const cFields = c.fields ?? {};
    const fieldTrail = (name: string): Trail => [...trail, { t: 'field', name }];

    // Fields the consumer requires but the producer never sends.
    for (const key of Object.keys(cFields)) {
      if (key === allowedExtra) continue; // discriminator, injected by union routing
      const cf = cFields[key]!;
      if (!(key in pFields)) {
        if (!cf.optional) {
          failures.push({
            trail,
            seed: minimalInstance(p),
            reason: `missing required field '${key}' at ${ptr}: consumer requires it, producer schema does not declare it`,
          });
        }
        continue;
      }
    }

    // Fields the producer may send that the consumer cannot represent.
    const consumerClosed = c.additionalProperties !== true;
    for (const key of Object.keys(pFields)) {
      if (key === allowedExtra) continue;
      const pf = pFields[key]!;
      if (!(key in cFields)) {
        if (consumerClosed) {
          // Populate the (possibly optional) extra field so the witness fails.
          const seed = fullObject(p);
          seed[key] = minimalInstance(pf.schema);
          failures.push({
            trail,
            seed,
            reason: `field '${key}' at ${ptr} is rejected by the consumer (additional properties not allowed)`,
          });
        }
        continue;
      }
      const cf = cFields[key]!;
      if (pf.optional && !cf.optional) {
        failures.push({
          trail,
          seed: minimalInstance(p), // minimal producer object omits the optional field
          reason: `field '${key}' at ${ptr} is optional for the producer but required by the consumer`,
        });
      }
      // producer-required -> consumer-optional is safe; recurse either way.
      this.compare(pf.schema, cf.schema, fieldTrail(key), ptrChild(ptr, key), failures);
    }

    // Producer allows arbitrary extras; a closed consumer rejects them.
    if (p.additionalProperties === true && consumerClosed) {
      const extraKey = freshUnknownValue(new Set(Object.keys(pFields)));
      failures.push({
        trail,
        seed: { ...(minimalInstance(p) as Record<string, unknown>), [extraKey]: 'x' },
        reason: `open object at ${ptr} may carry extra fields the consumer rejects`,
      });
    }
  }

  private compareUnions(
    p: UnionSchema,
    c: UnionSchema,
    trail: Trail,
    ptr: string,
    failures: Failure[],
  ): void {
    // 1. Discriminator FIELD rename is modeled explicitly. Checking only the
    //    branch payloads would hide it — every branch looks fine in isolation.
    if (p.discriminator !== c.discriminator) {
      failures.push({
        trail,
        seed: minimalInstance(p),
        reason: `discriminator field renamed at ${ptr}: producer routes on '${p.discriminator}', consumer on '${c.discriminator}'`,
      });
      return;
    }
    const disc = p.discriminator;
    const pMap = branchMap(p);
    const cMap = branchMap(c);
    const pMode = modeOf(p);
    const cMode = modeOf(c);
    const fresh = freshUnknownValue(new Set([...pMap.keys(), ...cMap.keys()]));

    const hopFor = (value: string, kind: HopKind, mappedFrom?: string): UnionHop => ({
      at: ptr,
      discriminator: disc,
      value,
      kind,
      producerStrategy: pMode,
      consumerStrategy: cMode,
      mappedFrom,
    });

    // 2. Every explicit producer value must route somewhere in the consumer.
    for (const [value, pBranch] of pMap) {
      const cBranch = cMap.get(value);
      if (cBranch) {
        // Same value on both sides — including value reuse with new payloads;
        // the structural payload compare decides whether reuse is safe.
        this.compareObjects(
          pBranch.payload,
          cBranch.payload,
          [...trail, { t: 'hop', hop: hopFor(value, 'explicit') }],
          branchPtr(ptr, value),
          failures,
          disc,
        );
        continue;
      }
      if (cMode === 'fail') {
        // THE headline bug: new discriminator value vs a closed old consumer.
        failures.push({
          trail: [...trail, { t: 'hop', hop: hopFor(value, 'explicit', 'consumer:unknown') }],
          seed: minimalInstance(pBranch.payload),
          reason: `discriminator value '${value}' at ${ptr} is unknown to a closed consumer union (unknown: fail)`,
        });
        continue;
      }
      if (cMode === 'passthrough') {
        // Open consumer accepts the object without payload validation.
        continue;
      }
      // Consumer default branch validates with defaultPayload.
      this.compareObjects(
        pBranch.payload,
        defaultPayloadOf(c),
        [...trail, { t: 'hop', hop: hopFor(value, 'explicit', 'consumer:default') }],
        defaultPtr(branchPtr(ptr, value)),
        failures,
        disc,
      );
    }

    // 3. Producer fallback (open/default) values absent from the producer's own map.
    if (pMode === 'passthrough' || pMode === 'default') {
      // 3a. A value explicit on the CONSUMER but not on the producer: the open
      //     producer may emit it with a bare/default-shaped object.
      for (const [value] of cMap) {
        if (pMap.has(value)) continue;
        if (pMode === 'passthrough') {
          failures.push({
            trail: [...trail, { t: 'hop', hop: hopFor(value, 'open', 'consumer:explicit') }],
            seed: { [disc]: value },
            reason: `open producer may emit bare object for '${value}' at ${ptr}; consumer branch imposes a payload`,
          });
        } else {
          this.compareObjects(
            defaultPayloadOf(p),
            cMap.get(value)!.payload,
            [...trail, { t: 'hop', hop: hopFor(value, 'default', 'consumer:explicit') }],
            defaultPtr(branchPtr(ptr, value)),
            failures,
            disc,
          );
        }
      }
      // 3b. A genuinely fresh value unknown to both sides.
      if (cMode === 'fail') {
        const seed =
          pMode === 'passthrough'
            ? { [disc]: fresh }
            : minimalInstance(defaultPayloadOf(p));
        failures.push({
          trail: [...trail, { t: 'hop', hop: hopFor(fresh, pMode === 'passthrough' ? 'open' : 'default', 'consumer:unknown') }],
          seed,
          reason: `producer may emit unknown value '${fresh}' at ${ptr} but the consumer union is closed (unknown: fail)`,
        });
      } else if (cMode === 'passthrough') {
        // accepted without payload validation: safe
      } else {
        // both default: default payloads must be compatible for unknown tags
        this.compareObjects(
          defaultPayloadOf(p),
          defaultPayloadOf(c),
          [...trail, { t: 'hop', hop: hopFor(fresh, 'default', 'consumer:default') }],
          defaultPtr(ptr),
          failures,
          disc,
        );
      }
    }
    // Removed branches are handled symmetrically: in the opposite direction
    // the removed value is simply a value the producer still emits (step 2).
  }

  private minimize(items: Counterexample[]): Counterexample[] {
    const scored = items.map(f => ({ f, size: JSON.stringify(f.instance).length }));
    scored.sort((a, b) => a.size - b.size || a.f.reason.localeCompare(b.f.reason));
    const seen = new Set<string>();
    const out: Counterexample[] = [];
    for (const { f } of scored) {
      const key = `${f.reason}|${JSON.stringify(f.instance)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    return out.slice(0, 10);
  }
}

export function compareSchemas(v1: Schema, v2: Schema): CompatibilityReport {
  const checker = new CompatibilityChecker(v1, v2);
  const backward = checker.check('backward');
  const forward = checker.check('forward');
  return { backward, forward, fullyCompatible: backward.compatible && forward.compatible };
}
