'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process'),assert=require('assert');
const {setup,hashFile}=require('./common.cjs'),{bounded,watch,stop}=require('./native.cjs');
const {c,record,finalize}=setup('observation');
require(path.join(c.root,'tests/lib/heavy-lock.js')).joinHeavyLock({name:'#785 one boot identity observation'});
let primaryError=null,stagePassed=false,w;
const cleanupErrors=[],writeErrors=[],streams=[];let rejectOutput;
const outputFailure=new Promise((_,reject)=>{rejectOutput=reject;});outputFailure.catch(()=>{});
function stream(name){
 const s=fs.createWriteStream(path.join(c.output,name),{flags:'wx'}),state={name,s,finished:false,closed:false};
 state.done=new Promise(resolve=>{s.on('error',e=>{writeErrors.push({name,error:String(e)});rejectOutput(e);});s.on('finish',()=>state.finished=true);s.on('close',()=>{state.closed=true;resolve();});});
 streams.push(state);return s;
}
const system=path.join(c.output,'observation-system.img'),rootImage=path.join(c.output,'observation-root.img');
(async()=>{
 try{
  assert(!process.env.NODE_OPTIONS,'ambient preload forbidden');
  assert.strictEqual(hashFile(c.observation.system),c.observation.systemSha256);
  assert(!fs.existsSync(system)&&!fs.existsSync(rootImage),'fresh owned image namespace required');
  fs.copyFileSync(c.observation.system,system,fs.constants.COPYFILE_EXCL);
  assert.strictEqual(hashFile(system),c.observation.systemSha256);
  const input=fs.readFileSync(path.join(__dirname,'session-a-prefix.sh'));
  fs.writeFileSync(path.join(c.output,'stdin.sh'),input,{flag:'wx'});
  record('fixture-before.json',{retained:{path:c.observation.system,sha256:hashFile(c.observation.system)},owned:{path:system,sha256:hashFile(system)},root:{path:rootImage,exists:false},prefixSha256:hashFile(path.join(c.output,'stdin.sh')),freshRootNotHistoricalReplay:true});
  const command=[process.execPath,'-r',path.join(c.root,'tests/lib/parent-watch.js'),'-r',path.join(__dirname,'observe-preload.cjs'),path.join(c.root,'os/boot.js'),'--image='+system,'--fixture='+system,'--quiet','--packages=none'];
  const child=cp.spawn(command[0],command.slice(1),{cwd:c.root,stdio:['pipe','pipe','pipe'],env:{...process.env,CC_HARNESS_GROUP_LEADER:'0',IDENTITY785_CONFIG:path.resolve(process.argv[3])}});
  w=watch(child,command);
  child.stdin.on('error',e=>{writeErrors.push({name:'stdin',error:String(e)});rejectOutput(e);});
  child.stdout.pipe(stream('boot.stdout'));child.stderr.pipe(stream('boot.stderr'));child.stdin.end(input);
  await bounded(Promise.race([w.done,outputFailure]),c.observation.timeoutMs,'one boot native completion');
  record('boot-result.json',w.row);
  assert(w.row.exitObserved&&w.row.closeObserved&&!w.row.error,'actual native boot completion');
  assert.strictEqual(w.row.code,0);assert.strictEqual(w.row.signal,null);assert.strictEqual(w.row.closeCode,0);assert.strictEqual(w.row.closeSignal,null);
  // Only parse after native close; all trace writes are synchronous in that child.
  const text=fs.readFileSync(path.join(c.output,'boot-trace.jsonl'),'utf8');assert(text.endsWith('\n'),'partial trace');
  const events=text.trim().split('\n').map(JSON.parse),summary=JSON.parse(fs.readFileSync(path.join(c.output,'boot-observer-summary.json')));
  events.forEach((e,i)=>{assert.strictEqual(e.seq,i+1);assert.strictEqual(e.hostPid,w.row.pid);});
  assert(events.length<=4096&&Buffer.byteLength(text)<=8*1024*1024);
  const one=kind=>{const a=events.filter(e=>e.kind===kind);assert.strictEqual(a.length,1,kind);return a[0];};
  const entry=one('preload-entry');assert(entry.isMainThread&&entry.threadId===0);assert.strictEqual(entry.executableSha256,c.node.sha256);
  assert.strictEqual(entry.configSha256,hashFile(path.resolve(process.argv[3])));
  const mod=one('module-identity');assert(mod.exportsEqual);assert.strictEqual(mod.sha256,c.sources['kernel.js']);
  assert.strictEqual(mod.real,fs.realpathSync(path.join(c.root,'kernel.js')));
  const installed=one('hook-installed');assert(installed.readbackEqual&&installed.moduleEqual);
  const mounted=one('boot-mounted-before-spawn');assert.strictEqual(mounted.systemSha256,c.observation.systemSha256);assert(mounted.rootExists&&mounted.hookEqual&&mounted.buildGuardsEqual);
  const first=one('first-fsRpc');assert(first.prototypeEqual&&first.instanceEqual&&first.moduleEqual);
  assert.deepStrictEqual(one('no-build-guards').names,['bakeSystemImage','buildProject']);
  assert(!events.some(e=>e.kind.startsWith('forbidden-')));
  const transform=one('boot-transform-load');assert(transform.mainModule);assert.strictEqual(transform.filename,path.join(c.root,'os/boot.js'));assert.strictEqual(transform.moduleFilename,transform.filename);assert.strictEqual(transform.transformedSha256,c.transform.transformedSha256);
  assert.strictEqual(hashFile(path.join(c.output,'boot.transformed.js')),c.transform.transformedSha256);
  const omission=one('default-sync-explicitly-omitted');assert.strictEqual(omission.originalSha256,c.transform.originalSha256);assert.strictEqual(omission.transformedSha256,c.transform.transformedSha256);
  const wm=one('ordinary-wm-service');assert.strictEqual(wm.path,'/bin/wm');assert.deepStrictEqual(wm.argv,['wm']);
  const end=one('preload-exit');assert.strictEqual(end.code,0);assert.deepStrictEqual(end.errors,[]);
  assert.strictEqual(summary.hostPid,w.row.pid);assert.strictEqual(summary.code,0);assert.deepStrictEqual(summary.errors,[]);assert(!summary.traceDisabled);assert.strictEqual(summary.records,events.length);
  assert.strictEqual(summary.qualified,1);
  const pairs=events.filter(e=>e.kind==='response-before-forward'&&e.observation&&e.observation.qualified);
  assert.strictEqual(pairs.length,1);const pair=pairs[0];assert(pair.targetMatches&&pair.success&&pair.responseNumber===1);
  const condition=events.filter(e=>e.kind==='condition'&&e.id===pair.id);assert.strictEqual(condition.length,1);assert(condition[0].validRaw&&condition[0].submitted>0);assert(condition[0].prototypeEqual&&condition[0].instanceEqual);
  const completed=events.filter(e=>e.kind==='operation-complete'&&e.id===pair.id);assert.strictEqual(completed.length,1);assert(completed[0].returned&&!completed[0].thrown&&completed[0].responses===1&&completed[0].respondRestored);assert(pair.seq<completed[0].seq);
  const files=pair.observation.files,a=files['/usr/local/bin/python'],b=files['/usr/bin/cmdalt'];
  assert(a.stat.dev!==b.stat.dev||a.stat.ino!==b.stat.ino,'actual distinct pair');
  for(const f of [a,b])for(const k of ['dev','ino','mode','rdev'])assert.strictEqual(f.stat[k],f.lstat[k]);
  assert.strictEqual(pair.observation.contentSha256,c.observation.expectedContentSha256);assert.strictEqual(pair.observation.contentLength,c.observation.expectedContentLength);assert(pair.observation.independentReadOnlyHandle);assert.strictEqual(pair.observation.n,pair.observation.submitted);
  record('identity-result.json',{condition:condition[0],pair,completed:completed[0],freshRootNotHistoricalReplay:true});
  assert.strictEqual(hashFile(system),c.observation.systemSha256,'no system replacement/bake');
  stagePassed=true;
 }catch(e){primaryError=e;}
 finally{
  try{await stop(w,cleanupErrors);}catch(e){cleanupErrors.push(String(e));}
  try{await bounded(Promise.all(streams.map(x=>x.done)),5000,'boot output final flush');}
  catch(e){cleanupErrors.push(String(e));for(const x of streams)if(!x.closed)x.s.destroy();}
  const outputComplete=streams.length===2&&streams.every(x=>x.finished&&x.closed)&&writeErrors.length===0;
  record('output-finalization.json',{outputComplete,writeErrors,streams:streams.map(x=>({name:x.name,finished:x.finished,closed:x.closed}))});
  const images=[];
  for(const file of [system,rootImage]){try{images.push({path:file,exists:fs.existsSync(file),sha256:fs.existsSync(file)?hashFile(file):null});}catch(e){cleanupErrors.push(String(e));}}
  let retainedOriginalSha256=null;try{retainedOriginalSha256=hashFile(c.observation.system);}catch(e){cleanupErrors.push(String(e));}
  record('fixture-after.json',{images,retainedOriginalSha256});
  // Require the actual newly seeded root too; missing files remain missing evidence.
  if(!images.some(x=>x.path===rootImage&&x.exists))cleanupErrors.push('owned root image absent');
  record('native-cleanup.json',{boot:w&&w.row,cleanupErrors,writeErrors,server:'none in scope',workerNativeExits:'not observed; native boot exit does not establish worker callbacks'});
  if(primaryError)record('failure.json',{primaryError:primaryError.stack,cleanupErrors,writeErrors});
  finalize(primaryError,{stagePassed,cleanupComplete:!!w&&w.row.exitObserved&&w.row.closeObserved&&outputComplete&&cleanupErrors.length===0,artifactErrors:[...cleanupErrors,...writeErrors]});
  if(process.exitCode)process.exit(1);
 }
})();
