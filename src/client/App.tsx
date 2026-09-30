import {useCallback,useEffect,useMemo,useState} from 'react';
import {FlaskConical, GitCompareArrows, ShieldCheck, ShieldX, ShieldAlert, ArrowRight, CircleDot} from 'lucide-react';
import type {CompareResponse, Counterexample, DirectionResult, UnionHop} from '../shared/api';
import type {Issue} from '../shared/schema';

interface PresetMeta{id:string;label:string;description:string;policy:'fail'|'passthrough';expectBackward:boolean;expectForward:boolean}
interface Preset extends PresetMeta{v1:unknown;v2:unknown}

type Verdict = 'pass'|'fail';

function verdictOf(compatible:boolean):Verdict{return compatible?'pass':'fail'}

function VerdictCard({title,subtitle,result,accent}:{
  title:string;subtitle:string;result:DirectionResult|undefined;accent?:boolean;
}){
  const compatible=result?.compatible;
  const cls=compatible===undefined?'idle':compatible?'pass':'fail';
  const Icon=compatible===undefined?ShieldAlert:compatible?ShieldCheck:ShieldX;
  return <article className={`verdict ${cls} ${accent?'accent':''}`}>
    <header><Icon size={18}/><div><h3>{title}</h3><small>{subtitle}</small></div>
      <span className="badge">{compatible===undefined?'—':compatible?'兼容':'不兼容'}</span>
    </header>
    {result&&<div className="flow">
      <code>{result.producer} 生产者</code><ArrowRight size={13}/><code>{result.consumer} 消费者</code>
      <span className="policytag">未知值: v1={result.unknownPolicy.v1.topLevel} · v2={result.unknownPolicy.v2.topLevel}</span>
    </div>}
    {result&&!result.compatible&&<p className="count">最小反例 {result.counterexamples.length} 个</p>}
  </article>;
}

function HopPath({hops}:{hops:UnionHop[]}){
  if(hops.length===0)return <span className="muted">（无 union 路径）</span>;
  return <ol className="hops">
    {hops.map((hop,i)=><li key={i}>
      <CircleDot size={13} className={`hopkind hop-${hop.kind}`}/>
      <code>{hop.at}</code>
      <span className="dim">判别字段</span><code>{hop.discriminator}</code>
      <span className="dim">=</span><code className="tagval">{hop.value}</code>
      <span className={`routetag route-${hop.kind}`}>{hop.kind==='explicit'?'显式分支':hop.kind==='default'?'默认分支':'开放透传'}</span>
      <span className="dim">策略 p:{hop.producerStrategy}/c:{hop.consumerStrategy}</span>
      {hop.mappedFrom&&<span className="mapped">↦ {hop.mappedFrom}</span>}
    </li>)}
  </ol>;
}

function ErrorList({issues}:{issues:Issue[]}){
  if(issues.length===0)return <span className="muted">无错误</span>;
  return <ul className="issues">{issues.slice(0,5).map((iss,i)=><li key={i}><code>{iss.code}</code> {iss.message}</li>)}</ul>;
}

function CounterexampleCard({ce,index}:{ce:Counterexample;index:number}){
  return <details className="ce" open={index===0}>
    <summary>
      <ShieldX size={14}/>
      <span>{ce.reason}</span>
    </summary>
    <div className="ce-grid">
      <div><h4>穿过的 union 路径</h4><HopPath hops={ce.unionPath}/></div>
      <div><h4>最小反例实例</h4><pre className="instance">{JSON.stringify(ce.instance,null,2)}</pre></div>
      <div className="proof">
        <h4>验证器证明</h4>
        <table>
          <tbody>
            <tr className={ce.validatesAs.producer?'ok':'bad'}><td>{ce.validatedBy.producer} 生产者</td><td>{ce.validatesAs.producer?'接受 ✓':'拒绝 ✗'}</td></tr>
            <tr className={ce.validatesAs.consumer?'ok':'bad'}><td>{ce.validatedBy.consumer} 消费者</td><td>{ce.validatesAs.consumer?'接受 ✓':'拒绝 ✗'}</td></tr>
          </tbody>
        </table>
        <h5>{ce.validatedBy.producer} 验证错误</h5><ErrorList issues={ce.producerErrors}/>
        <h5>{ce.validatedBy.consumer} 验证错误</h5><ErrorList issues={ce.consumerErrors}/>
      </div>
    </div>
  </details>;
}

