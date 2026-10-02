import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {
  Users, Play, History, Plus, Save, Trash2, RefreshCw, AlertTriangle,
  ShieldCheck, ShieldX, ShieldAlert, GitCompareArrows, Lock, FileSearch, BadgeCheck,
} from 'lucide-react';
import type {
  ConsumerDetail, ConsumerSummary, ConsumerVerdict, Preview, ReleaseRecord, StalePreviewBody,
} from '../shared/release';
import type {Issue} from '../shared/schema';
import {CounterexampleCard, VerdictCard} from './compare-ui';

// Multi-consumer release workbench.
//
// Every verdict on screen is SERVER-COMPUTED and stamped with the consumer
// revision + producer hash it was evaluated against:
//   preview   -> server pins consumer revisions + producer hash, returns token
//   confirm   -> server re-validates freshness and the gate, then persists a
//                record; the browser never authorizes the release itself
//   history   -> the persisted record carries the exact definitions used
//
// Local edits and roster moves observed by polling both INVALIDATE the shown
// preview (it can no longer be confirmed), so an old green result is never
// presented as valid for the current definitions.

type GateState =
  | {kind:'none'}
  | {kind:'preview'; preview: Preview; localStale: boolean; rosterStale: boolean; conflictNote: string | null}
  | {kind:'blocked'; preview: Preview};

interface PresetOption{id:string;label:string}

async function readJson(res:Response):Promise<any>{
  const text=await res.text();
  try{return text?JSON.parse(text):null}catch{return null}
}

function short(hash:string):string{return hash.slice(0,10)}
function time(iso:string):string{return new Date(iso).toLocaleString('zh-CN',{hour12:false})}

function statusMeta(v:ConsumerVerdict){
  if(v.status==='pass')return {cls:'pass' as const,Icon:ShieldCheck,text:v.required?'兼容 · 必需':'兼容 · 非必需'};
  if(v.status==='required_blocking')return {cls:'fail' as const,Icon:ShieldX,text:'拒绝 · 必需（阻断发布）'};
  return {cls:'warn' as const,Icon:ShieldAlert,text:'拒绝 · 非必需（风险，不阻断）'};
}

