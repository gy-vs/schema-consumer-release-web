// Server-side multi-consumer release governance.
//
// Consumers are named, revisioned server entities (each deployment pace gets
// its own schema). A PREVIEW computes one per-consumer directional verdict
// against a PINNED set of revisions and hands back an opaque token. A CONFIRM
// is the only state-changing action: it re-reads every pinned revision,
// rejects the token if the world moved (409), recomputes all verdicts from
// scratch (422 if the gate no longer passes), and only then appends an
// auditable release record naming the exact consumer revisions and producer
// definition that were approved.

import {randomUUID} from 'node:crypto';
import {
  Issue,
  Schema,
  applyDefaultPolicy,
  fingerprint,
  lintSchema,
  parseSchema,
} from '../shared/schema';
import {DirectionResult, compareSchemas} from '../shared/compat';
import {
  ConfirmResponse,
  Consumer,
  ConsumerSummary,
  ConsumerVerdict,
  GATE_RULE,
  PreviewResponse,
  ReleaseRecord,
  UnknownPolicy,
} from '../shared/api';
import {BadSchemaError} from './compat';

// Seed: three consumers on different deployment cadences.
//   甲 alpha-a: still on the old closed definition (created, archived)
//   乙 beta-b:  already accepted an intermediate definition (+ merged)
//   丙 open-c:  only deals with an open union (unknown: passthrough)
const closedEvent = {
  kind: 'union' as const,
  discriminator: 'type',
  branches: [
    {value: 'created', payload: {kind: 'object' as const, fields: {id: {schema: {kind: 'string' as const}}}}},
    {value: 'archived', payload: {kind: 'object' as const}},
  ],
};

interface ConsumerRow {
  id: string;
  name: string;
  revision: number;
  required: boolean;
  schema: Schema;
  updatedAt: string;
  createdAt: string;
}

interface PreviewTokenPayload {
  fingerprint: string;
  policy: UnknownPolicy;
  producer: Schema;
  pinned: {id: string; revision: number; required: boolean}[];
  iat: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function encodeToken(payload: PreviewTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeToken(token: unknown): PreviewTokenPayload | undefined {
  if (typeof token !== 'string') return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed !== 'object' || parsed === null ||
      typeof (parsed as PreviewTokenPayload).fingerprint !== 'string' ||
      ((parsed as PreviewTokenPayload).policy !== 'fail' && (parsed as PreviewTokenPayload).policy !== 'passthrough')
    ) {
      return undefined;
    }
    return parsed as PreviewTokenPayload;
  } catch {
    return undefined;
  }
}

// The fingerprint is what the UI uses to tell which submitted content a result
// belongs to. Pinned revisions are sorted by id so client and server agree
// regardless of display order.
function previewFingerprint(
  policy: UnknownPolicy,
  producer: Schema,
  pinned: {id: string; revision: number; required: boolean}[],
): string {
  return fingerprint({policy, producer, pinned: [...pinned].sort((a, b) => a.id.localeCompare(b.id))});
}

export class NotFoundError extends Error {}
export class PreviewStaleError extends Error {
  constructor(
    public readonly divergence: Array<{id: string; pinnedRevision: number | null; currentRevision: number | null}>,
    public readonly currentPreview?: PreviewResponse,
  ) {
    super('preview_stale');
  }
}
export class GateBlockedError extends Error {
  constructor(public readonly preview: PreviewResponse) {
    super('gate_blocked');
  }
}
export class BadPreviewTokenError extends Error {}
export class ReleaseExistsError extends Error {
  constructor(public readonly release: ReleaseRecord) {
    super('release_exists');
  }
}

export class ReleaseStore {
  private consumers = new Map<string, ConsumerRow>();
  private releases: ReleaseRecord[] = [];

  constructor() {
    this.seed();
  }

  private seed(): void {
    const t = nowIso();
    const seeds: Array<Omit<ConsumerRow, 'createdAt'>> = [
      {id: 'consumer-a', name: '消费方甲 · 旧定义', revision: 1, required: true, schema: closedEvent, updatedAt: t},
      {
        id: 'consumer-b',
        name: '消费方乙 · 中间定义',
        revision: 2,
        required: true,
        updatedAt: t,
        schema: {...closedEvent, branches: [...closedEvent.branches, {value: 'merged', payload: {kind: 'object', fields: {mergedBy: {schema: {kind: 'string'}}}}}]},
      },
      {
        id: 'consumer-c',
        name: '消费方丙 · 开放联合',
        revision: 1,
        required: false,
        updatedAt: t,
        schema: {
          kind: 'union',
          discriminator: 'type',
          branches: [{value: 'created', payload: {kind: 'object', fields: {id: {schema: {kind: 'string'}}}}}],
          unknown: {mode: 'passthrough'},
        },
      },
    ];
    for (const s of seeds) this.consumers.set(s.id, {...s, createdAt: t});
  }

