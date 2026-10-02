import express, {NextFunction, Request, Response} from 'express';
import {fileURLToPath} from 'node:url';
import {BadSchemaError, compareInput} from './compat';
import {presets} from '../shared/presets';
import {
  BadPreviewTokenError,
  GateBlockedError,
  NotFoundError,
  PreviewStaleError,
  ReleaseExistsError,
  ReleaseStore,
} from './release';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary schema revisions',revision:3,content:'schema revisions: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary schema revisions',revision:5,content:'schema revisions: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  const releaseStore=new ReleaseStore();

  // Express 5 types params as string | string[]; our routes only ever have a
  // single :id segment.
  const idOf = (req: Request): string => String(req.params.id);

  // Central error adapter for the release store. Each failure maps to a
  // distinct, explicit status so the client never has to guess.
  function releaseError(error: unknown, res: Response): boolean {
    if (error instanceof NotFoundError) { res.status(404).json({error: error.message}); return true; }
    if (error instanceof BadSchemaError) { res.status(400).json({error:'invalid_schema',issues:error.issues}); return true; }
    if (error instanceof BadPreviewTokenError) { res.status(400).json({error:'invalid_preview_token'}); return true; }
    if (error instanceof PreviewStaleError) {
      res.status(409).json({error:'preview_stale',divergence:error.divergence,currentPreview:error.currentPreview});
      return true;
    }
    if (error instanceof GateBlockedError) { res.status(422).json({error:'gate_blocked',preview:error.preview}); return true; }
    if (error instanceof ReleaseExistsError) { res.status(409).json({error:'release_exists',release:error.release}); return true; }
    const rev = error as {status?:number;current?:unknown};
    if (rev && rev.status === 409) { res.status(409).json({error:'revision_conflict',current:rev.current}); return true; }
    return false;
  }

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

  // ---- Multi-consumer release governance -------------------------------------
  app.get('/api/release/consumers',(_req,res)=>{
    res.json(releaseStore.listConsumers());
  });
  app.post('/api/release/consumers',(req:Request,res:Response,next:NextFunction)=>{
    try{
      const result=releaseStore.createConsumer(req.body ?? {});
      res.status(201).json(result);
    }catch(error){ if(!releaseError(error,res)) next(error); }
  });
  app.get('/api/release/consumers/:id',(req:Request,res:Response,next:NextFunction)=>{
    try{ res.json(releaseStore.getConsumer(idOf(req))); }
    catch(error){ if(!releaseError(error,res)) next(error); }
  });
  app.put('/api/release/consumers/:id',(req:Request,res:Response,next:NextFunction)=>{
    try{
      const result=releaseStore.updateConsumer(idOf(req),req.body ?? {});
      res.json(result);
    }catch(error){ if(!releaseError(error,res)) next(error); }
  });
  app.delete('/api/release/consumers/:id',(req:Request,res:Response,next:NextFunction)=>{
    try{
      releaseStore.deleteConsumer(idOf(req),(req.body as {revision?:unknown}|undefined)?.revision);
      res.status(204).end();
    }catch(error){ if(!releaseError(error,res)) next(error); }
  });

  // Preview: read-only evaluation of the draft against current revisions.
  // Returns a token pinning exactly what was evaluated.
  app.post('/api/release/preview',(req:Request,res:Response,next:NextFunction)=>{
    try{
      const preview=releaseStore.preview(req.body ?? {});
      res.json(preview);
    }catch(error){ if(!releaseError(error,res)) next(error); }
  });

  // Confirm: the only state-changing release action. Server re-pins revisions
  // and recomputes every verdict; the browser's verdict is never trusted.
  app.post('/api/release/confirm',(req:Request,res:Response,next:NextFunction)=>{
    try{
      const result=releaseStore.confirm((req.body as {previewToken?:unknown}|undefined)?.previewToken);
      res.status(201).json(result);
    }catch(error){ if(!releaseError(error,res)) next(error); }
  });

  app.get('/api/release/releases',(_req,res)=>{
    res.json(releaseStore.listReleases());
  });
  app.get('/api/release/releases/:id',(req:Request,res:Response,next:NextFunction)=>{
    try{ res.json(releaseStore.getRelease(idOf(req))); }
    catch(error){ if(!releaseError(error,res)) next(error); }
  });

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
