import {CircleDot, ShieldX} from 'lucide-react';
import type {Counterexample, UnionHop} from '../shared/api';
import type {Issue} from '../shared/schema';

// Union hop trail, validator table and counterexample card are shared by the
// single-pair view and the multi-consumer release view: BOTH surfaces must
// show counterexamples produced by the same engine semantics.

export function HopPath({hops}:{hops:UnionHop[]}){
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

export function ErrorList({issues}:{issues:Issue[]}){
  if(issues.length===0)return <span className="muted">无错误</span>;
  return <ul className="issues">{issues.slice(0,5).map((iss,i)=><li key={i}><code>{iss.code}</code> {iss.message}</li>)}</ul>;
}

export function CounterexampleCard({ce,index}:{ce:Counterexample;index:number}){
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
