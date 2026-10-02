import crypto from 'node:crypto';
import {
  Issue,
  Schema,
  applyDefaultPolicy,
  canonicalize,
  lintSchema,
  parseSchema,
} from '../shared/schema';
import { compareSchemas } from '../shared/compat';
import {
  ConsumerDetail,
  ConsumerSummary,
  ConsumerUpsert,
  ConsumerVerdict,
  GateBlockedBody,
  Preview,
  PreviewRequest,
  ReleaseRecord,
  StalePreviewBody,
} from '../shared/release';

export class InvalidProducerError extends Error {
  constructor(public readonly issues: Issue[]) {
    super('invalid producer schema');
  }
}

interface ConsumerRow {
  id: string;
  name: string;
  required: boolean;
  revision: number;
  schemaRaw: unknown; // as submitted; returned verbatim
  parsedSchema: Schema;
  policy: 'fail' | 'passthrough';
  updatedAt: string;
}

interface StoredPreview {
  token: string;
  createdAt: string;
  producerRaw: unknown;
  producerParsed: Schema;
  producerHash: string;
  policy: 'fail' | 'passthrough';
  lint: Issue[];
  pins: Map<string, { revision: number; required: boolean; schemaHash: string }>;
  consumed: boolean;
}

const MAX_PREVIEWS = 256;

export function hashSchema(schema: Schema): string {
  return crypto.createHash('sha256').update(canonicalize(schema)).digest('hex');
}

function coercePolicy(value: unknown): 'fail' | 'passthrough' {
  return value === 'passthrough' ? 'passthrough' : 'fail';
}

