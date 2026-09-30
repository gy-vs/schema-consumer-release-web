// Schema model for discriminated unions, plus validator / minimal-instance
// generation used by both the compatibility engine and the HTTP layer.
//
// A schema is one of:
//   {kind:'string'|'number'|'integer'|'boolean'}
//   {kind:'object', fields?: {[name]: {optional?:boolean, schema:Schema}},
//                    additionalProperties?:boolean /* default: false */}
//   {kind:'union', discriminator:string,
//                  branches?: {value:string, payload:ObjectSchema}[],
//                  unknown?: {mode:'fail'}                            // closed union (default)
//                         | {mode:'passthrough'}                       // open union: any value accepted
//                         | {mode:'default', defaultPayload:Object}}   // unknown values route to default branch

export type PrimitiveKind = 'string' | 'number' | 'integer' | 'boolean';
export interface PrimitiveSchema { kind: PrimitiveKind }
export interface FieldSchema { optional?: boolean; schema: Schema }
export interface ObjectSchema {
  kind: 'object';
  fields?: Record<string, FieldSchema>;
  additionalProperties?: boolean;
}
export interface Branch { value: string; payload: ObjectSchema }
export type UnknownStrategy =
  | { mode: 'fail' }
  | { mode: 'passthrough' }
  | { mode: 'default'; defaultPayload: ObjectSchema };
export interface UnionSchema {
  kind: 'union';
  discriminator: string;
  branches?: Branch[];
  unknown?: UnknownStrategy;
}
export type Schema = PrimitiveSchema | ObjectSchema | UnionSchema;

export interface Issue { path: string; code: string; message: string }

const PRIMITIVES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean']);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validatePrimitive(kind: PrimitiveKind, value: unknown, issues: Issue[], path: string): void {
  if (kind === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      issues.push({ path, code: 'type_error', message: `expected integer at ${path}` });
    }
    return;
  }
  if (kind === 'number') {
    if (typeof value !== 'number') issues.push({ path, code: 'type_error', message: `expected number at ${path}` });
    return;
  }
  if (typeof value !== kind) issues.push({ path, code: 'type_error', message: `expected ${kind} at ${path}` });
}

// allowedExtra: a key validated by the enclosing union (the discriminator),
// so the object must not flag it as an additional property.
export function validateObject(
  schema: ObjectSchema,
  data: unknown,
  issues: Issue[],
  path = '$',
  allowedExtra?: string,
): void {
  if (!isPlainObject(data)) {
    issues.push({ path, code: 'type_error', message: `expected object at ${path}` });
    return;
  }
  const fields = schema.fields ?? {};
  for (const key of Object.keys(fields)) {
    const field = fields[key]!;
    const childPath = `${path}.${key}`;
    if (!(key in data)) {
      if (!field.optional) issues.push({ path: childPath, code: 'required_field_missing', message: `missing required field ${childPath}` });
      continue;
    }
    validateSchema(field.schema, data[key], issues, childPath);
  }
  if (schema.additionalProperties !== true) {
    for (const key of Object.keys(data)) {
      if (!fields[key] && key !== allowedExtra) {
        issues.push({ path: `${path}.${key}`, code: 'additional_property', message: `unexpected field ${path}.${key}` });
      }
    }
  }
}

export function validateUnion(schema: UnionSchema, data: unknown, issues: Issue[], path = '$'): void {
  if (!isPlainObject(data)) {
    issues.push({ path, code: 'type_error', message: `expected union object at ${path}` });
    return;
  }
  const d = schema.discriminator;
  if (!(d in data)) {
    issues.push({ path, code: 'discriminator_missing', message: `missing discriminator field '${d}' at ${path}` });
    return;
  }
  const tag = data[d];
  if (typeof tag !== 'string') {
    issues.push({ path, code: 'discriminator_type', message: `discriminator '${d}' at ${path} must be a string` });
    return;
  }
  const branch = (schema.branches ?? []).find(b => b.value === tag);
  if (branch) {
    validateObject(branch.payload, data, issues, path, d);
    return;
  }
  const strategy = schema.unknown ?? { mode: 'fail' as const };
  if (strategy.mode === 'fail') {
    issues.push({ path, code: 'unknown_discriminator_value', message: `unknown ${d} value '${tag}' at ${path}` });
    return;
  }
  if (strategy.mode === 'passthrough') return; // open union: any object carrying the tag is accepted
  validateObject(strategy.defaultPayload, data, issues, path, d);
}

