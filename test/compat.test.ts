import {describe,expect,it} from 'vitest';
import {presets} from '../src/shared/presets';
import {applyDefaultPolicy,isValid,validateSchema,Schema} from '../src/shared/schema';
import {compareSchemas} from '../src/shared/compat';

// Every counterexample the engine emits must be a proof: accepted by the
// producer validator AND rejected by the consumer validator.
function expectProvenCounterexamples(
  v1: ReturnType<typeof applyDefaultPolicy>,
  v2: ReturnType<typeof applyDefaultPolicy>,
) {
  const report = compareSchemas(v1, v2);
  for (const d of [report.backward, report.forward]) {
    const producer = d.producer === 'v1' ? v1 : v2;
    const consumer = d.consumer === 'v1' ? v1 : v2;
    for (const ce of d.counterexamples) {
      expect(isValid(producer, ce.instance), `${d.direction}: producer must accept ${JSON.stringify(ce.instance)}`).toBe(true);
      expect(isValid(consumer, ce.instance), `${d.direction}: consumer must reject ${JSON.stringify(ce.instance)}`).toBe(false);
      expect(ce.validatesAs.producer).toBe(true);
      expect(ce.validatesAs.consumer).toBe(false);
      expect(validateSchema(consumer, ce.instance).length).toBeGreaterThan(0);
      // minimal: removing any optional leaf should not be needed; instance at
      // least carries the discriminator path
      for (const hop of ce.unionPath) {
        expect(hop.discriminator.length).toBeGreaterThan(0);
      }
    }
  }
  return report;
}

describe('compatibility presets', () => {
  for (const preset of presets) {
    it(`${preset.id}: backward=${preset.expectBackward} forward=${preset.expectForward}`, () => {
      const v1 = applyDefaultPolicy(preset.v1, preset.policy);
      const v2 = applyDefaultPolicy(preset.v2, preset.policy);
      const report = expectProvenCounterexamples(v1, v2);
      expect(report.backward.compatible, report.backward.counterexamples.map(c => c.reason).join('; '))
        .toBe(preset.expectBackward);
      expect(report.forward.compatible, report.forward.counterexamples.map(c => c.reason).join('; '))
        .toBe(preset.expectForward);
      expect(report.fullyCompatible).toBe(preset.expectBackward && preset.expectForward);
    });
  }

  it('add-branch counterexample is the new discriminator value with the union path', () => {
    const p = presets.find(x => x.id === 'add-branch')!;
    const report = compareSchemas(applyDefaultPolicy(p.v1, 'fail'), applyDefaultPolicy(p.v2, 'fail'));
    expect(report.backward.compatible).toBe(false);
    const ce = report.backward.counterexamples[0]!;
    expect((ce.instance as Record<string, unknown>).type).toBe('merged');
    expect(ce.unionPath).toHaveLength(1);
    expect(ce.unionPath[0]!.value).toBe('merged');
    expect(ce.unionPath[0]!.kind).toBe('explicit');
    expect(ce.unionPath[0]!.consumerStrategy).toBe('fail');
  });

  it('rename-discriminator fails in both directions and names both fields', () => {
    const p = presets.find(x => x.id === 'rename-discriminator')!;
    const report = compareSchemas(applyDefaultPolicy(p.v1, 'fail'), applyDefaultPolicy(p.v2, 'fail'));
    expect(report.backward.compatible).toBe(false);
    expect(report.forward.compatible).toBe(false);
    const reason = report.backward.counterexamples[0]!.reason;
    expect(reason).toContain('type');
    expect(reason).toContain('kind');
  });

  it('nested union failure carries both hops', () => {
    const p = presets.find(x => x.id === 'nested-union')!;
    const report = compareSchemas(applyDefaultPolicy(p.v1, 'fail'), applyDefaultPolicy(p.v2, 'fail'));
    const ce = report.backward.counterexamples[0]!;
    const values = ce.unionPath.map(h => h.value);
    expect(values).toEqual(['created', 'sms']);
    expect((ce.instance as Record<string, unknown>).type).toBe('created');
    const detail = (ce.instance as { detail: Record<string, unknown> }).detail;
    expect(detail.channel).toBe('sms');
  });

  it('mapping reorder alone is fully compatible', () => {
    const p = presets.find(x => x.id === 'mapping-reorder')!;
    const report = compareSchemas(applyDefaultPolicy(p.v1, 'fail'), applyDefaultPolicy(p.v2, 'fail'));
    expect(report.fullyCompatible).toBe(true);
  });

  it('value reuse reports a payload-level counterexample under the reused tag', () => {
    const p = presets.find(x => x.id === 'value-reuse')!;
    const report = compareSchemas(applyDefaultPolicy(p.v1, 'fail'), applyDefaultPolicy(p.v2, 'fail'));
    const backward = report.backward.counterexamples.find(
      c => (c.instance as Record<string, unknown>).type === 'created',
    )!;
    expect(backward).toBeDefined();
    const created = backward.instance as { type: string; id: number; at?: string };
    expect(created.type).toBe('created');
    expect(typeof created.id).toBe('number');
  });
});

