'use strict';
const fs=require('fs'),path=require('path'),cp=require('child_process'),assert=require('assert');
const {setup}=require('./common.cjs'),{bounded,watch,stop}=require('./native.cjs');
const {c,record,finalize}=setup('cmdalt');
require(path.join(c.root,'tests/lib/heavy-lock.js')).joinHeavyLock({name:'#785 current cmdalt observation'});
let primaryError=null, stagePassed=false, childWatch;
const cleanupErrors=[];
(async()=>{
 try {
  assert(!process.env.NODE_OPTIONS,'unexpected NODE_OPTIONS');
  const preload=path.join(__dirname,'cmdalt-preload.cjs');
  const command=[process.execPath,'-r',path.join(c.root,'tests/lib/parent-watch.js'),path.join(c.root,'tests/kernel/test_cmdalt_e2e.js')];
  const child=cp.spawn(command[0],command.slice(1),{cwd:c.root,stdio:['ignore','pipe','pipe'],env:{...process.env,CC_HARNESS_GROUP_LEADER:'0',IDENTITY785_CONFIG:path.resolve(process.argv[3]),NODE_OPTIONS:'--require='+JSON.stringify(preload)}});
  childWatch=watch(child,command);
  const stdout=fs.createWriteStream(path.join(c.output,'original-test.stdout'),{flags:'wx'}),stderr=fs.createWriteStream(path.join(c.output,'original-test.stderr'),{flags:'wx'});
  child.stdout.pipe(stdout);child.stderr.pipe(stderr);
  await bounded(childWatch.done,c.cmdalt.timeoutMs,'original cmdalt complete package/two-boot test');
  await Promise.all([stdout,stderr].map(s=>s.closed?Promise.resolve():new Promise((resolve,reject)=>{s.once('close',resolve);s.once('error',reject);}))); 
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
  record('native-cleanup.json',{testChild:childWatch && childWatch.row,cleanupErrors,descendantNativeExits:'see cmdalt-native.jsonl; any missing server exit callback remains unknown, not inferred from parent exit'});
  if(primaryError)record('failure.json',{primaryError:primaryError.stack,cleanupErrors});
  finalize(primaryError,{stagePassed,cleanupComplete:!!childWatch && childWatch.row.exitObserved && childWatch.row.closeObserved && cleanupErrors.length===0,artifactErrors:cleanupErrors});
  if(process.exitCode)process.exit(1);
 }
})();