export default function ReleaseView(){
  const [roster,setRoster]=useState<ConsumerSummary[]>([]);
  const [presets,setPresets]=useState<PresetOption[]>([]);
  const [releases,setReleases]=useState<ReleaseRecord[]>([]);
  const [openRelease,setOpenRelease]=useState<ReleaseRecord|null>(null);

  const [editingId,setEditingId]=useState<string|null>(null);
  const [isNew,setIsNew]=useState(false);
  const [editName,setEditName]=useState('');
  const [editRequired,setEditRequired]=useState(false);
  const [editPolicy,setEditPolicy]=useState<'fail'|'passthrough'>('fail');
  const [editSchema,setEditSchema]=useState('');
  const [editRevision,setEditRevision]=useState<number|null>(null);
  const [editUpdatedAt,setEditUpdatedAt]=useState<string|null>(null);
  const [editLint,setEditLint]=useState<Issue[]>([]);

  const [producerText,setProducerText]=useState('');
  const [producerPolicy,setProducerPolicy]=useState<'fail'|'passthrough'>('fail');
  const [basis,setBasis]=useState<{text:string;policy:'fail'|'passthrough'}|null>(null);

  const [gate,setGate]=useState<GateState>({kind:'none'});
  const [busy,setBusy]=useState(false);
  const [publishing,setPublishing]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);

  // Roster poll detects other users' moves; the preview banner compares the
  // pinned revisions against this list to label an old preview.
  const initialized=useRef(false);

  const refreshRoster=useCallback(async()=>{
    const res=await fetch('/api/release/consumers');
    if(!res.ok)return;
    const data=await res.json() as ConsumerSummary[];
    setRoster(data);
  },[]);

  const refreshReleases=useCallback(async()=>{
    const res=await fetch('/api/release/releases');
    if(res.ok)setReleases(await res.json());
  },[]);

  useEffect(()=>{
    refreshRoster();refreshReleases();
    fetch('/api/compat/presets').then(r=>r.json()).then(setPresets);
    const t=setInterval(refreshRoster,4000);
    return ()=>clearInterval(t);
  },[refreshRoster,refreshReleases]);

  // Open on the real rollout story: the add-branch producer (created + archived
  // + merged) against 甲/乙/丙, previewed once so the sourced verdicts show.
  useEffect(()=>{
    if(initialized.current)return;
    initialized.current=true;
    (async()=>{
      const p=await (await fetch('/api/compat/presets/add-branch')).json();
      const text=JSON.stringify(p.v2,null,2);
      setProducerText(text);setProducerPolicy(p.policy);
      const res=await fetch('/api/release/preview',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({producer:p.v2,policy:p.policy}),
      });
      if(res.ok){
        const preview=await res.json() as Preview;
        setBasis({text,policy:p.policy});
        setGate({kind:'preview',preview,localStale:false,rosterStale:false,conflictNote:null});
      }
    })();
  },[]);

  const loadConsumer=useCallback(async(id:string)=>{
    setError(null);
    const res=await fetch('/api/release/consumers/'+id);
    if(!res.ok){setError('消费方不存在或已被删除');return}
    const d=await res.json() as ConsumerDetail;
    setEditingId(d.id);setIsNew(false);
    setEditName(d.name);setEditRequired(d.required);
    setEditPolicy(d.policy);setEditSchema(JSON.stringify(d.schema,null,2));
    setEditRevision(d.revision);setEditUpdatedAt(d.updatedAt);setEditLint(d.lint);
  },[]);

  const startNewConsumer=()=>{
    setEditingId(null);setIsNew(true);
    setEditName('');setEditRequired(false);setEditPolicy('fail');
    setEditSchema(JSON.stringify({kind:'union',discriminator:'type',branches:[]},null,2));
    setEditRevision(null);setEditUpdatedAt(null);setEditLint([]);
    setError(null);
  };

  const saveConsumer=async()=>{
    let schema:unknown;
    try{schema=JSON.parse(editSchema)}catch(e){setError('消费方 schema JSON 解析失败: '+(e as Error).message);return}
    setBusy(true);setError(null);setNotice(null);
    try{
      const url=isNew?'/api/release/consumers':`/api/release/consumers/${editingId}`;
      const res=await fetch(url,{
        method:isNew?'POST':'PUT',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({name:editName,required:editRequired,schema,policy:editPolicy,...(isNew?{}:{expectedRevision:editRevision})}),
      });
      const data=await readJson(res);
      if(res.status===409){
        setError(`该消费方已被其他人更新到 revision ${data?.current?.revision}，已为你重新载入最新定义。`);
        if(data?.current?.id)await loadConsumer(data.current.id);
        return;
      }
      if(!res.ok){setError(data?.issues?data.issues.map((i:Issue)=>i.message).join('\n'):(data?.error??'保存失败'));return}
      const saved=data as ConsumerDetail;
      await refreshRoster();
      setIsNew(false);setEditingId(saved.id);
      setEditRevision(saved.revision);setEditUpdatedAt(saved.updatedAt);setEditLint(saved.lint);
      setEditSchema(JSON.stringify(saved.schema,null,2));
      setNotice(`已保存 ${saved.name} → revision ${saved.revision}`);
    }finally{setBusy(false)}
  };

  const deleteConsumer=async()=>{
    if(!editingId||editRevision===null)return;
    if(!window.confirm(`删除消费方 ${editName}？`))return;
    setBusy(true);setError(null);
    try{
      const res=await fetch(`/api/release/consumers/${editingId}?revision=${editRevision}`,{method:'DELETE'});
      const data=await readJson(res);
      if(res.status===409){setError('该消费方已被其他人更新，请刷新后重试。');await refreshRoster();return}
      if(!res.ok){setError(data?.error??'删除失败');return}
      setEditingId(null);setIsNew(false);setEditRevision(null);
      await refreshRoster();
      setNotice('消费方已删除');
    }finally{setBusy(false)}
  };

  const loadPresetDraft=async(id:string)=>{
    if(!id)return;
    const p=await (await fetch('/api/compat/presets/'+id)).json();
    setProducerText(JSON.stringify(p.v2,null,2));
    setProducerPolicy(p.policy);
    setError(null);
  };

  const runPreview=useCallback(async()=>{
    let producer:unknown;
    try{producer=JSON.parse(producerText)}catch(e){setError('生产者草稿 JSON 解析失败: '+(e as Error).message);return}
    setBusy(true);setError(null);setNotice(null);
    try{
      const res=await fetch('/api/release/preview',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({producer,policy:producerPolicy}),
      });
      const data=await readJson(res);
      if(!res.ok){setError(data?.issues?data.issues.map((i:Issue)=>i.message).join('\n'):(data?.error??'预览失败'));setGate({kind:'none'});return}
      const preview=data as Preview;
      setBasis({text:producerText,policy:producerPolicy});
      setGate({kind:'preview',preview,localStale:false,rosterStale:false,conflictNote:null});
      setNotice(`预览 ${short(preview.token)} 已绑定 ${preview.pins.length} 个消费方修订与生产者哈希 ${short(preview.producerHash)}`);
    }finally{setBusy(false)}
  },[producerText,producerPolicy]);

  const confirmRelease=async()=>{
    if(gate.kind!=='preview')return;
    const token=gate.preview.token;
    setPublishing(true);setError(null);
    try{
      const res=await fetch('/api/release/releases',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({token}),
      });
      const data=await readJson(res);
      if(res.status===409){
        // The server refused an outdated preview: another user moved a pinned
        // consumer (or the token was already consumed). The response carries a
        // FRESH preview; show it but do not let it be confirmed until the user
        // explicitly re-previews against the new roster.
        const body=data as StalePreviewBody;
        const changed=(body.changed??[]).map(c=>`${c.consumerId} r${c.fromRevision}→r${c.toRevision===0?'已删除':c.toRevision}`).join('、')||'预览已被使用或失效';
        setBasis(null);
        setGate({kind:'preview',preview:body.fresh,localStale:true,rosterStale:true,conflictNote:`确认被服务端拒绝：${changed}。下方是按最新定义重算的结果，需要重新预览后才能发布。`});
        await refreshRoster();
        return;
      }
      if(res.status===422){
        setGate({kind:'blocked',preview:data.preview});
        setError('服务端复核未通过：仍有必需消费方拒绝，不能发布。');
        return;
      }
      if(!res.ok){setError(data?.error??'发布失败');return}
      // Only here — after the server persisted and returned the record — does
      // the UI say "released".
      const record=data as ReleaseRecord;
      setGate({kind:'none'});setBasis(null);
      setOpenRelease(record);
      await refreshReleases();
      setNotice(`已发布 ${record.id}：服务端确认于 ${time(record.releasedAt)}`);
    }finally{setPublishing(false)}
  };

  // Local edits to the draft invalidate a preview immediately.
  useEffect(()=>{
    setGate(g=>{
      if(g.kind!=='preview'||!basis)return g;
      const localStale=basis.text!==producerText||basis.policy!==producerPolicy;
      if(localStale===g.localStale)return g;
      return {...g,localStale};
    });
  },[producerText,producerPolicy,basis]);

  // Roster moves (polled) invalidate a preview whose pins no longer match.
  const rosterStale=useMemo(()=>{
    if(gate.kind!=='preview')return false;
    return gate.preview.pins.some(pin=>{
      const cur=roster.find(r=>r.id===pin.consumerId);
      return !cur||cur.revision!==pin.revision;
    });
  },[gate,roster]);

  const preview=gate.kind==='none'?null:gate.preview;
  const localStale=gate.kind==='preview'?gate.localStale:false;
  const conflictNote=gate.kind==='preview'?gate.conflictNote:null;
  const canConfirm=gate.kind==='preview'&&!localStale&&!rosterStale&&!conflictNote&&preview!.gate.admissible&&!publishing;
  const verdictById=new Map(preview?.verdicts.map(v=>[v.consumerId,v])??[]);

  return <section className="workspace release-layout">
    {/* Left: named consumer roster */}
    <aside className="pane scenarios">
      <h2><Users size={15}/> 消费方名册</h2>
      <div className="list">
        {roster.map(c=>{
          const v=verdictById.get(c.id);
          return <button key={c.id} className={`consumer-row ${editingId===c.id?'active':''} ${v?`v-${v.status}`:''}`} onClick={()=>loadConsumer(c.id)}>
            <span className="scn-label">{c.name}</span>
            <span className="scn-dots">
              <i className={`req ${c.required?'req-yes':'req-no'}`} title={c.required?'必需':'非必需'}>{c.required?'必需':'选需'}</i>
              <i className="revtag">r{c.revision}</i>
              {v&&<i className={`dot ${v.status==='pass'?'pass':v.status==='required_blocking'?'fail':'warn'}`} title={v.status}/>}
            </span>
            <small title={c.schemaHash}>哈希 {short(c.schemaHash)} · {time(c.updatedAt)}</small>
          </button>;
        })}
      </div>
      <button className="new-consumer" onClick={startNewConsumer}><Plus size={14}/> 新增消费方</button>

      <h2 className="release-history-heading"><History size={15}/> 发布记录</h2>
      <div className="list releases-list">
        {releases.length===0&&<small className="muted">尚无发布记录。</small>}
        {releases.map(r=><button key={r.id} className={`release-row ${openRelease?.id===r.id?'active':''}`} onClick={()=>setOpenRelease(r)}>
          <BadgeCheck size={14} className="released-ic"/>
          <span className="scn-label">{r.id}</span>
          <small>{time(r.releasedAt)} · {r.consumers.length} 个消费方 · {short(r.producerHash)}</small>
        </button>)}
      </div>
    </aside>

    {/* Middle: producer draft + consumer definition editor */}
    <section className="pane editors">
      <div className="toolbar">
        <label className="policy">生产者未知分支策略
          <select value={producerPolicy} onChange={e=>setProducerPolicy(e.target.value as 'fail'|'passthrough')}>
            <option value="fail">fail（封闭 union）</option>
            <option value="passthrough">passthrough（开放 union）</option>
          </select>
        </label>
        <label className="policy">从场景载入草稿
          <select value="" onChange={e=>loadPresetDraft(e.target.value)}>
            <option value="">选择单对场景的 v2…</option>
            {presets.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <button className="primary" onClick={runPreview} disabled={busy||!producerText.trim()}>
          <Play size={15}/>{busy?'计算中…':'生成发布预览'}
        </button>
      </div>

      {error&&<pre className="request-error">{error}</pre>}
      {notice&&<div className="notice"><FileSearch size={14}/>{notice}</div>}

      {preview&&(
        <div className={`preview-banner ${preview.gate.admissible&&!localStale&&!rosterStale&&!conflictNote?'ok':preview.gate.admissible?'stale':'bad'}`}>
          <div className="pb-row">
            <GitCompareArrows size={15}/>
            <strong>预览 {short(preview.token)}</strong>
            <span className="dim">生成于 {time(preview.createdAt)}</span>
            <span className="dim">生产者哈希 <code>{short(preview.producerHash)}</code></span>
            <span className="dim">策略 {preview.policy}</span>
          </div>
          <div className="pb-pins">
            {preview.pins.map(pin=>{
              const cur=roster.find(r=>r.id===pin.consumerId);
              const moved=!cur||cur.revision!==pin.revision;
              return <span key={pin.consumerId} className={`pin ${moved?'pin-moved':''}`}>
                {pin.consumerId} r{pin.revision}{pin.required?' · 必需':' · 非必需'}
                {moved&&` → 现为 r${cur?cur.revision:'删除'}`}
              </span>;
            })}
          </div>
          {(localStale||rosterStale||conflictNote)&&<div className="pb-invalid">
            <AlertTriangle size={14}/>
            {conflictNote??(localStale&&rosterStale
              ? '草稿与名册均已变化：此结论不再对应当前定义，必须重新预览。'
              : localStale
                ? '生产者草稿已在本地修改：此结论属于上一次提交，请重新预览。'
                : '有消费方定义在服务端发生变化：此结论已过期，请重新预览。')}
          </div>}
          <div className="pb-gate">
            {preview.gate.admissible
              ? <span className="gate-ok"><ShieldCheck size={14}/> 准入：{preview.requiredConsumerIds.length} 个必需消费方全部可读取新数据</span>
              : <span className="gate-bad"><ShieldX size={14}/> 准入被阻断：{preview.gate.blocking.map(b=>b.consumerId).join('、')}</span>}
            {preview.gate.risks.length>0&&<span className="gate-risk"><ShieldAlert size={14}/> 非必需风险：{preview.gate.risks.map(b=>b.consumerId).join('、')}（不改变准入规则）</span>}
          </div>
          {preview.lint.length>0&&<ul className="pb-lint">{preview.lint.map((i,k)=><li key={k}><code>{i.code}</code> {i.message}</li>)}</ul>}
          <div className="pb-actions">
            <button className="confirm-btn" disabled={!canConfirm} onClick={confirmRelease}>
              <Lock size={14}/>{publishing?'服务端确认中…':preview.gate.admissible?'凭此预览向服务端确认发布':'必需消费方未通过，无法发布'}
            </button>
            {(localStale||rosterStale||conflictNote)&&<button className="repreview" onClick={runPreview} disabled={busy}><RefreshCw size={14}/> 重新预览</button>}
          </div>
        </div>
      )}

      <h3 className="editor-heading">待发布的生产者定义（草稿）</h3>
      <textarea aria-label="producer schema" spellCheck={false} className="producer-editor" value={producerText}
        onChange={e=>setProducerText(e.target.value)} placeholder='{ "kind": "union", ... }'/>

      <div className="consumer-editor">
        <h3 className="editor-heading">{isNew?'新增消费方定义':editingId?`编辑消费方 · ${editName}`:'消费方定义'}</h3>
        {(editingId||isNew)?<>
          <div className="ce-form">
            <label>名称<input value={editName} onChange={e=>setEditName(e.target.value)} placeholder="例如：消费方丁"/></label>
            <label className="req-check"><input type="checkbox" checked={editRequired} onChange={e=>setEditRequired(e.target.checked)}/> 本次发布必须满足（必需）</label>
            <label className="policy">隐式未知分支
              <select value={editPolicy} onChange={e=>setEditPolicy(e.target.value as 'fail'|'passthrough')}>
                <option value="fail">fail</option>
                <option value="passthrough">passthrough</option>
              </select>
            </label>
          </div>
          {editRevision!==null&&<div className="rev-meta">
            {editingId} · revision {editRevision} · {editUpdatedAt&&time(editUpdatedAt)}
          </div>}
          <textarea aria-label="consumer schema" spellCheck={false} value={editSchema} onChange={e=>setEditSchema(e.target.value)}/>
          {editLint.length>0&&<ul className="pb-lint">{editLint.map((i,k)=><li key={k}><code>{i.code}</code> {i.message}</li>)}</ul>}
          <div className="ce-actions">
            <button onClick={saveConsumer} disabled={busy}><Save size={14}/>{isNew?'创建消费方':'保存为新修订'}</button>
            {!isNew&&<button className="danger" onClick={deleteConsumer} disabled={busy}><Trash2 size={14}/> 删除</button>}
          </div>
        </>:<p className="muted">从左侧选择一个消费方，或新建一个。保存会产生新的服务端修订号，并立即使任何引用旧修订的预览失效。</p>}
      </div>
    </section>

    {/* Right: per-consumer directional verdicts + release records */}
    <aside className="pane results">
      {openRelease?<ReleaseRecordView record={openRelease} onClose={()=>setOpenRelease(null)}/>:<>
        <h2>逐消费方方向判定</h2>
        {!preview&&<p className="muted">生成预览后，这里显示每个消费方各自的「生产者草稿 → 该消费方修订」判定与拒绝原因，不会折叠成一个没有来源的红绿灯。</p>}
        {preview&&<div className="consumer-verdicts">
          {preview.verdicts.map(v=>{
            const {cls,Icon,text}=statusMeta(v);
            return <article key={v.consumerId} className={`verdict consumer-verdict ${cls}`}>
              <header>
                <Icon size={17}/>
                <div><h3>{v.consumerName}</h3>
                  <small>{v.consumerId} · revision {v.consumerRevision} · 哈希 {short(v.consumerSchemaHash)}{v.required?' · 必需':' · 非必需'}</small>
                </div>
                <span className="badge">{text}</span>
              </header>
              {!v.result.compatible&&<ul className="reject-reasons">
                {v.rejectionReasons.map((r,i)=><li key={i}>{r}</li>)}
              </ul>}
              <details className="ce-toggle">
                <summary>展开验证器证实的反例（{v.result.counterexamples.length}）与方向详情</summary>
                <VerdictCard title="生产者草稿 → 消费方" subtitle="新数据给该消费方读取（与单对比较的向后方向同一引擎）"
                  result={v.result} producerLabel="生产者草稿" consumerLabel={v.consumerName}
                  policyLabel={`未知值: 生产者=${v.result.unknownPolicy.v2.topLevel} · 消费方=${v.result.unknownPolicy.v1.topLevel}`}/>
                {v.result.counterexamples.map((ce,i)=><CounterexampleCard key={i} ce={ce} index={i}
                  labels={{producer:'生产者草稿',consumer:v.consumerName}}/>)}
              </details>
            </article>;
          })}
        </div>}
      </>}
    </aside>
  </section>;
}

