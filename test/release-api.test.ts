import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {ReleaseStore} from '../src/server/release-routes';
import {presets} from '../src/shared/presets';
import type {Preview, ReleaseRecord} from '../src/shared/release';

// End-to-end (HTTP) tests for the multi-consumer release workflow:
// named/versioned consumers, required-set admission gate, preview-token
// freshness (the browser can never authorize an old result), server-side
// confirmation, and the persisted decision record.

const addBranch = presets.find(p=>p.id==='add-branch')!;
const producerDraft = addBranch.v2; // created + archived + merged

function app(){return createApp({releaseStore:new ReleaseStore()});}

function previewFor(a:ReturnType<typeof app>, producer:unknown=producerDraft, policy:'fail'|'passthrough'='fail'){
  return request(a).post('/api/release/preview').send({producer,policy});
}

describe('multi-consumer roster',()=>{
  it('seeds named consumers at their own revisions with per-consumer policies',async()=>{
    const a=app();
    const res=await request(a).get('/api/release/consumers').expect(200);
    const byId=new Map<string,any>(res.body.map((c:any)=>[c.id,c]));
    expect([...byId.keys()]).toEqual(['consumer-a','consumer-b','consumer-c']);
    expect(byId.get('consumer-a').required).toBe(true);
    expect(byId.get('consumer-b').required).toBe(true);
    expect(byId.get('consumer-c').required).toBe(false);
    expect(byId.get('consumer-a').revision).toBe(1);
    const detail=await request(a).get('/api/release/consumers/consumer-c').expect(200);
    expect(detail.body.policy).toBe('passthrough');
    expect(detail.body.schema.unknown.mode).toBe('passthrough');
    expect(detail.body.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates a consumer and defaults it to non-required (cannot move the gate)',async()=>{
    const a=app();
    const res=await request(a).post('/api/release/consumers').send({
      name:'消费方丁',required:false,policy:'fail',
      schema:{kind:'union',discriminator:'type',branches:[{value:'x',payload:{kind:'object'}}]},
    }).expect(201);
    expect(res.body.required).toBe(false);
    expect(res.body.revision).toBe(1);
    expect(/^[\w-]+$/.test(res.body.id)).toBe(true);
  });

  it('rejects a malformed consumer schema with 400 and validation issues',async()=>{
    const a=app();
    const res=await request(a).post('/api/release/consumers').send({
      name:'bad',required:false,policy:'fail',schema:{kind:'union'},
    }).expect(400);
    expect(res.body.error).toBe('invalid_consumer');
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  it('updates are optimistic-concurrency guarded by revision',async()=>{
    const a=app();
    const cur=await request(a).get('/api/release/consumers/consumer-a').expect(200);
    const body={name:cur.body.name,required:true,policy:'fail',schema:cur.body.schema,expectedRevision:cur.body.revision};
    await request(a).put('/api/release/consumers/consumer-a').send(body).expect(200);
    // repeating with the SAME revision conflicts and returns the current row
    const stale=await request(a).put('/api/release/consumers/consumer-a').send(body).expect(409);
    expect(stale.body.error).toBe('revision_conflict');
    expect(stale.body.current.revision).toBe(cur.body.revision+1);
  });

  it('toggling required or editing the schema bumps the revision',async()=>{
    const a=app();
    const cur=await request(a).get('/api/release/consumers/consumer-a').expect(200);
    const res=await request(a).put('/api/release/consumers/consumer-a').send({
      name:cur.body.name,required:false,policy:'fail',schema:cur.body.schema,expectedRevision:cur.body.revision,
    }).expect(200);
    expect(res.body.revision).toBe(2);
    expect(res.body.required).toBe(false);
  });
});

describe('preview against multiple consumers',()=>{
  it('returns one sourced directional verdict per consumer, never one folded light',async()=>{
    const a=app();
    const res=await previewFor(a).expect(200);
    const p=res.body as Preview;
    expect(p.verdicts).toHaveLength(3);
    const ids=p.verdicts.map(v=>v.consumerId);
    expect(ids).toEqual(['consumer-a','consumer-b','consumer-c']);

    const va=p.verdicts.find(v=>v.consumerId==='consumer-a')!;
    const vb=p.verdicts.find(v=>v.consumerId==='consumer-b')!;
    const vc=p.verdicts.find(v=>v.consumerId==='consumer-c')!;

    // 甲 on the old closed union rejects the new merged value
    expect(va.status).toBe('required_blocking');
    expect(va.result.compatible).toBe(false);
    expect(va.result.producer).toBe('v2');
    expect(va.result.consumer).toBe('v1');
    expect(va.rejectionReasons[0]).toContain('merged');
    // 乙 already accepts merged
    expect(vb.status).toBe('pass');
    expect(vb.result.compatible).toBe(true);
    // 丙 open union passes it through
    expect(vc.status).toBe('pass');
    expect(vc.result.compatible).toBe(true);

    expect(p.gate.admissible).toBe(false);
    expect(p.gate.blocking.map(b=>b.consumerId)).toEqual(['consumer-a']);
    expect(p.gate.risks).toEqual([]);
  });

  it('counterexample is the same validator-proven instance as the single-pair engine',async()=>{
    const a=app();
    const p=(await previewFor(a).expect(200)).body as Preview;
    const va=p.verdicts.find(v=>v.consumerId==='consumer-a')!;
    const ce=va.result.counterexamples[0];
    expect((ce.instance as {type:string}).type).toBe('merged');
    expect(ce.validatesAs).toEqual({producer:true,consumer:false});
    expect(ce.producerErrors).toEqual([]);
    expect(ce.consumerErrors.length).toBeGreaterThan(0);
    expect(ce.unionPath[0].consumerStrategy).toBe('fail');
  });

  it('pins exact consumer revisions and a producer hash',async()=>{
    const a=app();
    const p=(await previewFor(a).expect(200)).body as Preview;
    expect(p.producerHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.pins.map(x=>x.consumerId).sort()).toEqual(['consumer-a','consumer-b','consumer-c']);
    expect(p.pins.every(x=>x.revision===1)).toBe(true);
    expect(p.requiredConsumerIds).toEqual(['consumer-a','consumer-b']);
  });

  it('rejects an unparseable producer draft with 400',async()=>{
    const a=app();
    const res=await request(a).post('/api/release/preview').send({producer:{kind:'nope'},policy:'fail'}).expect(400);
    expect(res.body.error).toBe('invalid_producer');
    expect(res.body.issues.length).toBeGreaterThan(0);
  });
});

describe('confirmation is server-decided and freshness-bound',()=>{
  it('refuses release while a required consumer blocks (gate 422)',async()=>{
    const a=app();
    const p=(await previewFor(a).expect(200)).body as Preview;
    expect(p.gate.admissible).toBe(false);
    const res=await request(a).post('/api/release/releases').send({token:p.token}).expect(422);
    expect(res.body.error).toBe('gate_blocked');
    const list=await request(a).get('/api/release/releases').expect(200);
    expect(list.body).toHaveLength(0);
  });

  it('rejects a stale preview after a pinned consumer moves, and offers a fresh one',async()=>{
    const a=app();
    // make 甲 non-required first so the initial preview would be admissible
    let cur=(await request(a).get('/api/release/consumers/consumer-a')).body;
    await request(a).put('/api/release/consumers/consumer-a').send({
      name:cur.name,required:false,policy:'fail',schema:cur.schema,expectedRevision:cur.revision,
    }).expect(200);

    const p=(await previewFor(a).expect(200)).body as Preview;
    expect(p.gate.admissible).toBe(true);

    // another user changes 甲's definition (it becomes required again)
    cur=(await request(a).get('/api/release/consumers/consumer-a')).body;
    await request(a).put('/api/release/consumers/consumer-a').send({
      name:cur.name,required:true,policy:'fail',schema:cur.schema,expectedRevision:cur.revision,
    }).expect(200);

    const res=await request(a).post('/api/release/releases').send({token:p.token}).expect(409);
    expect(res.body.error).toBe('stale_preview');
    expect(res.body.changed.some((c:any)=>c.consumerId==='consumer-a'&&c.fromRevision===2&&c.toRevision===3)).toBe(true);
    // server recomputed against the current roster and SAME producer draft
    expect(res.body.fresh.gate.admissible).toBe(false);
    expect(res.body.fresh.producerHash).toBe(p.producerHash);
    // the carried preview is a read-only recomputation, not a new approval:
    // confirming with its token is STILL refused until an explicit re-preview
    const retry=await request(a).post('/api/release/releases').send({token:res.body.fresh.token}).expect(409);
    expect(retry.body.error).toBe('stale_preview');
    // an explicit re-preview produces a confirmable fresh token
    const re=(await previewFor(a).expect(200)).body as Preview;
    expect(re.token).not.toBe(p.token);
    expect(re.gate.admissible).toBe(false);
    // nothing was published
    const list=await request(a).get('/api/release/releases').expect(200);
    expect(list.body).toHaveLength(0);
  });

  it('a consumer added after the preview also invalidates confirmation',async()=>{
    const a=app();
    let cur=(await request(a).get('/api/release/consumers/consumer-a')).body;
    await request(a).put('/api/release/consumers/consumer-a').send({
      name:cur.name,required:false,policy:'fail',schema:cur.schema,expectedRevision:cur.revision,
    }).expect(200);
    const p=(await previewFor(a).expect(200)).body as Preview;

    await request(a).post('/api/release/consumers').send({
      name:'消费方丁',required:true,policy:'fail',
      schema:{kind:'union',discriminator:'type',branches:[{value:'created',payload:{kind:'object'}}]},
    }).expect(201);

    const res=await request(a).post('/api/release/releases').send({token:p.token}).expect(409);
    expect(res.body.changed.some((c:any)=>c.fromRevision===0)).toBe(true);
  });

  it('unknown and empty tokens are 404',async()=>{
    const a=app();
    await request(a).post('/api/release/releases').send({token:'deadbeef'}).expect(404);
    await request(a).post('/api/release/releases').send({}).expect(404);
  });

  it('admissible preview is published, the token is single-use, and the record survives reload',async()=>{
    const a=app();
    // 甲 accepts the draft once it moves to the intermediate schema (乙's)
    let cur=(await request(a).get('/api/release/consumers/consumer-a')).body;
    const b=(await request(a).get('/api/release/consumers/consumer-b')).body;
    await request(a).put('/api/release/consumers/consumer-a').send({
      name:cur.name,required:true,policy:'fail',schema:b.schema,expectedRevision:cur.revision,
    }).expect(200);

    const p=(await previewFor(a).expect(200)).body as Preview;
    expect(p.gate.admissible).toBe(true);

    const created=await request(a).post('/api/release/releases').send({token:p.token}).expect(201);
    const record=created.body as ReleaseRecord;
    expect(record.producer).toEqual(producerDraft);
    expect(record.requiredConsumerIds).toEqual(['consumer-a','consumer-b']);
    expect(record.consumers.every(c=>c.compatible||!c.required)).toBe(true);
    // 甲 was pinned at revision 2 (the intermediate update), not its seed r1
    expect(record.consumers.find(c=>c.consumerId==='consumer-a')!.revision).toBe(2);
    expect(record.previewToken).toBe(p.token);

    // token cannot authorize a second release
    await request(a).post('/api/release/releases').send({token:p.token}).expect(409);

    // later inspection reads the server-persisted decision, including content
    const list=await request(a).get('/api/release/releases').expect(200);
    expect(list.body).toHaveLength(1);
    const one=await request(a).get(`/api/release/releases/${record.id}`).expect(200);
    expect(one.body.id).toBe(record.id);
    expect(one.body.producerHash).toBe(p.producerHash);
    expect(one.body.consumers).toHaveLength(3);
    expect(one.body.releasedAt).toBeDefined();
  });
});

describe('non-required consumers show risk without changing admission',()=>{
  it('a draft that only breaks optional consumer 丙 is admissible but flagged',async()=>{
    const a=app();
    // 丙 passthrough accepts anything unknown; craft a draft that breaks its
    // ONLY explicit branch (created) while keeping 甲/乙 satisfied is hard, so
    // instead flip the required set: mark 甲/乙 optional and let 丙 fail.
    for(const id of ['consumer-a','consumer-b']){
      const cur=(await request(a).get(`/api/release/consumers/${id}`)).body;
      await request(a).put(`/api/release/consumers/${id}`).send({
        name:cur.name,required:false,policy:'fail',schema:cur.schema,expectedRevision:cur.revision,
      }).expect(200);
    }
    // give 丙 a closed strict definition that rejects merged
    let c=(await request(a).get('/api/release/consumers/consumer-c')).body;
    await request(a).put('/api/release/consumers/consumer-c').send({
      name:c.name,required:false,policy:'fail',
      schema:{kind:'union',discriminator:'type',branches:[
        {value:'created',payload:{kind:'object',fields:{id:{schema:{kind:'string'}}}}},
      ]},
      expectedRevision:c.revision,
    }).expect(200);

    const p=(await previewFor(a).expect(200)).body as Preview;
    // gate has NO required members blocking: admissible
    expect(p.gate.admissible).toBe(true);
    expect(p.requiredConsumerIds).toEqual([]);
    // 甲 (closed, no merged) and 丙 (closed, created-only) reject as risks;
    // 乙's definition equals the draft, so it passes and is not listed.
    expect(p.gate.risks.map(r=>r.consumerId).sort()).toEqual(['consumer-a','consumer-c']);
    const vc=p.verdicts.find(v=>v.consumerId==='consumer-c')!;
    expect(vc.status).toBe('risk_non_required');

    // release succeeds even though 丙 rejects — risk is surfaced, gate unmoved
    const res=await request(a).post('/api/release/releases').send({token:p.token}).expect(201);
    const record=res.body as ReleaseRecord;
    expect(record.gate.admissible).toBe(true);
    const rc=record.consumers.find(x=>x.consumerId==='consumer-c')!;
    expect(rc.compatible).toBe(false);
    expect(rc.required).toBe(false);
    expect(rc.rejectionReasons.length).toBeGreaterThan(0);
  });

  it('making a failing consumer required blocks the gate (rule is membership-driven)',async()=>{
    const a=app();
    // seed preview: 甲 required + rejects merged -> blocked
    const p=(await previewFor(a).expect(200)).body as Preview;
    const va=p.verdicts.find(v=>v.consumerId==='consumer-a')!;
    expect(va.status).toBe('required_blocking');
    expect(p.gate.admissible).toBe(false);
    // 丙 (open, passing) being non-required never rescues the gate
    expect(p.verdicts.find(v=>v.consumerId==='consumer-c')!.status).toBe('pass');
  });
});

describe('per-consumer policies',()=>{
  it('consumer policy is applied per consumer, independent of producer policy',async()=>{
    const a=app();
    // producer policy fail; 丙 itself is passthrough and accepts merged
    const p=(await previewFor(a,producerDraft,'fail').expect(200)).body as Preview;
    const vc=p.verdicts.find(v=>v.consumerId==='consumer-c')!;
    expect(vc.result.compatible).toBe(true);
    expect(vc.result.unknownPolicy.v1.topLevel).toBe('passthrough'); // consumer side
    expect(vc.result.unknownPolicy.v2.topLevel).toBe('fail');        // producer side
  });
});