  private static toSummary(row: ConsumerRow): ConsumerSummary {
    return {id: row.id, name: row.name, revision: row.revision, required: row.required, updatedAt: row.updatedAt};
  }

  listConsumers(): ConsumerSummary[] {
    return [...this.consumers.values()].map(ReleaseStore.toSummary);
  }

  getConsumer(id: string): {consumer: Consumer; lint: Issue[]} {
    const row = this.consumers.get(id);
    if (!row) throw new NotFoundError('consumer_not_found');
    return {consumer: {...ReleaseStore.toSummary(row), schema: row.schema}, lint: lintSchema(row.schema)};
  }

  // Parse + validate untrusted schema JSON. Returns resolved schema.
  private resolveSchema(raw: unknown): Schema {
    const parsed = parseSchema(raw);
    if (parsed.errors.length || !parsed.schema) throw new BadSchemaError(parsed.errors);
    return parsed.schema;
  }

  createConsumer(input: {name?: unknown; required?: unknown; schema?: unknown}): {consumer: Consumer; lint: Issue[]} {
    const name = typeof input.name === 'string' && input.name.trim().length ? input.name.trim() : undefined;
    if (!name) throw new BadSchemaError([{path: '$', code: 'invalid_consumer', message: 'consumer needs a non-empty name'}]);
    const schema = this.resolveSchema(input.schema);
    const t = nowIso();
    const row: ConsumerRow = {id: randomUUID(), name, revision: 1, required: input.required === true, schema, updatedAt: t, createdAt: t};
    this.consumers.set(row.id, row);
    return {consumer: {...ReleaseStore.toSummary(row), schema}, lint: lintSchema(schema)};
  }