function parseName(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

// ---- Seeding -------------------------------------------------------------------

// Three deployment cadences from the real rollout scenario. `add-branch`
// producer (created + archived + merged) is used as the reference draft in
// tests: 甲 blocks it, 乙 accepts it, 丙's open union carries it as a risk
// surface rather than a gate member.
function seedRow(
  id: string,
  name: string,
  required: boolean,
  schema: unknown,
  policy: 'fail' | 'passthrough',
  revision = 1,
): ConsumerRow {
  const parsed = parseSchema(schema);
  if (parsed.errors.length || !parsed.schema) {
    throw new Error(`bad seed consumer ${id}: ${parsed.errors.map(e => e.message).join('; ')}`);
  }
  return {
    id,
    name,
    required,
    revision,
    schemaRaw: schema,
    parsedSchema: parsed.schema,
    policy,
    updatedAt: new Date(Date.parse('2026-01-01T00:00:00Z')).toISOString(),
  };
}

export function seedConsumers(): ConsumerRow[] {
  const created = { value: 'created', payload: { kind: 'object', fields: { id: { schema: { kind: 'string' } } } } };
  return [
    seedRow(
      'consumer-a',
      '消费方甲（旧定义 · 封闭 union）',
      true,
      {
        kind: 'union',
        discriminator: 'type',
        branches: [created, { value: 'archived', payload: { kind: 'object' } }],
      },
      'fail',
    ),
    seedRow(
      'consumer-b',
      '消费方乙（中间定义 · 已接受 merged）',
      true,
      {
        kind: 'union',
        discriminator: 'type',
        branches: [
          created,
          { value: 'archived', payload: { kind: 'object' } },
          { value: 'merged', payload: { kind: 'object', fields: { mergedBy: { schema: { kind: 'string' } } } } },
        ],
      },
      'fail',
    ),
    seedRow(
      'consumer-c',
      '消费方丙（仅处理开放 union）',
      false,
      {
        kind: 'union',
        discriminator: 'type',
        branches: [created],
        unknown: { mode: 'passthrough' },
      },
      'passthrough',
    ),
  ];
}

// ---- Store ---------------------------------------------------------------------

export class ReleaseStore {
  private consumers = new Map<string, ConsumerRow>();
  private previews = new Map<string, StoredPreview>();
  private releases: ReleaseRecord[] = [];
  private previewOrder: string[] = [];

  constructor(seed = true) {
    if (seed) for (const row of seedConsumers()) this.consumers.set(row.id, row);
  }

  listConsumers(): ConsumerSummary[] {
    return [...this.consumers.values()].map(row => this.summary(row));
  }

  getConsumer(id: string): ConsumerDetail | undefined {
    const row = this.consumers.get(id);
    return row ? this.detail(row) : undefined;
  }

  createConsumer(input: ConsumerUpsert): { ok: true; detail: ConsumerDetail } | { ok: false; status: 400; issues: Issue[] } | { ok: false; status: 409 } {
    const name = parseName(input.name);
    if (!name) return { ok: false, status: 400, issues: [{ path: '$', code: 'invalid_name', message: 'consumer needs a non-empty string name' }] };
    const parsed = parseSchema(input.schema);
    if (parsed.errors.length || !parsed.schema) return { ok: false, status: 400, issues: parsed.errors };
    const id = this.freshId(typeof input.name === 'string' ? input.name : 'consumer');
    const row: ConsumerRow = {
      id,
      name,
      required: input.required === true,
      revision: 1,
      schemaRaw: input.schema,
      parsedSchema: parsed.schema,
      policy: coercePolicy(input.policy),
      updatedAt: new Date().toISOString(),
    };
    this.consumers.set(id, row);
    return { ok: true, detail: this.detail(row) };
  }

  updateConsumer(
    id: string,
    input: ConsumerUpsert,
  ):
    | { ok: true; detail: ConsumerDetail }
    | { ok: false; status: 404 }
    | { ok: false; status: 400; issues: Issue[] }
    | { ok: false; status: 409; current: ConsumerDetail } {
    const row = this.consumers.get(id);
    if (!row) return { ok: false, status: 404 };
    const expected = Number(input.expectedRevision);
    if (!Number.isInteger(expected) || expected !== row.revision) {
      return { ok: false, status: 409, current: this.detail(row) };
    }
    const name = parseName(input.name);
    if (!name) return { ok: false, status: 400, issues: [{ path: '$', code: 'invalid_name', message: 'consumer needs a non-empty string name' }] };
    const parsed = parseSchema(input.schema);
    if (parsed.errors.length || !parsed.schema) return { ok: false, status: 400, issues: parsed.errors };
    row.name = name;
    row.required = input.required === true;
    row.schemaRaw = input.schema;
    row.parsedSchema = parsed.schema;
    row.policy = coercePolicy(input.policy);
    row.revision += 1;
    row.updatedAt = new Date().toISOString();
    return { ok: true, detail: this.detail(row) };
  }

  deleteConsumer(id: string, expectedRevision?: unknown): boolean | 409 {
    const row = this.consumers.get(id);
    if (!row) return false;
    const expected = Number(expectedRevision);
    if (Number.isInteger(expected) && expected !== row.revision) return 409;
    this.consumers.delete(id);
    return true;
  }

  // ---- Preview / confirm ----

  preview(input: PreviewRequest): { ok: true; preview: Preview } | { ok: false; issues: Issue[] } {
    const parsed = parseSchema(input.producer);
    if (parsed.errors.length || !parsed.schema) return { ok: false, issues: parsed.errors };
    const policy = coercePolicy(input.policy);
    const producerParsed = parsed.schema;
    const producerHash = hashSchema(producerParsed);
    const lint = lintSchema(producerParsed);

    const verdicts = this.evaluate(producerParsed, policy);
    const pins = new Map<string, { revision: number; required: boolean; schemaHash: string }>();
    for (const v of verdicts) pins.set(v.consumerId, { revision: v.consumerRevision, required: v.required, schemaHash: v.consumerSchemaHash });

    const stored: StoredPreview = {
      token: crypto.randomBytes(16).toString('hex'),
      createdAt: new Date().toISOString(),
      producerRaw: input.producer,
      producerParsed,
      producerHash,
      policy,
      lint,
      pins,
      consumed: false,
    };
    this.rememberPreview(stored);
    return { ok: true, preview: this.shapePreview(stored, verdicts) };
  }

  // Confirmation never trusts the client. The token names a preview; the
  // server verifies freshness and RE-EVALUATES the gate against the current
  // roster before persisting anything.
  confirm(token: string):
    | { ok: true; record: ReleaseRecord }
    | { ok: false; status: 404 }
    | { ok: false; status: 409; body: StalePreviewBody }
    | { ok: false; status: 422; body: GateBlockedBody } {
    const stored = this.previews.get(token);
    if (!stored) return { ok: false, status: 404 };
    if (stored.consumed) {
      const fresh = this.shapePreview(stored, this.evaluate(stored.producerParsed, stored.policy));
      return { ok: false, status: 409, body: { error: 'stale_preview', fresh, changed: [] } };
    }

    // Pinned revisions must still be the current definitions — including
    // consumers ADDED after the preview (a new required consumer must not be
    // silently skipped) and pinned consumers that were deleted.
    const changed: StalePreviewBody['changed'] = [];
    for (const [consumerId, pin] of stored.pins) {
      const row = this.consumers.get(consumerId);
      if (!row || row.revision !== pin.revision) {
        changed.push({ consumerId, fromRevision: pin.revision, toRevision: row ? row.revision : 0 });
      }
    }
    for (const consumerId of this.consumers.keys()) {
      if (!stored.pins.has(consumerId)) {
        changed.push({ consumerId, fromRevision: 0, toRevision: this.consumers.get(consumerId)!.revision });
      }
    }
    if (changed.length > 0) {
      const fresh = this.shapePreview(stored, this.evaluate(stored.producerParsed, stored.policy));
      return { ok: false, status: 409, body: { error: 'stale_preview', fresh, changed } };
    }

    const verdicts = this.evaluate(stored.producerParsed, stored.policy);
    const preview = this.shapePreview(stored, verdicts);
    if (!preview.gate.admissible) {
      return { ok: false, status: 422, body: { error: 'gate_blocked', preview } };
    }

    stored.consumed = true;
    const record: ReleaseRecord = {
      id: `rel-${this.releases.length + 1}-${crypto.randomBytes(4).toString('hex')}`,
      releasedAt: new Date().toISOString(),
      producerHash: stored.producerHash,
      policy: stored.policy,
      producer: stored.producerRaw,
      producerLint: stored.lint,
      requiredConsumerIds: verdicts.filter(v => v.required).map(v => v.consumerId),
      consumers: verdicts.map(v => ({
        consumerId: v.consumerId,
        consumerName: v.consumerName,
        required: v.required,
        revision: v.consumerRevision,
        schemaHash: v.consumerSchemaHash,
        compatible: v.result.compatible,
        rejectionReasons: v.rejectionReasons,
      })),
      gate: preview.gate,
      previewToken: token,
    };
    this.releases.unshift(record);
    return { ok: true, record };
  }

  listReleases(): ReleaseRecord[] {
    return this.releases;
  }

  getRelease(id: string): ReleaseRecord | undefined {
    return this.releases.find(r => r.id === id);
  }

  // Evaluation runs the SAME bidirectional engine the single-pair view uses;
  // only the backward half (new producer -> deployed consumer) is relevant to
  // the deploy gate, but counterexamples are the same validator-proven objects.
  private evaluate(producerParsed: Schema, policy: 'fail' | 'passthrough'): ConsumerVerdict[] {
    const producer = applyDefaultPolicy(producerParsed, policy);
    return [...this.consumers.values()].map(row => {
      const consumer = applyDefaultPolicy(row.parsedSchema, row.policy);
      const report = compareSchemas(consumer, producer);
      const result = report.backward; // v2(producer) -> v1(consumer)
      const rejectionReasons = result.compatible
        ? []
        : result.counterexamples.slice(0, 3).map(ce => ce.reason);
      const status: ConsumerVerdict['status'] = !result.compatible && row.required
        ? 'required_blocking'
        : !result.compatible
          ? 'risk_non_required'
          : 'pass';
      return {
        consumerId: row.id,
        consumerName: row.name,
        required: row.required,
        consumerRevision: row.revision,
        consumerSchemaHash: hashSchema(row.parsedSchema),
        result,
        status,
        rejectionReasons,
      };
    });
  }

  private shapePreview(stored: StoredPreview, verdicts: ConsumerVerdict[]): Preview {
    const blocking = verdicts
      .filter(v => v.status === 'required_blocking')
      .map(v => ({ consumerId: v.consumerId, reasons: v.rejectionReasons }));
    const risks = verdicts
      .filter(v => v.status === 'risk_non_required')
      .map(v => ({ consumerId: v.consumerId, reasons: v.rejectionReasons }));
    return {
      token: stored.token,
      createdAt: stored.createdAt,
      producerHash: stored.producerHash,
      policy: stored.policy,
      requiredConsumerIds: verdicts.filter(v => v.required).map(v => v.consumerId),
      pins: verdicts.map(v => ({
        consumerId: v.consumerId,
        revision: v.consumerRevision,
        required: v.required,
        schemaHash: v.consumerSchemaHash,
      })),
      verdicts,
      lint: stored.lint,
      gate: { admissible: blocking.length === 0, blocking, risks },
    };
  }

  private rememberPreview(stored: StoredPreview): void {
    this.previewOrder.push(stored.token);
    this.previews.set(stored.token, stored);
    while (this.previewOrder.length > MAX_PREVIEWS) {
      const old = this.previewOrder.shift()!;
      this.previews.delete(old);
    }
  }

  private freshId(name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'consumer';
    let id = slug;
    let n = 2;
    while (this.consumers.has(id)) id = `${slug}-${n++}`;
    return id;
  }

  private summary(row: ConsumerRow): ConsumerSummary {
    return {
      id: row.id,
      name: row.name,
      required: row.required,
      revision: row.revision,
      schemaHash: hashSchema(row.parsedSchema),
      updatedAt: row.updatedAt,
    };
  }

  private detail(row: ConsumerRow): ConsumerDetail {
    return {
      ...this.summary(row),
      schema: row.schemaRaw,
      policy: row.policy,
      lint: lintSchema(row.parsedSchema),
    };
  }
}
