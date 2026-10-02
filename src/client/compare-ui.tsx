import {ArrowRight, CircleDot, ShieldCheck, ShieldX, ShieldAlert} from 'lucide-react';
import type {Counterexample, DirectionResult, UnionHop} from '../shared/api';
import type {Issue} from '../shared/schema';

// Shared presentation pieces used by BOTH the single-pair compare view and the
// multi-consumer release view. The counterexample card renders the same
// validator-proven object from the shared engine — no second generator.

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

export function CounterexampleCard({ce,index,labels}:{ce:Counterexample;index:number;labels?:{producer:string;consumer:string}}){
  const pl=labels?.producer??ce.validatedBy.producer;
  const cl=labels?.consumer??ce.validatedBy.consumer;
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
            <tr className={ce.validatesAs.producer?'ok':'bad'}><td>{pl} 生产者</td><td>{ce.validatesAs.producer?'接受 ✓':'拒绝 ✗'}</td></tr>
            <tr className={ce.validatesAs.consumer?'ok':'bad'}><td>{cl} 消费者</td><td>{ce.validatesAs.consumer?'接受 ✓':'拒绝 ✗'}</td></tr>
          </tbody>
        </table>
        <h5>{pl} 验证错误</h5><ErrorList issues={ce.producerErrors}/>
        <h5>{cl} 验证错误</h5><ErrorList issues={ce.consumerErrors}/>
      </div>
    </div>
  </details>;
}

export function VerdictCard({title,subtitle,result,accent,producerLabel,consumerLabel,policyLabel}:{
  title:string;subtitle:string;result:DirectionResult|undefined;accent?:boolean;
  producerLabel?:string;consumerLabel?:string;policyLabel?:string;
}){
  const compatible=result?.compatible;
  const cls=compatible===undefined?'idle':compatible?'pass':'fail';
  const Icon=compatible===undefined?ShieldAlert:compatible?ShieldCheck:ShieldX;
  return <article className={`verdict ${cls} ${accent?'accent':''}`}>
    <header><Icon size={18}/><div><h3>{title}</h3><small>{subtitle}</small></div>
      <span className="badge">{compatible===undefined?'—':compatible?'兼容':'不兼容'}</span>
    </header>
    {result&&<div className="flow">
      <code>{producerLabel??`${result.producer} 生产者`}</code><ArrowRight size={13}/><code>{consumerLabel??`${result.consumer} 消费者`}</code>
      <span className="policytag">{policyLabel??`未知值: v1=${result.unknownPolicy.v1.topLevel} · v2=${result.unknownPolicy.v2.topLevel}`}</span>
    </div>}
    {result&&!result.compatible&&<p className="count">最小反例 {result.counterexamples.length} 个</p>}
  </article>;
}