  // Optimistic concurrency: every PUT carries the revision the editor last
  // saw. A schema change, a rename and a required/non-required flip all bump
  // the revision, so any concurrent edit invalidates the other side.
  updateConsumer(
    id: string,
    body: {revision?: unknown; name?: unknown; required?: unknown; schema?: unknown},
  ): {consumer: Consumer; lint: Issue[]} {
    const row = this.consumers.get(id);
    if (!row) throw new NotFoundError('consumer_not_found');
    if (typeof body.revision !== 'number' || body.revision !== row.revision) {
      return this.revisionConflict(row);
    }
    let changed = false;
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim().length) {
        throw new BadSchemaError([{path: '$', code: 'invalid_consumer', message: 'consumer name must be a non-empty string'}]);
      }
      const name = body.name.trim();
      if (name !== row.name) {
        row.name = name;
        changed = true;
      }
    }
    if (body.required !== undefined) {
      const required = body.required === true;
      if (required !== row.required) {
        row.required = required;
        changed = true;
      }
    }
    if (body.schema !== undefined) {
      const schema = this.resolveSchema(body.schema);
      // content change, not a resubmission of the same definition
      if (JSON.stringify(schema) !== JSON.stringify(row.schema)) {
        row.schema = schema;
        changed = true;
      }
    }
    if (changed) {
      row.revision += 1;
      row.updatedAt = nowIso();
    }
    return {consumer: {...ReleaseStore.toSummary(row), schema: row.schema}, lint: lintSchema(row.schema)};
  }

  private revisionConflict(row: ConsumerRow): never {
    const err = new Error('revision_conflict') as Error & {status?: number; current?: ConsumerSummary};
    err.status = 409;
    err.current = ReleaseStore.toSummary(row);
    throw err;
  }

  deleteConsumer(id: string, revision: unknown): void {
    const row = this.consumers.get(id);
    if (!row) throw new NotFoundError('consumer_not_found');
    if (revision !== row.revision) this.revisionConflict(row);
    this.consumers.delete(id);
  }

  // ---- Preview / confirm -----------------------------------------------------

  private evaluate(producerResolved: Schema, policy: UnknownPolicy, rows: ConsumerRow[]): ConsumerVerdict[] {
    return rows.map(row => {
      // v1 = the deployed consumer, v2 = the producer draft. The engine then
      // gives exactly the two directional questions this UI asks.
      const report = compareSchemas(applyDefaultPolicy(row.schema, policy), producerResolved);
      return {
        consumerId: row.id,
        name: row.name,
        required: row.required,
        revision: row.revision,
        backward: report.backward,
        forward: report.forward,
      };
    });
  }

  private buildPreview(
    producer: Schema,
    policy: UnknownPolicy,
    computedAt: string,
    scopeRows?: ConsumerRow[],
  ): PreviewResponse {
    const producerResolved = applyDefaultPolicy(producer, policy);
    const rows = scopeRows ? [...scopeRows] : [...this.consumers.values()];
    rows.sort((a, b) => a.id.localeCompare(b.id));
    const verdicts = this.evaluate(producerResolved, policy, rows);
    const pinned = rows.map(r => ({id: r.id, revision: r.revision, required: r.required}));
    const fp = previewFingerprint(policy, producerResolved, pinned);
    const requiredBlocked = verdicts
      .filter(v => v.required && !v.backward.compatible)
      .map(v => ({consumerId: v.consumerId, revision: v.revision}));
    return {
      previewToken: encodeToken({fingerprint: fp, policy, producer: producerResolved, pinned, iat: computedAt}),
      fingerprint: fp,
      policy,
      producer: producerResolved,
      producerLint: lintSchema(producerResolved),
      consumers: verdicts,
      pinned,
      gate: {
        passes: requiredBlocked.length === 0,
        rule: GATE_RULE,
        requiredChecked: verdicts.filter(v => v.required).length,
        requiredBlocked,
      },
      computedAt,
    };
  }

  preview(input: {producer?: unknown; policy?: unknown}): PreviewResponse {
    const policy: UnknownPolicy = input.policy === 'passthrough' ? 'passthrough' : 'fail';
    const producer = this.resolveSchema(input.producer);
    return this.buildPreview(producer, policy, nowIso());
  }

  // The authoritative action. The token is treated only as a PIN of what the
  // user saw; every verdict is recomputed against current server state.
  confirm(rawToken: unknown): ConfirmResponse {
    const payload = decodeToken(rawToken);
    if (!payload) throw new BadPreviewTokenError('invalid_preview_token');

    // 1. Did any pinned consumer move (edit, required flip, deletion)?
    const divergence: PreviewStaleError['divergence'] = [];
    const pinnedRows: ConsumerRow[] = [];
    for (const pin of payload.pinned) {
      const current = this.consumers.get(pin.id);
      if (!current) divergence.push({id: pin.id, pinnedRevision: pin.revision, currentRevision: null});
      else if (current.revision !== pin.revision || current.required !== pin.required) {
        divergence.push({id: pin.id, pinnedRevision: pin.revision, currentRevision: current.revision});
      } else pinnedRows.push(current);
    }
    // A consumer added since the preview is not pinned: it cannot change the
    // admission result for the pinned set and is deliberately not part of this
    // approval. The stale preview returned on drift is, however, scoped to the
    // CURRENT world so the UI can show what changed.
    if (divergence.length) {
      const currentPreview = this.buildPreview(payload.producer, payload.policy, nowIso());
      throw new PreviewStaleError(divergence, currentPreview);
    }

    // 2. Recompute against the pinned revisions from scratch (new consumers
    //    added since the preview stay out of this approval).
    const fresh = this.buildPreview(payload.producer, payload.policy, nowIso(), pinnedRows);
    if (fresh.fingerprint !== payload.fingerprint) {
      throw new PreviewStaleError([], fresh);
    }
    if (!fresh.gate.passes) throw new GateBlockedError(fresh);

    // 3. Same submitted content approved twice -> report the existing record
    //    rather than appending a duplicate audit row.
    const existing = this.releases.find(r => r.producerFingerprint === fresh.fingerprint);
    if (existing) throw new ReleaseExistsError(existing);

    const rowsById = new Map(pinnedRows.map(r => [r.id, r]));
    const record: ReleaseRecord = {
      id: randomUUID(),
      publishedAt: nowIso(),
      policy: fresh.policy,
      producer: fresh.producer,
      producerFingerprint: fresh.fingerprint,
      gateRule: fresh.gate.rule,
      previewFingerprint: fresh.fingerprint,
      consumers: fresh.consumers.map(v => {
        const row = rowsById.get(v.consumerId)!;
        return {
          consumerId: v.consumerId,
          name: v.name,
          required: v.required,
          revision: v.revision,
          schema: applyDefaultPolicy(row.schema, fresh.policy),
          backward: v.backward,
          forward: v.forward,
        };
      }),
    };
    this.releases.push(record);
    return {release: record};
  }

  listReleases(): Array<Pick<ReleaseRecord, 'id' | 'publishedAt' | 'policy' | 'producerFingerprint' | 'gateRule'>> {
    return this.releases
      .map(r => ({id: r.id, publishedAt: r.publishedAt, policy: r.policy, producerFingerprint: r.producerFingerprint, gateRule: r.gateRule}))
      .reverse();
  }

  getRelease(id: string): ReleaseRecord {
    const release = this.releases.find(r => r.id === id);
    if (!release) throw new NotFoundError('release_not_found');
    return release;
  }
}

// Re-export so route code can type directional results.
export type {DirectionResult};