describe('object fields', () => {
  it('required -> optional is backward-breaking but forward-safe', () => {
    const v1 = { kind: 'object', fields: { a: { schema: { kind: 'string' } } } } as const;
    const v2 = { kind: 'object', fields: { a: { optional: true, schema: { kind: 'string' } } } } as const;
    const report = compareSchemas(v1, v2);
    expect(report.backward.compatible).toBe(false); // new producer may omit a
    expect(report.forward.compatible).toBe(true);
    const ce = report.backward.counterexamples[0]!;
    expect(ce.instance).toEqual({});
  });

  it('extra producer field rejected by closed consumer', () => {
    const v1 = { kind: 'object' } as const;
    const v2 = { kind: 'object', fields: { b: { optional: true, schema: { kind: 'string' } } } } as const;
    const report = compareSchemas(v1, v2);
    expect(report.backward.compatible).toBe(false);
  });

  it('additionalProperties true on producer is backward-breaking for closed consumer', () => {
    const v1 = { kind: 'object', additionalProperties: false } as const;
    const v2 = { kind: 'object', additionalProperties: true } as const;
    const report = compareSchemas(v1, v2);
    expect(report.backward.compatible).toBe(false);
  });
});

describe('unknown branch policies', () => {
  const base = {
    kind: 'union' as const,
    discriminator: 'type',
    branches: [{ value: 'a', payload: { kind: 'object' as const } }],
  };

  it('policy changes the verdict: new value, fail vs passthrough consumer', () => {
    const v1: Schema = {
      kind: 'union',
      discriminator: 'type',
      branches: [{ value: 'a', payload: { kind: 'object' } }],
    };
    const v2: Schema = {
      kind: 'union',
      discriminator: 'type',
      branches: [
        { value: 'a', payload: { kind: 'object' } },
        { value: 'b', payload: { kind: 'object' } },
      ],
    };
    const closed = compareSchemas(applyDefaultPolicy(v1, 'fail'), applyDefaultPolicy(v2, 'fail'));
    expect(closed.backward.compatible).toBe(false);
    const open = compareSchemas(applyDefaultPolicy(v1, 'passthrough'), applyDefaultPolicy(v2, 'passthrough'));
    expect(open.backward.compatible).toBe(true);
  });

  it('default branch payload is checked against explicit producer payloads', () => {
    const v1: Schema = {
      kind: 'union',
      discriminator: 'type',
      branches: [{ value: 'a', payload: { kind: 'object', fields: { id: { schema: { kind: 'string' } } } } }],
    };
    const v2: Schema = {
      kind: 'union',
      discriminator: 'type',
      branches: [
        { value: 'a', payload: { kind: 'object', fields: { id: { schema: { kind: 'string' } } } } },
        { value: 'b', payload: { kind: 'object' } },
      ],
      unknown: { mode: 'default', defaultPayload: { kind: 'object' } },
    };
    // new producer emits b with empty payload; old consumer (fail) rejects.
    const report = compareSchemas(v1, v2);
    expect(report.backward.compatible).toBe(false);
    // and if the OLD side were the one with default, b would route there:
    const oldWithDefault: Schema = { ...v1, unknown: { mode: 'default', defaultPayload: { kind: 'object' } } } as Schema;
    const report2 = compareSchemas(oldWithDefault, v2);
    expect(report2.backward.compatible).toBe(true);
  });
});
