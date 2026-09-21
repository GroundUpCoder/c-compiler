// Read-only acceptance probes; no renderer/kernel instrumentation or mutation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const COMMON=require('../../../os/os-common.js'),B=require('../../../host.js').BLOCK_FS;
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
export async function imageIdentity(s,root) {
 const files={};
 for(const f of ['host.js','compiler.js','kernel.js','os/kernel-worker.js','os/process-worker.js','os/image.json','os/os-system.img']) {
  const local=fs.readFileSync(path.join(root,f)),res=await s.page.request.get(new URL('/'+f,s.url).href);
  if(!res.ok())throw new Error('identity fetch failed: '+f);
  const served=hash(await res.body());files[f]={local:hash(local),served};
  if(files[f].local!==served)throw new Error('served identity mismatch: '+f);
 }
 const store=new COMMON.NodeFileStore(fs,path.join(root,'os/os-system.img'),false);
 let expected;
 try {
  const kfs=B.createV4(store,{readonly:true});
  expected={};
  for(const p of ['/usr/share/os-release','/usr/lib/fontbridge.wasm']) {
   const bytes=COMMON.readFileBytes(kfs,p.slice(4));if(!bytes)throw new Error('baked identity file missing: '+p);
   expected[p]={sha256:hash(bytes)};
   if(p.endsWith('os-release'))expected[p].text=Buffer.from(bytes).toString();
  }
 } finally {store.close();}
 const start=await s.page.evaluate(()=>window.__osOut.length);
 await s.setVt(1);
 await s.page.keyboard.type('sha256sum /usr/share/os-release /usr/lib/fontbridge.wasm && echo IMAGE-V""ERIFIED\r');
 await s.page.waitForFunction(start=>window.__osOut.slice(start).includes('IMAGE-VERIFIED'),start,{timeout:30000});
 const installed=await s.page.evaluate(start=>window.__osOut.slice(start),start);
 for(const [p,v] of Object.entries(expected))if(!installed.includes(v.sha256+'  '+p))throw new Error('installed identity mismatch: '+p+'\n'+installed);
 return {files,expected,installed,scope:'Local/served image byte hashes; installed selected-file hashes match baked files. No independent whole-OPFS byte hash.'};
}
export async function surfaceTransport(s,title,mode) {
 const worker=s.page.workers().find(w=>w.url().includes('kernel-worker.js'));
 if(!worker)throw new Error('kernel worker unavailable for read-only transport probe');
 const observed=await worker.evaluate(title=>{
  const surface=Array.from(kernel._surfaces.values()).find(x=>x.title===title);
  if(!surface)return null;
  return {sid:surface.sid,pid:surface.pid,title:surface.title,width:surface.w,height:surface.h,
   frameSeq:Atomics.load(surface.i32,5),bitmap:!!surface.bitmap,
   bitmapWidth:surface.bitmap?surface.bitmap.width:0,bitmapHeight:surface.bitmap?surface.bitmap.height:0};
 },title);
 if(!observed||observed.frameSeq<=0||observed.bitmap!==(mode==='GPU'))throw new Error('actual surface transport mismatch: '+JSON.stringify({mode,observed}));
 return {...observed,transport:observed.bitmap?'GPU ImageBitmap':'CPU shared memory',scope:'Kernel surface after completed frame; bitmap presence distinguishes GPU transport from software fallback.'};
}
