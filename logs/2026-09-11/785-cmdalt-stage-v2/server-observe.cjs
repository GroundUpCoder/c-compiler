'use strict';
// Surviving parent's read-only observations. No PID signals or native-status invention.
const fs=require('fs'),path=require('path'),cp=require('child_process'),{performance}=require('perf_hooks');
function inspect(file,args) {
 const r=cp.spawnSync(file,args,{encoding:'utf8',timeout:1000,maxBuffer:1<<20});
 return {command:[file,...args],status:r.status,signal:r.signal,error:r.error && String(r.error),stdout:r.stdout,stderr:r.stderr};
}
function absent(r){return r.status===1 && r.signal===null && !r.error && !String(r.stdout||'').trim() && !String(r.stderr||'').trim();}
async function observePackageServer(c) {
 const file=path.join(c.output,'package-server.jsonl');
 const records=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 const spawned=records.filter(r=>r.kind==='spawned'),ready=records.filter(r=>r.kind==='ready');
 const result={records,observations:[],cleanupObserved:false,nativeExitStatus:'UNKNOWN unless an actual async-exit callback is retained in cmdalt-native.jsonl; absence is not an exit status'};
 if(spawned.length!==1 || ready.length!==1){result.reason='server PID/port lifecycle incomplete or ambiguous';return result;}
 const server=ready[0];
 if(!Number.isInteger(server.pid)||server.pid<=1||server.pid!==spawned[0].pid||!Number.isInteger(server.port)||server.port<=0||server.port>65535||!server.identity||server.identity.status!==0||!server.identity.stdout.trim()){
  result.reason='recorded server identity or port invalid';return result;
 }
 const fields=server.identity.stdout.trim().split(/\s+/);
 if(Number(fields[0])!==server.pid || Number(fields[1])!==server.observerPid || server.dir!==spawned[0].dir || !server.command || server.command[1]!==path.join(c.root,'serve.js') || server.command[2]!==server.dir){result.reason='recorded PID/parent/command identity inconsistent';return result;}
 const deadline=performance.now()+5000;
 do {
  const process=inspect(c.observationTools.ps,['-p',String(server.pid),'-o','pid=,ppid=,pgid=,lstart=,command=']);
  const listener=inspect(c.observationTools.lsof,['-nP','-iTCP:'+server.port,'-sTCP:LISTEN','-Fpcn']);
  result.observations.push({at:new Date().toISOString(),process,listener});
  if(absent(process)&&absent(listener)){result.cleanupObserved=true;result.reason='recorded PID absent and port has no observable TCP listener';return result;}
  if(process.status===0 && process.stdout.trim()!==server.identity.stdout.trim()){
   result.reason='PID identity changed or ownership unresolved; no signal sent';return result;
  }
  if((process.status!==0&&!absent(process)) || (listener.status!==0&&!absent(listener))){result.reason='process/listener observation failed or ambiguous';return result;}
  if(performance.now()>=deadline)break;
  await new Promise(resolve=>setTimeout(resolve,Math.min(200,Math.max(0,deadline-performance.now()))));
 }while(performance.now()<deadline);
 result.reason='known server process or listener remains observable after bounded wait; coordinate, no signal sent';
 return result;
}
module.exports={observePackageServer};