export default function App(){
  const [presets,setPresets]=useState<PresetMeta[]>([]);
  const [selected,setSelected]=useState<string>('add-branch');
  const [v1Text,setV1Text]=useState('');
  const [v2Text,setV2Text]=useState('');
  const [policy,setPolicy]=useState<'fail'|'passthrough'>('fail');
  const [result,setResult]=useState<CompareResponse|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);

  useEffect(()=>{fetch('/api/compat/presets').then(r=>r.json()).then(setPresets)},[]);

  const compare=useCallback(async(v1:unknown,v2:unknown,pol:'fail'|'passthrough')=>{
    setBusy(true);setError(null);
    try{
      const res=await fetch('/api/compat/compare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({v1,v2,policy:pol})});
      const data=await res.json();
      if(!res.ok){setError(data.issues?data.issues.map((i:Issue)=>i.message).join('\n'):data.error);setResult(null)}
      else setResult(data);
    }finally{setBusy(false)}
  },[]);

  useEffect(()=>{
    if(!selected)return;
    fetch('/api/compat/presets/'+selected).then(r=>r.json()).then((p:Preset)=>{
      setV1Text(JSON.stringify(p.v1,null,2));
      setV2Text(JSON.stringify(p.v2,null,2));
      setPolicy(p.policy);
      compare(p.v1,p.v2,p.policy);
    });
  },[selected,compare]);

  const runFromEditors=()=>{
    let v1:unknown,v2:unknown;
    try{v1=JSON.parse(v1Text)}catch(e){setError('v1 JSON 解析失败: '+(e as Error).message);return}
    try{v2=JSON.parse(v2Text)}catch(e){setError('v2 JSON 解析失败: '+(e as Error).message);return}
    compare(v1,v2,policy);
  };

  const lintIssues=useMemo(()=>{
    if(!result)return [];
    return [...result.lint.v1.map(i=>({side:'v1' as const,...i})),...result.lint.v2.map(i=>({side:'v2' as const,...i}))];
  },[result]);

  const backward=result?.report.backward;
  const forward=result?.report.forward;
  const full=result?verdictOf(result.report.fullyCompatible):undefined;

  return <main className="shell">
    <header className="topbar">
      <FlaskConical size={20}/><strong>Schema 演进工作台 · Discriminated Union</strong>
      <small>生产者/消费者双向兼容性</small>
    </header>
    <section className="workspace compat-layout">
      <aside className="pane scenarios">
        <h2>场景</h2>
        <div className="list">
          {presets.map(p=><button key={p.id} className={p.id===selected?'active':''} onClick={()=>setSelected(p.id)}>
            <span className="scn-label">{p.label}</span>
            <span className="scn-dots">
              <i className={p.expectBackward?'dot pass':'dot fail'} title={`向后 ${p.expectBackward}`}/>
              <i className={p.expectForward?'dot pass':'dot fail'} title={`向前 ${p.expectForward}`}/>
            </span>
            <small>{p.description}</small>
          </button>)}
        </div>
      </aside>

      <section className="pane editors">
        <div className="toolbar">
          <label className="policy">
            未知分支策略
            <select value={policy} onChange={e=>setPolicy(e.target.value as 'fail'|'passthrough')}>
              <option value="fail">fail（封闭 union）</option>
              <option value="passthrough">passthrough（开放 union）</option>
            </select>
          </label>
          <button className="primary" onClick={runFromEditors} disabled={busy}>
            <GitCompareArrows size={15}/>{busy?'比较中…':'比较 v1 → v2'}
          </button>
          {result&&<span className="cache">缓存 向后:{result.cache.hits.backward?'命中':'未命中'} 向前:{result.cache.hits.forward?'命中':'未命中'}</span>}
        </div>
        {error&&<pre className="request-error">{error}</pre>}
        {lintIssues.length>0&&<div className="lint"><h4>Schema lint</h4>
          <ul>{lintIssues.map((i,k)=><li key={k}><code>{i.side}</code> <code>{i.code}</code> {i.message}</li>)}</ul>
        </div>}
        <div className="editor-grid">
          <div><h3>v1（旧）</h3><textarea aria-label="v1 schema" spellCheck={false} value={v1Text} onChange={e=>setV1Text(e.target.value)}/></div>
          <div><h3>v2（新）</h3><textarea aria-label="v2 schema" spellCheck={false} value={v2Text} onChange={e=>setV2Text(e.target.value)}/></div>
        </div>
      </section>

      <aside className="pane results">
        <h2>兼容性结论</h2>
        <div className="verdicts">
          <VerdictCard title="向后兼容" subtitle="新生产者 → 旧消费者（旧消费者能否读新数据）" result={backward}/>
          <VerdictCard title="向前兼容" subtitle="旧生产者 → 新消费者（新消费者能否读旧数据）" result={forward}/>
          <article className={`verdict full ${full==='pass'?'pass':full==='fail'?'fail':'idle'} accent`}>
            <header>
              {full==='pass'?<ShieldCheck size={18}/>:<ShieldX size={18}/>}
              <div><h3>完全兼容</h3><small>向后 ∧ 向前（独立计算，不折叠成单一布尔值）</small></div>
              <span className="badge">{full==='pass'?'完全兼容':full==='fail'?'存在破坏':'—'}</span>
            </header>
          </article>
        </div>

        {backward&&!backward.compatible&&<section className="ce-section">
          <h3 className="ce-heading fail-text">向后不兼容的反例</h3>
          {backward.counterexamples.map((ce,i)=><CounterexampleCard key={`b${i}`} ce={ce} index={i}/>)}
        </section>}
        {forward&&!forward.compatible&&<section className="ce-section">
          <h3 className="ce-heading fail-text">向前不兼容的反例</h3>
          {forward.counterexamples.map((ce,i)=><CounterexampleCard key={`f${i}`} ce={ce} index={i}/>)}
        </section>}
        {result&&result.report.fullyCompatible&&<p className="all-good"><ShieldCheck size={15}/> 两个方向均无反例。</p>}
      </aside>
    </section>
  </main>;
}