function ReleaseRecordView({record,onClose}:{record:ReleaseRecord;onClose:()=>void}){
  const [open,setOpen]=useState(false);
  return <div className="release-detail">
    <button className="back-btn" onClick={onClose}>← 返回当前预览</button>
    <h2><BadgeCheck size={16}/> 发布记录 {record.id}</h2>
    <p className="dim">服务端确认于 {time(record.releasedAt)} · 预览令牌 {short(record.previewToken)} · 策略 {record.policy}</p>
    <p className="dim">生产者哈希 <code>{record.producerHash}</code> · 必需消费方 {record.requiredConsumerIds.join('、')||'（无）'}</p>
    <div className={record.gate.admissible?'gate-line ok':'gate-line bad'}>
      {record.gate.admissible?'服务端复核：全部必需消费方通过':'服务端复核：阻断'}
      {record.gate.risks.length>0&&` · ${record.gate.risks.length} 个非必需消费方存在风险（未参与准入）`}
    </div>
    <table className="record-table">
      <thead><tr><th>消费方</th><th>修订</th><th>必需</th><th>结论</th><th>拒绝原因</th></tr></thead>
      <tbody>
        {record.consumers.map(c=><tr key={c.consumerId} className={c.compatible?'ok':c.required?'bad':'warn'}>
          <td>{c.consumerName}<br/><small className="dim">{c.consumerId} · {short(c.schemaHash)}</small></td>
          <td>r{c.revision}</td>
          <td>{c.required?'必需':'非必需'}</td>
          <td>{c.compatible?'可读取':(c.required?'拒绝 · 阻断':'拒绝 · 风险')}</td>
          <td>{c.rejectionReasons.length?c.rejectionReasons.join('；'):'—'}</td>
        </tr>)}
      </tbody>
    </table>
    <details className="producer-snapshot" open={open}>
      <summary onClick={()=>setOpen(o=>!o)}>当时确认的生产者定义快照</summary>
      <pre className="instance">{JSON.stringify(record.producer,null,2)}</pre>
    </details>
  </div>;
}
