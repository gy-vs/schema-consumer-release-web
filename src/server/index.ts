import express from 'express';
import {fileURLToPath} from 'node:url';
import {BadSchemaError, compareInput} from './compat';
import {presets} from '../shared/presets';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary schema revisions',revision:3,content:'schema revisions: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary schema revisions',revision:5,content:'schema revisions: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"schema-evolution",count:rows.length}));
  app.get('/api/schemas',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/schemas/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/schemas/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/schemas/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  app.get('/api/compat/presets',(_req,res)=>{
    res.json(presets.map(({v1,v2,...meta})=>meta));
  });
  app.get('/api/compat/presets/:id',(req,res)=>{
    const preset=presets.find(value=>value.id===req.params.id);
    if(!preset)return res.status(404).json({error:'preset_not_found'});
    res.json(preset);
  });
  app.post('/api/compat/compare',(req,res)=>{
    const body=req.body as {v1?:unknown;v2?:unknown;policy?:unknown}|undefined;
    const policy=body?.policy==='passthrough'?'passthrough':'fail';
    try{
      const result=compareInput({v1:body?.v1,v2:body?.v2,policy});
      res.json(result);
    }catch(error){
      if(error instanceof BadSchemaError){
        return res.status(400).json({error:'invalid_schema',issues:error.issues});
      }
      throw error;
    }
  });
  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
