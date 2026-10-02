import {useCallback, useEffect, useMemo, useState} from 'react';
import {
  AlertTriangle, CheckCircle2, ChevronDown, History, RefreshCw, Rocket, SearchCheck,
  ShieldAlert, ShieldCheck, ShieldX,
} from 'lucide-react';
import type {
  ConsumerSummary, PreviewResponse, ReleaseRecord,
} from '../shared/api';
import type {Issue, Schema} from '../shared/schema';
import {CounterexampleCard} from './counterexample';

type Policy = 'fail' | 'passthrough';

// A submission identifies WHICH draft the displayed results belong to. The
// fingerprint comes from the server (FNV over canonical JSON), so switching a
// scenario or editing the draft visibly detaches the shown verdicts.
interface Submission {
  draftKey: string;       // raw client-side text + policy
  fingerprint?: string;   // server fingerprint once a preview exists
  policy: Policy;
}

async function asJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return {}; }
}

function policyOf(p: unknown): Policy { return p === 'passthrough' ? 'passthrough' : 'fail'; }

export default function ReleaseView(){
  const [consumers,setConsumers] = useState<ConsumerSummary[]>([]);
  const [loadTick,setLoadTick] = useState(0);
  const reloadConsumers=useCallback(()=>setLoadTick(t=>t+1),[]);

  const [producerText,setProducerText] = useState('');
  const [policy,setPolicy] = useState<Policy>('fail');
  const [draftError,setDraftError] = useState<string|null>(null);

  const [submission,setSubmission] = useState<Submission|undefined>();
  const [preview,setPreview] = useState<PreviewResponse|null>(null);
  const [busy,setBusy] = useState(false);
  const [confirmState,setConfirmState] = useState<{status:'idle'|'busy'|'done'|'stale'|'blocked'|'error'; message?:string; release?:ReleaseRecord}>({status:'idle'});

  const [releases,setReleases] = useState<Array<{id:string;publishedAt:string;policy:string;producerFingerprint:string}>>([]);
  const [openRelease,setOpenRelease] = useState<ReleaseRecord|null>(null);

  // Load a concrete draft the first time: the add-branch scenario shape
  // (created+archived+merged), authored in this same schema form.
  useEffect(()=>{
    const seed: Schema = {
      kind:'union', discriminator:'type',
      branches:[
        {value:'created',payload:{kind:'object',fields:{id:{schema:{kind:'string'}}}}},
        {value:'archived',payload:{kind:'object'}},
        {value:'merged',payload:{kind:'object',fields:{mergedBy:{schema:{kind:'string'}}}}},
      ],
    };
    setProducerText(JSON.stringify(seed,null,2));
  },[]);

  useEffect(()=>{
    let alive=true;
    const load=()=>{
      fetch('/api/release/consumers').then(r=>r.json()).then(d=>{if(alive)setConsumers(d)}).catch(()=>{});
      fetch('/api/release/releases').then(r=>r.json()).then(d=>{if(alive)setReleases(d)}).catch(()=>{});
    };
    load();
    // Another user may move a consumer revision at any time: poll so a visible
    // preview goes stale on its own, not only after our own mutations.
    const t=setInterval(load,5000);
    return ()=>{alive=false;clearInterval(t)};
  },[loadTick]);

  const draftKey = producerText + '' + policy;
  // Stale = the pinned fleet or draft moved AFTER the preview was rendered.
  const fleetKey = useMemo(
    ()=>consumers.map(c=>`${c.id}@${c.revision}:${c.required?'1':'0'}`).sort().join('|'),
    [consumers]);
  const isStale = !!submission && (submission.draftKey!==draftKey || (!!preview && preview.pinned.map(p=>`${p.id}@${p.revision}:${p.required?'1':'0'}`).sort().join('|')!==fleetKey));
  const isCurrent = !!preview && !!submission && !isStale && submission.fingerprint===preview.fingerprint;

  const runPreview=useCallback(async(text:string,pol:Policy)=>{
    let producer: unknown;
    try{ producer=JSON.parse(text); }
    catch(e){ setDraftError('生产者 JSON 解析失败: '+(e as Error).message); return; }
    setBusy(true);setDraftError(null);setConfirmState({status:'idle'});
    try{
      const res=await fetch('/api/release/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({producer,policy:pol})});
      const data=await asJson(res);
      if(!res.ok){
        setDraftError(data.issues?data.issues.map((i:Issue)=>i.message).join('\n'):(data.error??'preview_failed'));
        setPreview(null);setSubmission(undefined);
      }else{
        setPreview(data as PreviewResponse);
        setSubmission({draftKey:text+''+pol,fingerprint:(data as PreviewResponse).fingerprint,policy:pol});
      }
    }finally{setBusy(false)}
  },[]);

  const confirm=async()=>{
    if(!preview||!isCurrent)return;
    setConfirmState({status:'busy'});
    const res=await fetch('/api/release/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({previewToken:preview.previewToken})});
    const data=await asJson(res);
    if(res.status===201){
      setConfirmState({status:'done',release:data.release});
      setReleases(prev=>[{id:data.release.id,publishedAt:data.release.publishedAt,policy:data.release.policy,producerFingerprint:data.release.producerFingerprint},...prev]);
      // Fleet did not move; keep preview but mark this exact token consumed.
      return;
    }
    if(res.status===409&&data.error==='preview_stale'){
      // The authoritative answer: adopt the server's recomputed preview and
      // force the user to re-review before approving.
      if(data.currentPreview)setPreview(data.currentPreview);
      setSubmission(undefined);
      const who=(data.divergence??[]).map((d:{id:string;pinnedRevision:number|null;currentRevision:number|null})=>
        d.currentRevision===null?`${d.id} 已被删除`:`${d.id} 修订 ${d.pinnedRevision}→${d.currentRevision}`).join('；');
      setConfirmState({status:'stale',message:who||'编组或草稿已变化'});
      reloadConsumers();
      return;
    }
    if(res.status===422&&data.error==='gate_blocked'){
      setPreview(data.preview);
      setConfirmState({status:'blocked',message:'服务端重新计算后准入未通过——浏览器结论不作数'});
      return;
    }
    if(res.status===409&&data.error==='release_exists'){
      setConfirmState({status:'done',message:'该定义此前已发布，返回既有记录',release:data.release});
      return;
    }
    setConfirmState({status:'error',message:data.error??'confirm_failed'});
  };

  const openRecord=async(id:string)=>{
    const res=await fetch('/api/release/releases/'+id);
    if(res.ok)setOpenRelease(await res.json());
  };

  return <section className="workspace release-layout">
    {/* ---- Left: named consumer fleet ---- */}
    <aside className="pane fleet">
      <div className="pane-head">
        <h2>消费方编组</h2>
        <button className="iconbtn" title="重新拉取（他人可能已修改）" onClick={reloadConsumers}><RefreshCw size={14}/></button>
      </div>
      <p className="hint">每个消费方按各自部署节奏维护服务端 schema 与修订号；<b>必需</b>标记决定本次发布的准入集合，非必需消费方只计风险。</p>
      <div className="fleet-list">
        {consumers.map(c=><ConsumerCard key={c.id} summary={c} onChanged={reloadConsumers}/>)}
      </div>
    </aside>

    {/* ---- Middle: producer draft ---- */}
    <section className="pane draft">
      <div className="pane-head"><h2>待发布生产者定义</h2></div>
      <div className="toolbar">
        <label className="policy">未知分支策略
          <select value={policy} onChange={e=>setPolicy(policyOf(e.target.value))}>
            <option value="fail">fail（封闭 union）</option>
            <option value="passthrough">passthrough（开放 union）</option>
          </select>
        </label>
        <button className="primary" onClick={()=>runPreview(producerText,policy)} disabled={busy}>
          <SearchCheck size={15}/>{busy?'预览计算中…':'提交预览'}
        </button>
        {submission&&preview&&<span className={`corr ${isStale?'stale':'fresh'}`}>
          结果指纹 <code>{preview.fingerprint}</code> · {isStale?'已与草稿/编组脱节':'对应当前提交'}
        </span>}
      </div>
      {draftError&&<pre className="request-error">{draftError}</pre>}
      {isStale&&<div className="stale-banner"><AlertTriangle size={15}/>
        下方结论属于上一次提交（{submission?.fingerprint??'—'}）。草稿或某消费方定义此后已变化，重新预览后才能确认发布。
      </div>}
      <textarea aria-label="producer schema" spellCheck={false} value={producerText} onChange={e=>setProducerText(e.target.value)}/>
      {preview&&<div className="lint">
        <h4>生产者 lint</h4>
        {preview.producerLint.length===0
          ? <span className="muted">无问题</span>
          : <ul>{preview.producerLint.map((i,k)=><li key={k}><code>{i.code}</code> {i.message}</li>)}</ul>}
      </div>}
    </section>

    {/* ---- Right: per-consumer verdicts + release ---- */}
    <aside className="pane release-results">
      <div className="pane-head"><h2>各消费方判定与发布</h2></div>
      {!preview
        ? <p className="muted">提交预览后，这里按消费方分别给出「新生产者→该消费方」与「该消费方→新定义」两个方向的判定，不折叠成单一红绿灯。</p>
        : <GatePanel preview={preview} isCurrent={!!isCurrent} stale={isStale} confirmState={confirmState} onConfirm={confirm}/>}

      {preview&&<div className="consumer-verdicts">
        {preview.consumers.map(v=><ConsumerVerdictCard key={v.consumerId} verdict={v}/>)}
      </div>}

      <section className="releases">
        <h3><History size={14}/> 发布记录（服务端确认）</h3>
        {releases.length===0
          ? <p className="muted">尚无发布。重新打开页面也能在这里复查每次决定所固定的消费方修订与生产者定义。</p>
          : <ul className="release-list">
            {releases.map(r=><li key={r.id}>
              <button onClick={()=>openRecord(r.id)}>
                <code className="relfp">{r.producerFingerprint}</code>
                <span className="dim">{new Date(r.publishedAt).toLocaleString()}</span>
                <span className="policytag">{r.policy}</span>
              </button>
            </li>)}
          </ul>}
      </section>
    </aside>

    {openRelease&&<ReleaseDialog record={openRelease} onClose={()=>setOpenRelease(null)}/>}
  </section>;
}

function GatePanel({preview,isCurrent,stale,confirmState,onConfirm}:{
  preview:PreviewResponse;isCurrent:boolean;stale:boolean;
  confirmState:{status:string;message?:string;release?:ReleaseRecord};onConfirm:()=>void;
}){
  const blocked=preview.gate.requiredBlocked.length;
  const cls=blocked?'fail':'pass';
  const Icon=blocked?ShieldX:ShieldCheck;
  return <div className={`gate ${cls} ${stale?'gatedim':''}`}>
    <header><Icon size={18}/>
      <div><h3>{blocked?`准入被 ${blocked} 个必需消费方阻止`:'所有必需消费方均可读取新生产者数据'}</h3>
        <small>{preview.gate.rule}</small></div>
      <span className="badge">必需 {preview.gate.requiredChecked} · 阻止 {blocked}</span>
    </header>
    <div className="gate-actions">
      <button className="confirm" onClick={onConfirm} disabled={!isCurrent||blocked>0||confirmState.status==='busy'||confirmState.status==='done'}>
        <Rocket size={15}/>{confirmState.status==='busy'?'服务端确认中…':confirmState.status==='done'?'已发布':'确认发布'}
      </button>
      {!isCurrent&&<span className="warnline"><AlertTriangle size={13}/> 预览非当前提交，无法确认</span>}
    </div>
    {confirmState.status==='stale'&&<div className="confirm-note stale"><AlertTriangle size={13}/> 确认被拒（409 预览已过期）：{confirmState.message}。服务端已给出当前状态，请重新预览。</div>}
    {confirmState.status==='blocked'&&<div className="confirm-note blocked"><ShieldX size={13}/> {confirmState.message}</div>}
    {confirmState.status==='error'&&<div className="confirm-note blocked"><ShieldAlert size={13}/> {confirmState.message}</div>}
    {confirmState.status==='done'&&<div className="confirm-note ok"><CheckCircle2 size={13}/> 已发布 {confirmState.message?`（${confirmState.message}）`:''}
      <code> {confirmState.release?.id.slice(0,8)}</code> · 指纹 <code>{confirmState.release?.producerFingerprint}</code></div>}
  </div>;
}

function DirectionLine({label,compatible,note}:{label:string;compatible:boolean|undefined;note:string}){
  const Icon=compatible===undefined?ShieldAlert:compatible?ShieldCheck:ShieldX;
  return <div className={`dirline ${compatible===undefined?'idle':compatible?'pass':'fail'}`}>
    <Icon size={13}/><span className="dirlabel">{label}</span>
    <span className="dim">{note}</span>
    <i className={`minidot ${compatible?'pass':'fail'}`}/>
  </div>;
}

function ConsumerVerdictCard({verdict:v}:{verdict:PreviewResponse['consumers'][number]}){
  const [open,setOpen]=useState(false);
  const backFail=!v.backward.compatible;
  const fwdFail=!v.forward.compatible;
  return <article className={`cverdict ${v.required?'req':'opt'} ${backFail&&v.required?'blocks':''}`}>
    <button className="cverdict-head" onClick={()=>setOpen(o=>!o)}>
      <span className={`reqmark ${v.required?'required':''}`} title={v.required?'必需：计入准入':'非必需：只显示风险'}>{v.required?'必需':'观察'}</span>
      <span className="cname">{v.name}</span>
      <span className="dim">rev {v.revision}</span>
      <span className="cverdict-dots">
        <i className={`minidot ${v.backward.compatible?'pass':'fail'}`} title="向后：新生产者→该消费方"/>
        <i className={`minidot ${v.forward.compatible?'pass':'fail'}`} title="向前：该消费方→新定义（风险）"/>
      </span>
      <ChevronDown size={14} className={`chev ${open?'up':''}`}/>
    </button>
    {open&&<div className="cverdict-body">
      <DirectionLine label="向后（准入方向）" compatible={v.backward.compatible}
        note={v.backward.compatible?'该消费方接受新生产者的任意实例':'该消费方拒绝某些新生产者实例'}/>
      <DirectionLine label="向前（风险方向）" compatible={v.forward.compatible}
        note={v.forward.compatible?'旧生产者实例对新定义仍合法':'旧生产者可能发出新定义不接受的数据'}/>
      {v.required
        ? <p className="rule-note gate">{backFail?'计入准入：阻止本次发布。':'计入准入：通过。'}</p>
        : <p className="rule-note risk">非必需：{backFail?'即使拒绝也不改变准入规则，仅作为风险展示。':'向后可读取。'} 准入只由必需消费方决定。</p>}

      {backFail&&<div className="ce-mini">
        <h5 className="fail-text">向后拒绝原因（{v.backward.counterexamples.length} 个已证实反例）</h5>
        {v.backward.counterexamples.map((ce,i)=><CounterexampleCard key={`b${i}`} ce={ce} index={i}/>)}
      </div>}
      {fwdFail&&!backFail&&<div className="ce-mini">
        <h5 className="warn-text">向前风险反例（{v.forward.counterexamples.length} 个）</h5>
        {v.forward.counterexamples.slice(0,3).map((ce,i)=><CounterexampleCard key={`f${i}`} ce={ce} index={i}/>)}
      </div>}
    </div>}
  </article>;
}

function ConsumerCard({summary,onChanged}:{summary:ConsumerSummary;onChanged:()=>void}){
  const [editing,setEditing]=useState(false);
  const [detail,setDetail]=useState<{schema:Schema}|null>(null);
  const [name,setName]=useState(summary.name);
  const [required,setRequired]=useState(summary.required);
  const [text,setText]=useState('');
  const [rev,setRev]=useState(summary.revision);
  const [err,setErr]=useState<string|null>(null);
  const [saving,setSaving]=useState(false);

  useEffect(()=>{setName(summary.name);setRequired(summary.required);setRev(summary.revision)},[summary.revision,summary.name,summary.required]);

  const startEdit=async()=>{
    setErr(null);
    const res=await fetch('/api/release/consumers/'+summary.id);
    const data=await asJson(res);
    setDetail(data.consumer??null);
    setText(JSON.stringify(data.consumer.schema,null,2));
    setEditing(true);
  };

  const save=async(patch:Record<string,unknown>)=>{
    setSaving(true);setErr(null);
    try{
      const res=await fetch('/api/release/consumers/'+summary.id,{
        method:'PUT',headers:{'content-type':'application/json'},
        body:JSON.stringify({revision:rev,...patch}),
      });
      const data=await asJson(res);
      if(res.status===409){setErr(`修订冲突：服务端已在 rev ${data.current?.revision}（他人先改）。请关闭后重新拉取。`);onChanged();return;}
      if(!res.ok){setErr(data.issues?data.issues.map((i:Issue)=>i.message).join('\n'):(data.error??'save_failed'));return;}
      setRev(data.consumer.revision);
      onChanged();
    }finally{setSaving(false)}
  };

  return <article className={`consumer ${required?'required':''}`}>
    <div className="consumer-head">
      <label className="switch" title={required?'必需（计入准入）':'非必需（仅风险）'}>
        <input type="checkbox" checked={required} onChange={async e=>{setRequired(e.target.checked);await save({required:e.target.checked})}}/>
        <span>{required?'必需':'观察'}</span>
      </label>
      <strong>{summary.name}</strong>
      <span className="revtag">rev {summary.revision}</span>
    </div>
    <small className="dim">更新于 {new Date(summary.updatedAt).toLocaleTimeString()}</small>
    {!editing
      ? <button className="linkbtn" onClick={startEdit}>编辑 schema / 名称</button>
      : <div className="consumer-edit">
          <input className="name-input" value={name} onChange={e=>setName(e.target.value)}/>
          <textarea spellCheck={false} value={text} onChange={e=>setText(e.target.value)}/>
          {err&&<pre className="request-error">{err}</pre>}
          <div className="row-actions">
            <button disabled={saving} onClick={async()=>{
              let schema:unknown;
              try{schema=JSON.parse(text);}catch(e){setErr('JSON 解析失败: '+(e as Error).message);return;}
              await save({name,schema});
            }}>保存（乐观锁 rev {rev}）</button>
            <button onClick={()=>setEditing(false)}>关闭</button>
          </div>
          {detail&&<small className="dim">保存即产生新修订；其他浏览器中基于旧修订的预览将立即无法确认。</small>}
        </div>}
  </article>;
}

function ReleaseDialog({record,onClose}:{record:ReleaseRecord;onClose:()=>void}){
  return <div className="modal-backdrop" onClick={onClose}>
    <div className="modal" onClick={e=>e.stopPropagation()}>
      <header><h3>发布记录</h3>
        <button className="iconbtn" onClick={onClose}>✕</button></header>
      <div className="modal-meta">
        <div>记录 ID <code>{record.id}</code></div>
        <div>发布时间 {new Date(record.publishedAt).toLocaleString()}</div>
        <div>策略 <code>{record.policy}</code> · 生产者指纹 <code>{record.producerFingerprint}</code></div>
        <p className="dim">{record.gateRule}</p>
      </div>
      <h4>固定的生产者定义</h4>
      <pre className="instance">{JSON.stringify(record.producer,null,2)}</pre>
      <h4>当时的消费方修订（{record.consumers.length}）</h4>
      <div className="rel-consumers">
        {record.consumers.map(c=><details key={c.consumerId} className="rel-consumer">
          <summary>
            <span className={`reqmark ${c.required?'required':''}`}>{c.required?'必需':'观察'}</span>
            <strong>{c.name}</strong>
            <span className="dim">rev {c.revision}</span>
            <i className={`minidot ${c.backward.compatible?'pass':'fail'}`}/>
            <i className={`minidot ${c.forward.compatible?'pass':'fail'}`}/>
          </summary>
          <div className="rel-schema">
            <h5>该消费方接受的 schema</h5>
            <pre className="instance">{JSON.stringify(c.schema,null,2)}</pre>
            {!c.backward.compatible&&<ul className="issues">
              {c.backward.counterexamples.slice(0,3).map((ce,i)=><li key={i}>{ce.reason}</li>)}
            </ul>}
          </div>
        </details>)}
      </div>
    </div>
  </div>;
}
