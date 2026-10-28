'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process'),assert=require('assert');
const {setup}=require('./common.cjs'),{bounded,watch,stop}=require('./native.cjs');
const {c,record,finalize}=setup('cmdalt');
require(path.join(c.root,'tests/lib/heavy-lock.js')).joinHeavyLock({name:'#785 current cmdalt observation'});
let primaryError=null, stagePassed=false, childWatch;
const cleanupErrors=[],writeErrors=[],streams=[];
const { observePackageServer }=require('./server-observe.cjs');
let serverObservation=null;
let rejectOutput;
const outputFailure=new Promise((_,reject)=>{rejectOutput=reject;});
// Attach a handler immediately, even if startup throws before the race is reached.
outputFailure.catch(()=>{});
function outputStream(name) {
  const stream=fs.createWriteStream(path.join(c.output,name),{flags:'wx'});
  const state={name,stream,closed:false,finished:false};
  state.done=new Promise(resolve=>{
    stream.on('error',error=>{writeErrors.push({name,error:String(error)});rejectOutput(error);});
    stream.on('finish',()=>{state.finished=true;});
    stream.on('close',()=>{state.closed=true;resolve();});
  });
  streams.push(state);return stream;
}
(async()=>{
 try {
  assert(!process.env.NODE_OPTIONS,'unexpected NODE_OPTIONS');
  const preload=path.join(__dirname,'cmdalt-preload.cjs');
  const command=[process.execPath,'-r',path.join(c.root,'tests/lib/parent-watch.js'),path.join(c.root,'tests/kernel/test_cmdalt_e2e.js')];
  const child=cp.spawn(command[0],command.slice(1),{cwd:c.root,stdio:['ignore','pipe','pipe'],env:{...process.env,CC_HARNESS_GROUP_LEADER:'0',IDENTITY785_CONFIG:path.resolve(process.argv[3]),NODE_OPTIONS:'--require='+JSON.stringify(preload)}});
  childWatch=watch(child,command);
  const stdout=outputStream('original-test.stdout'),stderr=outputStream('original-test.stderr');
  child.stdout.pipe(stdout);child.stderr.pipe(stderr);
  await bounded(Promise.race([childWatch.done,outputFailure]),c.cmdalt.timeoutMs,'original cmdalt complete package/two-boot test');
  record('cmdalt-result.json',childWatch.row);
  assert.strictEqual(childWatch.row.code,0,'original current cmdalt all assertions');assert.strictEqual(childWatch.row.signal,null);
  const observations=fs.readFileSync(path.join(c.output,'cmdalt-identity.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.strictEqual(observations.length,1,'exact original session A shadow chmod observation');
  for(const row of observations){
   assert.strictEqual(row.kind,'post-existing-shadow-chmod');
   const a=row.files['/usr/local/bin/python'].stat,b=row.files['/usr/bin/cmdalt'].stat;
   assert(a && b && (a.dev!==b.dev || a.ino!==b.ino),'measured current pair differs');
  }
  const bootFiles=fs.readdirSync(c.output).filter(n=>/^cmdalt-\d+-\d+\.exit\.json$/.test(n));
  assert.strictEqual(bootFiles.length,2,'two original current boots, no omitted package session');
  for(const file of bootFiles){const x=JSON.parse(fs.readFileSync(path.join(c.output,file)));assert.strictEqual(x.status,0);assert.strictEqual(x.signal,null);assert(!x.error);}
  stagePassed=true;
 }catch(error){primaryError=error;}
 finally{
  await stop(childWatch,cleanupErrors);
  try { await bounded(Promise.all(streams.map(s=>s.done)),5000,'original output flush'); }
  catch(error){cleanupErrors.push(String(error));for(const s of streams)if(!s.closed)s.stream.destroy();}
  try { serverObservation=await observePackageServer(c); }
  catch(error){serverObservation={cleanupObserved:false,error:String(error)};cleanupErrors.push(String(error));}
  record('package-server-after.json',serverObservation);
  const outputComplete=streams.length===2 && streams.every(s=>s.closed && s.finished) && writeErrors.length===0;
  record('output-finalization.json',{outputComplete,writeErrors,streams:streams.map(s=>({name:s.name,closed:s.closed,finished:s.finished}))});
  record('native-cleanup.json',{testChild:childWatch && childWatch.row,cleanupErrors,serverObservation,writeErrors,descendantNativeExits:'see cmdalt-native.jsonl; any missing server exit callback remains unknown, not inferred from parent exit'});
  if(primaryError)record('failure.json',{primaryError:primaryError.stack,cleanupErrors,writeErrors});
  finalize(primaryError,{stagePassed,cleanupComplete:!!childWatch && childWatch.row.exitObserved && childWatch.row.closeObserved && cleanupErrors.length===0 && outputComplete && serverObservation.cleanupObserved,artifactErrors:[...cleanupErrors,...writeErrors]});
  if(process.exitCode)process.exit(1);
 }
})();
