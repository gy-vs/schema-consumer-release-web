import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {presets} from '../src/shared/presets';
import {PreviewResponse, ReleaseRecord} from '../src/shared/api';
import {isValid} from '../src/shared/schema';

const addBranch = presets.find(p => p.id === 'add-branch')!;
const openUnion = presets.find(p => p.id === 'open-union')!;

const draftWithMerged = addBranch.v2; // created{id}, archived{}, merged{mergedBy} — closed union
const draftNoMerged = {
  kind: 'union',
  discriminator: 'type',
  branches: [
    {value: 'created', payload: {kind: 'object', fields: {id: {schema: {kind: 'string'}}}}},
    {value: 'archived', payload: {kind: 'object'}},
  ],
};

function postPreview(app: ReturnType<typeof createApp>, producer: unknown, policy: 'fail' | 'passthrough' = 'fail') {
  return request(app).post('/api/release/preview').send({producer, policy});
}

function byId(preview: PreviewResponse, id: string) {
  const v = preview.consumers.find(c => c.consumerId === id)!;
  expect(v, `verdict for ${id}`).toBeDefined();
  return v;
}

describe('release governance: consumer fleet', () => {
  it('seeds three named consumers on different cadences, with required flags', async () => {
    const app = createApp();
    const res = await request(app).get('/api/release/consumers').expect(200);
    const byIdMap = new Map<string, any>(res.body.map((c: any) => [c.id, c]));
    expect(byIdMap.has('consumer-a')).toBe(true); // 甲 old definition
    expect(byIdMap.has('consumer-b')).toBe(true); // 乙 intermediate
    expect(byIdMap.has('consumer-c')).toBe(true); // 丙 open union only
    expect(byIdMap.get('consumer-a').required).toBe(true);
    expect(byIdMap.get('consumer-b').required).toBe(true);
    expect(byIdMap.get('consumer-c').required).toBe(false);
    const c = await request(app).get('/api/release/consumers/consumer-c').expect(200);
    expect(c.body.consumer.schema.unknown.mode).toBe('passthrough');
  });

  it('a draft adding merged: per-consumer backward verdicts differ and the required gate blocks', async () => {
    const app = createApp();
    const res = await postPreview(app, draftWithMerged).expect(200);
    const preview: PreviewResponse = res.body;

    // Directional verdicts stay independent and sourced — never one light.
    expect(byId(preview, 'consumer-a').backward.compatible).toBe(false); // closed old consumer
    expect(byId(preview, 'consumer-b').backward.compatible).toBe(true);  // intermediate knows merged
    expect(byId(preview, 'consumer-c').backward.compatible).toBe(true);  // open union passes it through

    // 丙 is open: its forward direction is still a visible RISK (it may emit a
    // bare object the closed draft rejects) even though backward is fine.
    expect(byId(preview, 'consumer-c').forward.compatible).toBe(false);

    expect(preview.gate.passes).toBe(false);
    expect(preview.gate.requiredChecked).toBe(2);
    expect(preview.gate.requiredBlocked.map(b => b.consumerId)).toEqual(['consumer-a']);
    expect(preview.previewToken.length).toBeGreaterThan(10);
    expect(preview.pinned.map(p => p.id).sort()).toEqual(['consumer-a', 'consumer-b', 'consumer-c']);
  });

  it('backward counterexample in a consumer verdict is the same validator-proven artifact', async () => {
    const app = createApp();
    const res = await postPreview(app, draftWithMerged).expect(200);
    const ce = byId(res.body, 'consumer-a').backward.counterexamples[0];
    expect((ce.instance as {type: string}).type).toBe('merged');
    expect(ce.validatesAs).toEqual({producer: true, consumer: false});
    expect(ce.producerErrors).toEqual([]);
    expect(ce.consumerErrors.length).toBeGreaterThan(0);
    // sanity: instance genuinely validates against the draft and not against 甲
    expect(isValid(draftWithMerged as any, ce.instance)).toBe(true);
  });

  it('confirming a gate-blocked preview is rejected with 422 and creates nothing', async () => {
    const app = createApp();
    const preview = (await postPreview(app, draftWithMerged)).body as PreviewResponse;
    const blocked = await request(app).post('/api/release/confirm').send({previewToken: preview.previewToken}).expect(422);
    expect(blocked.body.error).toBe('gate_blocked');
    expect(blocked.body.preview.gate.passes).toBe(false);
    await request(app).get('/api/release/releases').expect(200, []);
  });

  it('a stale preview cannot be approved after another user changes a consumer (409 + fresh preview)', async () => {
    const app = createApp();
    // Gate-passing draft: created + archived only.
    const oldPreview = (await postPreview(app, draftNoMerged)).body as PreviewResponse;
    expect(oldPreview.gate.passes).toBe(true);

    // Someone else moves 乙 forward to a definition that no longer carries
    // archived... simulate an edit: 乙 drops archived.
    const b = await request(app).get('/api/release/consumers/consumer-b').expect(200);
    const bOnlyCreated = {
      kind: 'union',
      discriminator: 'type',
      branches: [{value: 'created', payload: {kind: 'object', fields: {id: {schema: {kind: 'string'}}}}}],
    };
    await request(app)
      .put('/api/release/consumers/consumer-b')
      .send({revision: b.body.consumer.revision, schema: bOnlyCreated})
      .expect(200);

    const stale = await request(app).post('/api/release/confirm').send({previewToken: oldPreview.previewToken}).expect(409);
    expect(stale.body.error).toBe('preview_stale');
    expect(stale.body.divergence).toEqual([
      {id: 'consumer-b', pinnedRevision: oldPreview.pinned.find(p => p.id === 'consumer-b')!.revision, currentRevision: 3},
    ]);
    // Server hands back the recomputed state so the UI never trusts the old light.
    const current: PreviewResponse = stale.body.currentPreview;
    expect(current.fingerprint).not.toBe(oldPreview.fingerprint);
    expect(byId(current, 'consumer-b').revision).toBe(3);

    // Nothing was published.
    await request(app).get('/api/release/releases').expect(200, []);
  });

  it('optimistic revision guard: a second writer with a stale revision gets 409', async () => {
    const app = createApp();
    const b = await request(app).get('/api/release/consumers/consumer-b').expect(200);
    const rev = b.body.consumer.revision;
    await request(app)
      .put('/api/release/consumers/consumer-b')
      .send({revision: rev, name: '消费方乙 · 已升级'})
      .expect(200);
    const conflict = await request(app)
      .put('/api/release/consumers/consumer-b')
      .send({revision: rev, name: 'lost update'})
      .expect(409);
    expect(conflict.body.error).toBe('revision_conflict');
    expect(conflict.body.current.revision).toBe(rev + 1);
  });

  it('a fresh preview confirms, and the stored record pins revisions, schemas and producer', async () => {
    const app = createApp();
    const preview = (await postPreview(app, draftNoMerged)).body as PreviewResponse;
    const res = await request(app).post('/api/release/confirm').send({previewToken: preview.previewToken}).expect(201);
    const record: ReleaseRecord = res.body.release;
    expect(record.producerFingerprint).toBe(preview.fingerprint);
    expect(record.consumers.map(c => c.consumerId).sort()).toEqual(['consumer-a', 'consumer-b', 'consumer-c']);

    // The record carries each consumer's accepted schema AND revision snapshot.
    const a = record.consumers.find(c => c.consumerId === 'consumer-a')!;
    expect(a.revision).toBe(preview.pinned.find(p => p.id === 'consumer-a')!.revision);
    expect(a.schema.kind).toBe('union');
    expect(a.backward.compatible).toBe(true);
    // 乙 is required but its FORWARD risk (still emits merged; draft dropped it)
    // is recorded without changing the admission rule.
    const b = record.consumers.find(c => c.consumerId === 'consumer-b')!;
    expect(b.required).toBe(true);
    expect(b.backward.compatible).toBe(true);
    expect(b.forward.compatible).toBe(false);

    // Reopen the page later: the decision is queryable server-side, not just in
    // the browser's last computation.
    const again = await request(app).get(`/api/release/releases/${record.id}`).expect(200);
    expect(again.body.id).toBe(record.id);
    expect(again.body.producer).toEqual(record.producer);
    expect(again.body.consumers).toHaveLength(3);

    const list = await request(app).get('/api/release/releases').expect(200);
    expect(list.body[0].id).toBe(record.id);
  });

  it('confirming the same approved content twice reports the existing release, not a duplicate', async () => {
    const app = createApp();
    const p1 = (await postPreview(app, draftNoMerged)).body as PreviewResponse;
    const r1 = await request(app).post('/api/release/confirm').send({previewToken: p1.previewToken}).expect(201);
    const p2 = (await postPreview(app, draftNoMerged)).body as PreviewResponse;
    const dup = await request(app).post('/api/release/confirm').send({previewToken: p2.previewToken}).expect(409);
    expect(dup.body.error).toBe('release_exists');
    expect(dup.body.release.id).toBe(r1.body.release.id);
  });

  it('a non-required consumer that rejects the draft stays a risk and never moves the gate', async () => {
    const app = createApp();
    // Add 丁: closed, only knows `created`, explicitly NOT required.
    await request(app)
      .post('/api/release/consumers')
      .send({
        name: '消费方丁 · 非必需封闭',
        required: false,
        schema: {kind: 'union', discriminator: 'type', branches: [{value: 'created', payload: {kind: 'object'}}]},
      })
      .expect(201);

    const preview = (await postPreview(app, draftWithMerged)).body as PreviewResponse;
    const d = preview.consumers.find(c => c.name.startsWith('消费方丁'))!;
    expect(d.required).toBe(false);
    expect(d.backward.compatible).toBe(false); // would reject archived/merged
    // Required blockers list only 甲; 丁's rejection is risk, not admission.
    expect(preview.gate.requiredBlocked.map(x => x.consumerId)).toEqual(['consumer-a']);
    expect(preview.gate.passes).toBe(false); // blocked by required 甲, not by 丁

    // With a draft everyone required can read, 丁 still failing does not block.
    const passing = (await postPreview(app, draftNoMerged)).body as PreviewResponse;
    const d2 = passing.consumers.find(c => c.name.startsWith('消费方丁'))!;
    expect(d2.backward.compatible).toBe(false);
    expect(passing.gate.passes).toBe(true);
    const record = (await request(app).post('/api/release/confirm').send({previewToken: passing.previewToken}).expect(201)).body.release as ReleaseRecord;
    expect(record.consumers.find(c => c.consumerId === d2.consumerId)!.backward.compatible).toBe(false);
  });

  it('flipping a non-required blocker to required tightens the gate', async () => {
    const app = createApp();
    const created = await request(app)
      .post('/api/release/consumers')
      .send({name: '丁', required: false, schema: {kind: 'union', discriminator: 'type', branches: [{value: 'created', payload: {kind: 'object'}}]}})
      .expect(201);
    const before = (await postPreview(app, draftNoMerged)).body as PreviewResponse;
    expect(before.gate.passes).toBe(true);

    await request(app)
      .put(`/api/release/consumers/${created.body.consumer.id}`)
      .send({revision: created.body.consumer.revision, required: true})
      .expect(200);
    const after = (await postPreview(app, draftNoMerged)).body as PreviewResponse;
    expect(after.gate.passes).toBe(false);
    expect(after.gate.requiredBlocked.map(b => b.consumerId)).toContain(created.body.consumer.id);
    // The old preview cannot confirm: the required set itself moved.
    await request(app).post('/api/release/confirm').send({previewToken: before.previewToken}).expect(409);
  });

  it('an invalid token and malformed producer schema are rejected without state change', async () => {
    const app = createApp();
    await request(app).post('/api/release/confirm').send({previewToken: 'not-a-token'}).expect(400);
    const bad = await postPreview(app, {kind: 'union', discriminator: 'type', branches: 'oops'}).expect(400);
    expect(bad.body.error).toBe('invalid_schema');
    await request(app).get('/api/release/releases').expect(200, []);
  });

  it('policy participates in the fingerprint: same draft, different policy is a different submission', async () => {
    const app = createApp();
    const fail = (await postPreview(app, openUnion.v2, 'fail')).body as PreviewResponse;
    const pass = (await postPreview(app, openUnion.v2, 'passthrough')).body as PreviewResponse;
    expect(fail.fingerprint).not.toBe(pass.fingerprint);
  });
});