export function validateSchema(schema: Schema, data: unknown, issues: Issue[] = [], path = '$'): Issue[] {
  if (schema.kind === 'object') validateObject(schema, data, issues, path);
  else if (schema.kind === 'union') validateUnion(schema, data, issues, path);
  else validatePrimitive(schema.kind, data, issues, path);
  return issues;
}

export function isValid(schema: Schema, data: unknown): boolean {
  return validateSchema(schema, data).length === 0;
}

// ---- Minimal valid instances -------------------------------------------------

function minimalObject(schema: ObjectSchema, injected?: { key: string; value: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (injected && !(injected.key in (schema.fields ?? {}))) out[injected.key] = injected.value;
  for (const key of Object.keys(schema.fields ?? {})) {
    const field = schema.fields![key]!;
    if (key === injected?.key) {
      out[key] = injected.value; // declared discriminator field takes the routed value
      continue;
    }
    if (!field.optional) out[key] = minimalInstance(field.schema);
  }
  return out;
}

function firstBranch(schema: UnionSchema): Branch | undefined {
  return (schema.branches ?? [])[0];
}

export function minimalInstance(schema: Schema): unknown {
  if (schema.kind === 'object') return minimalObject(schema);
  if (schema.kind === 'string') return 'x';
  if (schema.kind === 'boolean') return true;
  if (schema.kind === 'integer' || schema.kind === 'number') return 1;
  // union (all object/primitive kinds returned above)
  const u = schema as UnionSchema;
  const branch = firstBranch(u);
  if (branch) return minimalObject(branch.payload, { key: u.discriminator, value: branch.value });
  if (u.unknown?.mode === 'default') {
    return minimalObject(u.unknown.defaultPayload, { key: u.discriminator, value: 'x' });
  }
  return { [u.discriminator]: 'x' }; // passthrough, or degenerate empty fail-union
}

// Minimal object for a routed branch payload (explicit or default).
export function minimalBranchObject(
  payload: ObjectSchema,
  discriminator: string,
  value: string,
): Record<string, unknown> {
  return minimalObject(payload, { key: discriminator, value });
}

// ---- Parsing untrusted JSON ---------------------------------------------------

export function parseSchema(input: unknown, path = '$'): { schema?: Schema; errors: Issue[] } {
  const errors: Issue[] = [];
  if (!isPlainObject(input) || typeof input.kind !== 'string') {
    errors.push({ path, code: 'invalid_schema', message: `schema at ${path} must be an object with a string 'kind'` });
    return { errors };
  }
  const kind = input.kind;
  if (PRIMITIVES.has(kind)) return { schema: { kind: kind as PrimitiveKind }, errors };
  if (kind === 'object') {
    const fields: Record<string, FieldSchema> = {};
    if (input.fields !== undefined) {
      if (!isPlainObject(input.fields)) {
        errors.push({ path, code: 'invalid_schema', message: `fields at ${path} must be an object` });
      } else {
        for (const key of Object.keys(input.fields)) {
          const raw = input.fields[key];
          const childPath = `${path}.fields.${key}`;
          if (!isPlainObject(raw)) {
            errors.push({ path: childPath, code: 'invalid_schema', message: `field ${key} at ${path} must be an object` });
            continue;
          }
          const parsed = parseSchema(raw.schema, `${childPath}.schema`);
          if (parsed.schema) fields[key] = { optional: raw.optional === true ? true : undefined, schema: parsed.schema };
          errors.push(...parsed.errors);
        }
      }
    }
    const schema: ObjectSchema = { kind: 'object' };
    if (Object.keys(fields).length) schema.fields = fields;
    if (input.additionalProperties === true) schema.additionalProperties = true;
    return errors.length ? { errors } : { schema, errors };
  }
  if (kind === 'union') {
    const schema: UnionSchema = { kind: 'union', discriminator: '', branches: [] };
    if (typeof input.discriminator !== 'string' || input.discriminator.length === 0) {
      errors.push({ path, code: 'invalid_schema', message: `union at ${path} needs a non-empty string 'discriminator'` });
    } else schema.discriminator = input.discriminator;
    if (input.branches !== undefined) {
      if (!Array.isArray(input.branches)) {
        errors.push({ path, code: 'invalid_schema', message: `branches at ${path} must be an array` });
      } else {
        input.branches.forEach((raw, i) => {
          const bp = `${path}.branches[${i}]`;
          if (!isPlainObject(raw) || typeof raw.value !== 'string') {
            errors.push({ path: bp, code: 'invalid_schema', message: `branch ${i} at ${path} needs a string 'value'` });
            return;
          }
          const parsed = parseSchema(raw.payload, `${bp}.payload`);
          if (parsed.schema) {
            if (parsed.schema.kind !== 'object') {
              errors.push({ path: `${bp}.payload`, code: 'invalid_schema', message: `branch '${raw.value}' payload must be an object` });
            } else schema.branches!.push({ value: raw.value, payload: parsed.schema });
          }
          errors.push(...parsed.errors);
        });
      }
    }
    if (input.unknown !== undefined) {
      const u = input.unknown;
      const up = `${path}.unknown`;
      if (!isPlainObject(u) || (u.mode !== 'fail' && u.mode !== 'passthrough' && u.mode !== 'default')) {
        errors.push({ path: up, code: 'invalid_schema', message: `unknown at ${path} must be fail | passthrough | default` });
      } else if (u.mode === 'fail') {
        schema.unknown = { mode: 'fail' };
      } else if (u.mode === 'passthrough') {
        schema.unknown = { mode: 'passthrough' };
      } else {
        const parsed = parseSchema(u.defaultPayload, `${up}.defaultPayload`);
        if (parsed.schema) {
          if (parsed.schema.kind !== 'object') {
            errors.push({ path: `${up}.defaultPayload`, code: 'invalid_schema', message: 'defaultPayload must be an object' });
          } else schema.unknown = { mode: 'default', defaultPayload: parsed.schema };
        }
        errors.push(...parsed.errors);
      }
    }
    return errors.length ? { errors } : { schema, errors };
  }
  errors.push({ path, code: 'invalid_schema', message: `unknown schema kind '${kind}' at ${path}` });
  return { errors };
}

// ---- Lint (well-formed but semantically suspicious schemas) -------------------

export function lintSchema(schema: Schema, path = '$', out: Issue[] = []): Issue[] {
  if (schema.kind === 'object') {
    for (const key of Object.keys(schema.fields ?? {})) lintSchema(schema.fields![key]!.schema, `${path}.fields.${key}`, out);
    return out;
  }
  if (schema.kind === 'union') {
    const seen = new Map<string, number>();
    (schema.branches ?? []).forEach((b, i) => {
      const prev = seen.get(b.value);
      if (prev !== undefined) {
        out.push({
          path: `${path}.branches[${i}]`,
          code: 'duplicate_branch_value',
          message: `discriminator value '${b.value}' at ${path} is also used by branches[${prev}]`,
        });
      } else seen.set(b.value, i);
      lintSchema(b.payload, `${path}.branches[${i}].payload`, out);
    });
    if (schema.unknown?.mode === 'default') lintSchema(schema.unknown.defaultPayload, `${path}.unknown.defaultPayload`, out);
    if ((schema.branches ?? []).length === 0 && (!schema.unknown || schema.unknown.mode === 'fail')) {
      out.push({ path, code: 'empty_union', message: `union at ${path} has no branches and no open strategy` });
    }
  }
  return out;
}

// Fill implicit unknown strategies (unions that do not declare one get the
// consumer policy assumed by the comparison request).
export function applyDefaultPolicy(schema: Schema, policy: 'fail' | 'passthrough'): Schema {
  if (schema.kind === 'object') {
    const fields: Record<string, FieldSchema> = {};
    for (const key of Object.keys(schema.fields ?? {})) {
      const f = schema.fields![key]!;
      fields[key] = { optional: f.optional, schema: applyDefaultPolicy(f.schema, policy) };
    }
    return { kind: 'object', fields, additionalProperties: schema.additionalProperties };
  }
  if (schema.kind === 'union') {
    return {
      kind: 'union',
      discriminator: schema.discriminator,
      branches: (schema.branches ?? []).map(b => ({ value: b.value, payload: applyDefaultPolicy(b.payload, policy) as ObjectSchema })),
      unknown: schema.unknown ?? { mode: policy },
    };
  }
  return { ...schema };
}

// Deterministic JSON for cache keys.
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Pick a discriminator value that is unused by either branch map.
export function freshUnknownValue(values: ReadonlySet<string>): string {
  let candidate = '__unknown__';
  let i = 1;
  while (values.has(candidate)) candidate = `__unknown_${i++}__`;
  return candidate;
}
