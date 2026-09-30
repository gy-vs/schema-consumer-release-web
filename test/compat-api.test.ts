import {afterEach,describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {resetCacheForTests} from '../src/server/compat';
import {presets} from '../src/shared/presets';

afterEach(()=>resetCacheForTests());

const addBranch = presets.find(p=>p.id==='add-branch')!;

describe('compat api',()=>{
  it('lists presets without leaking schemas',async()=>{
    const app=createApp();
    const res=await request(app).get('/api/compat/presets').expect(200);
    expect(res.body.length).toBe(presets.length);
    expect(res.body[0]).not.toHaveProperty('v1');
    const one=await request(app).get('/api/compat/presets/add-branch').expect(200);
    expect(one.body.v1).toBeDefined();
  });

  it('returns backward / forward / full as three independent verdicts',async()=>{
    const app=createApp();
    const res=await request(app).post('/api/compat/compare')
      .send({v1:addBranch.v1,v2:addBranch.v2,policy:'fail'}).expect(200);
    const {report}=res.body;
    expect(report.backward.compatible).toBe(false);
    expect(report.forward.compatible).toBe(true);
    expect(report.fullyCompatible).toBe(false);
    expect(report.backward.producer).toBe('v2');
    expect(report.backward.consumer).toBe('v1');
    expect(report.forward.producer).toBe('v1');
    expect(report.forward.consumer).toBe('v2');
  });

  it('counterexample routes through the union path and is validator-proven',async()=>{
    const app=createApp();
    const res=await request(app).post('/api/compat/compare')
      .send({v1:addBranch.v1,v2:addBranch.v2,policy:'fail'}).expect(200);
    const ce=res.body.report.backward.counterexamples[0];
    expect(ce.instance.type).toBe('merged');
    expect(ce.validatesAs).toEqual({producer:true,consumer:false});
    expect(ce.consumerErrors.length).toBeGreaterThan(0);
    expect(ce.producerErrors).toEqual([]);
    expect(ce.unionPath[0].value).toBe('merged');
    expect(ce.unionPath[0].consumerStrategy).toBe('fail');
  });

  it('second identical compare is served from direction-bearing cache keys',async()=>{
    const app=createApp();
    const payload={v1:addBranch.v1,v2:addBranch.v2,policy:'fail'};
    const first=await request(app).post('/api/compat/compare').send(payload).expect(200);
    // a miss computes both directions once and pre-warms the sibling key
    expect(first.body.cache.hits).toEqual({backward:false,forward:true});
    const second=await request(app).post('/api/compat/compare').send(payload).expect(200);
    expect(second.body.cache.hits).toEqual({backward:true,forward:true});
    expect(second.body.cache.keys.backward).toContain('backward');
    expect(second.body.cache.keys.forward).toContain('forward');
    expect(second.body.cache.keys.backward).not.toBe(second.body.cache.keys.forward);
  });

  it('cache keys distinguish unknown-branch policy: verdicts differ',async()=>{
    const app=createApp();
    const closed=await request(app).post('/api/compat/compare')
      .send({v1:addBranch.v1,v2:addBranch.v2,policy:'fail'}).expect(200);
    const open=await request(app).post('/api/compat/compare')
      .send({v1:addBranch.v1,v2:addBranch.v2,policy:'passthrough'}).expect(200);
    expect(closed.body.cache.keys.backward).not.toContain(open.body.cache.keys.backward);
    // under passthrough both unions are open, so the new merged value flows through
    expect(open.body.report.backward.compatible).not.toBe(closed.body.report.backward.compatible);
    expect(closed.body.report.backward.compatible).toBe(false);
  });

  it('rejects malformed schemas with 400',async()=>{
    const app=createApp();
    const res=await request(app).post('/api/compat/compare')
      .send({v1:{kind:'wat'},v2:{kind:'object'},policy:'fail'}).expect(400);
    expect(res.body.error).toBe('invalid_schema');
    expect(res.body.issues.length).toBeGreaterThan(0);
  });

  it('preset coverage: every preset verdict matches its expectation via HTTP',async()=>{
    const app=createApp();
    for(const preset of presets){
      const res=await request(app).post('/api/compat/compare')
        .send({v1:preset.v1,v2:preset.v2,policy:preset.policy}).expect(200);
      expect(res.body.report.backward.compatible,`${preset.id} backward`).toBe(preset.expectBackward);
      expect(res.body.report.forward.compatible,`${preset.id} forward`).toBe(preset.expectForward);
    }
  });
});
