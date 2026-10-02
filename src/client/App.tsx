import {useState} from 'react';
import {FlaskConical, GitCompareArrows, Users} from 'lucide-react';
import CompareView from './CompareView';
import ReleaseView from './ReleaseView';

type Mode='compare'|'release';

export default function App(){
  const [mode,setMode]=useState<Mode>('release');
  return <main className="shell">
    <header className="topbar">
      <FlaskConical size={20}/><strong>Schema 演进工作台 · Discriminated Union</strong>
      <nav className="modes">
        <button className={mode==='release'?'active':''} onClick={()=>setMode('release')}>
          <Users size={14}/>多消费方发布
        </button>
        <button className={mode==='compare'?'active':''} onClick={()=>setMode('compare')}>
          <GitCompareArrows size={14}/>单对比较
        </button>
      </nav>
    </header>
    {mode==='release'?<ReleaseView/>:<CompareView/>}
  </main>;
}
