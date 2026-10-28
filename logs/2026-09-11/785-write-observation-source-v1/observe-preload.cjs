'use strict';
(() => {
 const wt=require('worker_threads');
 // Node workers inherit execArgv; only the native boot main thread owns trace.
 if(!wt.isMainThread)return;
 const fs=require('fs'),path=require('path'),assert=require('assert');
 const {hashFile,sha}=require('./common.cjs');
 const configPath=process.env.IDENTITY785_CONFIG;
 assert(configPath,'explicit observation config required');
 const c=JSON.parse(fs.readFileSync(configPath));
 assert(c.grantReference && c.grantReference!=='PENDING' && c.allowedKinds.includes('observation'));
 assert.strictEqual(fs.realpathSync(process.argv[1]),fs.realpathSync(path.join(c.root,'os/boot.js')));
 assert.strictEqual(hashFile(process.execPath),c.node.sha256);
 for(const [f,h] of Object.entries(c.instruments))assert.strictEqual(hashFile(path.join(__dirname,f)),h);
 const tracePath=path.join(c.output,'boot-trace.jsonl');
 const fd=fs.openSync(tracePath,'wx');let seq=0,bytes=0,disabled=false,first=false,operation=0,qualified=0;
 const errors=[],counts=Object.create(null);
 function fail(e){if(errors.length<32)errors.push(String(e && (e.stack||e)));disabled=true;}
 function emit(kind,data={}){
  if(disabled)return;
  try{
   const line=JSON.stringify({seq:++seq,kind,hostPid:process.pid,...data})+'\n';
   const buf=Buffer.from(line);assert(seq<=4096 && bytes+buf.length<=8*1024*1024,'trace cap exceeded');
   let off=0;while(off<buf.length){const n=fs.writeSync(fd,buf,off,buf.length-off);assert(n>0,'trace write made no progress');off+=n;}
   bytes+=buf.length;fs.fsyncSync(fd);
  }catch(e){fail(e);}
 }
 emit('preload-entry',{ppid:process.ppid,isMainThread:wt.isMainThread,threadId:wt.threadId,argv:process.argv,execArgv:process.execArgv,
  executable:fs.realpathSync(process.execPath),executableSha256:hashFile(process.execPath),configPath,
  configSha256:hashFile(configPath),environment:{IDENTITY785_CONFIG:configPath,NODE_OPTIONS:process.env.NODE_OPTIONS||null}});
 process.on('exit',code=>{
  emit('preload-exit',{code,counts,qualified,errors});
  try{fs.fsyncSync(fd);fs.closeSync(fd);}catch(e){fail(e);}
  // Separate failure channel survives a trace-cap/write failure when possible.
  // Missing/malformed summary is independently RED in the parent.
  try{const f=fs.openSync(path.join(c.output,'boot-observer-summary.json'),'wx');
   fs.writeFileSync(f,JSON.stringify({hostPid:process.pid,code,counts,qualified,errors,traceDisabled:disabled,records:seq,bytes}));fs.fsyncSync(f);fs.closeSync(f);
  }catch(e){try{process.stderr.write('IDENTITY785 observer summary failure: '+String(e)+'\n');}catch(_){} }
 });
 const Module=require('module'),bootPath=path.join(c.root,'os/boot.js');
 const originalText=fs.readFileSync(bootPath,'utf8');assert.strictEqual(hashFile(bootPath),c.transform.originalSha256);
 const removed=fs.readFileSync(path.join(__dirname,'default-sync.original.txt'),'utf8');
 const replacement=fs.readFileSync(path.join(__dirname,'default-sync.replacement.txt'),'utf8');
 assert.strictEqual(originalText.split(removed).length,2,'exactly one default-sync block');
 const transformed=originalText.replace(removed,replacement);
 assert.strictEqual(sha(Buffer.from(transformed)),c.transform.transformedSha256);
 assert.strictEqual(transformed,fs.readFileSync(path.join(__dirname,'boot.transformed.js'),'utf8'));
 fs.writeFileSync(path.join(c.output,'boot.transformed.js'),transformed,{flag:'wx'});
 const omissionKey=Symbol.for('identity785.boot.omission');assert(!Object.prototype.hasOwnProperty.call(globalThis,omissionKey));
 let omissions=0,transformLoads=0;
 Object.defineProperty(globalThis,omissionKey,{value:function(info){
  assert.strictEqual(info.filename,bootPath);assert.strictEqual(info.dirname,path.join(c.root,'os'));assert.strictEqual(info.root,c.root);
  assert.strictEqual(++omissions,1,'duplicate omission');emit('default-sync-explicitly-omitted',{...info,originalSha256:c.transform.originalSha256,transformedSha256:c.transform.transformedSha256});
 },configurable:true});
 const oldJs=Module._extensions['.js'];
 Module._extensions['.js']=function(mod,filename){
  if(filename!==bootPath)return oldJs.apply(this,arguments);
  assert.strictEqual(++transformLoads,1);Module._extensions['.js']=oldJs;
  assert.strictEqual(hashFile(bootPath),c.transform.originalSha256);
  emit('boot-transform-load',{filename,moduleFilename:mod.filename,modulePaths:mod.paths,originalSha256:c.transform.originalSha256,transformedSha256:c.transform.transformedSha256,mainModule:require.main===mod});
  return mod._compile(transformed,filename); // original module filename/paths/__dirname
 };
 const kernelPath=require.resolve(path.join(c.root,'kernel.js'));
 const K=require(kernelPath),COMMON=require(path.join(c.root,'os/os-common.js')),B=require(path.join(c.root,'host.js')).BLOCK_FS;
 assert.strictEqual(hashFile(kernelPath),c.sources['kernel.js']);
 assert.strictEqual(hashFile(path.join(c.root,'os/os-common.js')),c.sources['os/os-common.js']);
 const guards={};
 for(const name of ['bakeSystemImage','buildProject']){
  assert.strictEqual(typeof COMMON[name],'function',name);
  guards[name]=function(){emit('forbidden-build',{name});throw new Error('observation forbids '+name);};
  COMMON[name]=guards[name];assert.strictEqual(COMMON[name],guards[name]);
 }
 emit('no-build-guards',{names:Object.keys(guards)});
 const serviceOriginal=K.Kernel.prototype.service;
 K.Kernel.prototype.service=function(spec){
  if(!spec||spec.path!=='/bin/wm'||!Array.isArray(spec.argv)||spec.argv.length!==1||spec.argv[0]!=='wm'){
   emit('forbidden-service',{path:spec&&spec.path,argv:spec&&spec.argv});fail(new Error('unexpected service attempt'));throw new Error('unexpected service refused');
  }
  emit('ordinary-wm-service',{path:spec.path,argv:spec.argv});return serviceOriginal.apply(this,arguments);
 };
 const spawnOriginal=K.Kernel.prototype._spawn;
 K.Kernel.prototype._spawn=function(parent,spec){
  if(spec&&['gucman','cc','small'].includes(path.basename(spec.path||''))){
   emit('forbidden-package-or-compiler',{path:spec.path,argv:spec.argv});fail(new Error('package/compiler spawn attempted'));throw new Error('package/compiler spawn refused');
  }
  return spawnOriginal.apply(this,arguments);
 };
 const proto=K.Kernel.prototype,original=proto._fsRpc;
 assert.strictEqual(typeof original,'function');
 const originalDescriptor=Object.getOwnPropertyDescriptor(proto,'_fsRpc');
 emit('module-identity',{resolved:kernelPath,real:fs.realpathSync(kernelPath),sha256:hashFile(kernelPath),
  cacheFilename:require.cache[kernelPath].filename,exportsEqual:require.cache[kernelPath].exports===K,
  originalFunctionSha256:sha(Buffer.from(Function.prototype.toString.call(original))),descriptor:{writable:originalDescriptor.writable,enumerable:originalDescriptor.enumerable,configurable:originalDescriptor.configurable},
  opWrite:K.OP.FS_WRITE});
 function preserveErrors(owner,fn){
  const seen=new Set(),saved=[];
  function visit(f){if(!f||seen.has(f))return;seen.add(f);saved.push([f,Object.getOwnPropertyDescriptor(f,'_lastError')]);
   if(Array.isArray(f._mounts))for(const m of f._mounts)visit(m.fs);
  }
  visit(owner);
  try{return fn();}finally{for(const [f,d] of saved){if(d)Object.defineProperty(f,'_lastError',d);else delete f._lastError;}}
 }
 function metadata(s){
  assert(s && Number.isInteger(s.dev) && s.dev>=0 && s.dev<=0xffffffff && Number.isSafeInteger(s.ino) && s.ino>0,'invalid volume/inode metadata');
  assert(Number.isInteger(s.mode)&&Number.isSafeInteger(s.rdev)&&s.rdev>=0,'invalid mode/rdev metadata');
  return {dev:s.dev,ino:s.ino,mode:s.mode,rdev:s.rdev};
 }
 const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
 const expected=Buffer.from('#!/bin/sh\necho SHADOW-RAN\n');
 function snapshot(kernel,pcb,writeFd,submitted,n){
  return preserveErrors(kernel._fs,()=>{
   assert(Number.isInteger(n)&&n>0&&n<=submitted,'invalid successful write count');
   const owner=kernel._fs,id=pcb.fds.get(writeFd),ofd=id===undefined?null:kernel._ofds.get(id);
   const ofdEvidence={guestFd:writeFd,ofdId:id,kind:ofd&&ofd.kind,bfsFd:ofd&&ofd.bfsFd,path:ofd&&ofd.path};
   if(!ofd||ofd.kind!=='file')return {qualified:false,reason:'non-file OFD',ofd:ofdEvidence};
   if(n<submitted)return {qualified:false,reason:'partial write',n,submitted,ofd:ofdEvidence};
   const subject=owner.fstat(ofd.bfsFd),sm=metadata(subject),shadow=owner.stat('/usr/local/bin/python');
   if(!shadow)return {qualified:false,reason:'shadow absent',ofd:ofdEvidence};
   if(!same(sm,metadata(shadow)))return {qualified:false,reason:'different subject',ofd:ofdEvidence};
   if(subject.size!==expected.length||shadow.size!==expected.length)return {qualified:false,reason:'incomplete or different length',size:subject.size,expectedLength:expected.length,ofd:ofdEvidence};
   // Ordinary owner.read would update relatime. Use the same backing store
   // through an existing createV4 readonly view: no guest offset or atime write.
   const physical=owner.realpathPhysical('/usr/local/bin/python');assert.strictEqual(typeof physical,'string');
   let readView,relative;
   owner._fdOp(ofd.bfsFd,function(vol){
    const mounts=owner._mounts.filter(m=>m.fs===vol&&(m.prefix==='/'||physical===m.prefix||physical.startsWith(m.prefix+'/')));
    assert.strictEqual(mounts.length,1,'ambiguous subject backing mount');
    relative=mounts[0].prefix==='/'?physical:(physical.slice(mounts[0].prefix.length)||'/');
    readView=B.createV4(new B.ReadOnlyStore(vol._s),{readonly:true});return 0;
   });
   assert(readView,'readonly backing view unavailable');
   const reader=readView.open(relative,0,0);assert(reader!==null,'independent readonly open failed');
   let actual,primary=null;
   try{
    const opened=readView.fstat(reader);assert(opened&&opened.ino===sm.ino&&opened.size===expected.length,'readback subject changed');
    actual=Buffer.alloc(expected.length);let off=0;
    while(off<actual.length){const got=readView.read(reader,actual.subarray(off),actual.length-off);assert(Number.isInteger(got)&&got>0&&got<=actual.length-off,'incomplete readonly readback');off+=got;}
    const extra=Buffer.alloc(1);assert.strictEqual(readView.read(reader,extra,1),0,'readback not exact EOF');
   }catch(e){primary=e;throw e;}
   finally{const result=readView.close(reader);if(result===null){if(primary)primary.message+='; readback close failed';else throw new Error('readback close failed');}}
   if(!actual.equals(expected))return {qualified:false,reason:'different contents',contentSha256:sha(actual),ofd:ofdEvidence};
   const files={};for(const name of ['/usr/local/bin/python','/usr/bin/cmdalt'])files[name]={stat:metadata(owner.stat(name)),lstat:metadata(owner.lstat(name))};
   assert(same(files['/usr/local/bin/python'].stat,sm),'snapshot subject changed');
   return {qualified:true,subject:sm,ofd:ofdEvidence,n,submitted,contentLength:actual.length,contentSha256:sha(actual),expectedSha256:sha(expected),independentReadOnlyHandle:true,files,volumes:owner._mounts.map(m=>({prefix:m.prefix,identity:owner.getVolumeIdentity(m.prefix)}))};
  });
 }
 function wrapped(pcb,op,req){
  try{counts[op]=(counts[op]||0)+1;if(!first){first=true;emit('first-fsRpc',{op,prototypeEqual:proto._fsRpc===wrapped,instanceEqual:this._fsRpc===wrapped,moduleEqual:require(kernelPath)===K});}}
  catch(e){fail(e);}
  if(op!==K.OP.FS_WRITE)return original.apply(this,arguments);
  const kernel=this,id=++operation;let writeFd=null,submitted=null,validRaw=false,responses=0,returned=false,thrown=null;
  try{const raw=req.raw;validRaw=raw instanceof Uint8Array&&raw.length>=4;
   if(validRaw){writeFd=raw[0]|(raw[1]<<8)|(raw[2]<<16)|(raw[3]<<24);submitted=raw.length-4;}
   emit('condition',{id,op,validRaw,rawLength:raw&&raw.length,fd:writeFd,submitted,guestPid:pcb.pid,cwd:pcb.cwd,prototypeEqual:proto._fsRpc===wrapped,instanceEqual:kernel._fsRpc===wrapped});
  }catch(e){fail(e);}
  const descriptor=Object.getOwnPropertyDescriptor(kernel,'_respond'),respond=kernel._respond;
  function tapped(target,reply){
   // No product response can be lost to instrumentation failure.
   try{
    if(target===pcb){responses++;const success=!!reply&&!reply.errno&&Number.isInteger(reply.n)&&reply.n>0;
     let observed=null;if(success){assert(validRaw,'successful write has invalid raw request');observed=snapshot(kernel,pcb,writeFd,submitted,reply.n);}
     if(observed&&observed.qualified)qualified++;
     emit('response-before-forward',{id,responseNumber:responses,targetMatches:true,reply,success,observation:observed});
    }else emit('response-before-forward',{id,targetMatches:false,reply});
   }catch(e){fail(e);}
   return respond.apply(this,arguments); // exactly one forwarding of each actual call
  }
  let installed=false;
  try{
   try{Object.defineProperty(kernel,'_respond',{value:tapped,writable:true,configurable:true,enumerable:descriptor?descriptor.enumerable:false});installed=true;}
   catch(e){fail(e);}
   try{const result=original.apply(this,arguments);returned=true;return result;}
   catch(e){thrown=String(e);throw e;}
  }finally{
   if(installed){try{if(descriptor)Object.defineProperty(kernel,'_respond',descriptor);else delete kernel._respond;}catch(e){fail(e);}}
   emit('operation-complete',{id,responses,returned,thrown,respondRestored:kernel._respond===respond});
  }
 }
 Object.defineProperty(proto,'_fsRpc',{...originalDescriptor,value:wrapped});
 emit('hook-installed',{readbackEqual:proto._fsRpc===wrapped,moduleEqual:require(kernelPath)===K});
 const bootDescriptor=Object.getOwnPropertyDescriptor(proto,'boot'),originalBoot=proto.boot;
 Object.defineProperty(proto,'boot',{...bootDescriptor,value:function(){
  try{emit('boot-mounted-before-spawn',{systemSha256:hashFile(path.join(c.output,'observation-system.img')),
   rootExists:fs.existsSync(path.join(c.output,'observation-root.img')),hookEqual:this._fsRpc===wrapped,
   buildGuardsEqual:Object.keys(guards).every(n=>COMMON[n]===guards[n])});}catch(e){fail(e);}
  return originalBoot.apply(this,arguments);
 }});

})();
