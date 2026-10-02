import {useCallback,useEffect,useMemo,useState} from 'react';
import {FlaskConical, GitCompareArrows, ShieldCheck, ShieldX, ShieldAlert, ArrowRight, Users2} from 'lucide-react';
import type {CompareResponse, DirectionResult} from '../shared/api';
import type {Issue} from '../shared/schema';
import {CounterexampleCard} from './counterexample';
import ReleaseView from './ReleaseView';

interface PresetMeta{id:string;label:string;description:string;policy:'fail'|'passthrough';expectBackward:boolean;expectForward:boolean}
interface Preset extends PresetMeta{v1:unknown;v2:unknown}

type Verdict = 'pass'|'fail';
type Mode='pair'|'release';

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

// The original single-pair comparison, unchanged: two editor panes and two
// independent directional verdicts sharing the one counterexample engine.
function PairView(){
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

  return <section className="workspace compat-layout">
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
  </section>;
}

export default function App(){
  const [mode,setMode]=useState<Mode>('pair');
  return <main className="shell">
    <header className="topbar">
      <FlaskConical size={20}/><strong>Schema 演进工作台 · Discriminated Union</strong>
      <nav className="modes">
        <button className={mode==='pair'?'on':''} onClick={()=>setMode('pair')}><GitCompareArrows size={14}/>单对比较</button>
        <button className={mode==='release'?'on':''} onClick={()=>setMode('release')}><Users2 size={14}/>多消费方发布</button>
      </nav>
      <small>{mode==='pair'?'生产者/消费者双向兼容性':'一份待发布定义面对多份同时演进的消费方定义'}</small>
    </header>
    {mode==='pair'?<PairView/>:<ReleaseView/>}
  </main>;
}
