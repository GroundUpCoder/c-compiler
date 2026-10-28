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
 const kernelPath=require.resolve(path.join(c.root,'kernel.js'));
 const K=require(kernelPath),COMMON=require(path.join(c.root,'os/os-common.js'));
 assert.strictEqual(hashFile(kernelPath),c.sources['kernel.js']);
 assert.strictEqual(hashFile(path.join(c.root,'os/os-common.js')),c.sources['os/os-common.js']);
 const guards={};
 for(const name of ['bakeSystemImage','buildProject']){
  assert.strictEqual(typeof COMMON[name],'function',name);
  guards[name]=function(){emit('forbidden-build',{name});throw new Error('observation forbids '+name);};
  COMMON[name]=guards[name];assert.strictEqual(COMMON[name],guards[name]);
 }
 emit('no-build-guards',{names:Object.keys(guards)});
 const proto=K.Kernel.prototype,original=proto._fsRpc;
 assert.strictEqual(typeof original,'function');
 const originalDescriptor=Object.getOwnPropertyDescriptor(proto,'_fsRpc');
 emit('module-identity',{resolved:kernelPath,real:fs.realpathSync(kernelPath),sha256:hashFile(kernelPath),
  cacheFilename:require.cache[kernelPath].filename,exportsEqual:require.cache[kernelPath].exports===K,
  originalFunctionSha256:sha(Buffer.from(Function.prototype.toString.call(original))),descriptor:{writable:originalDescriptor.writable,enumerable:originalDescriptor.enumerable,configurable:originalDescriptor.configurable},
  opChmod:K.OP.FS_CHMOD,opFchmod:K.OP.FS_FCHMOD});
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
 function snapshot(kernel,pcb,op,req,full){
  return preserveErrors(kernel._fs,()=>{
   const owner=kernel._fs;let subject,ofdEvidence=null;
   if(op===K.OP.FS_CHMOD)subject=owner.stat(full);
   else{
    const id=pcb.fds.get(req.fd|0),ofd=id===undefined?null:kernel._ofds.get(id);
    ofdEvidence={guestFd:req.fd,ofdId:id,kind:ofd&&ofd.kind,bfsFd:ofd&&ofd.bfsFd,path:ofd&&ofd.path};
    if(!ofd||ofd.kind!=='file')return {qualified:false,reason:'unresolved non-file OFD',ofd:ofdEvidence};
    subject=owner.fstat(ofd.bfsFd); // volume-qualified stat; never OFD device dispatch identity
   }
   const sm=metadata(subject),shadow=owner.stat('/usr/local/bin/python');
   if(!shadow)return {qualified:false,reason:'shadow absent',subject:sm,ofd:ofdEvidence};
   const sh=metadata(shadow);
   if(!same(sm,sh)||(req.mode&0o777)!==0o755)return {qualified:false,reason:'different subject or mode',subject:sm,shadow:sh,ofd:ofdEvidence};
   const files={};for(const name of ['/usr/local/bin/python','/usr/bin/cmdalt'])files[name]={stat:metadata(owner.stat(name)),lstat:metadata(owner.lstat(name))};
   return {qualified:true,subject:sm,ofd:ofdEvidence,files,volumes:owner._mounts.map(m=>({prefix:m.prefix,identity:owner.getVolumeIdentity(m.prefix)}))};
  });
 }
 function wrapped(pcb,op,req){
  try{counts[op]=(counts[op]||0)+1;if(!first){first=true;emit('first-fsRpc',{op,prototypeEqual:proto._fsRpc===wrapped,instanceEqual:this._fsRpc===wrapped,moduleEqual:require(kernelPath)===K});}}
  catch(e){fail(e);}
  if(op!==K.OP.FS_CHMOD && op!==K.OP.FS_FCHMOD)return original.apply(this,arguments);
  const kernel=this,id=++operation;let full=null,responses=0,returned=false,thrown=null;
  try{full=op===K.OP.FS_CHMOD?kernel._pathFor(pcb,req.path):null;
   emit('condition',{id,op,path:req.path,pathType:typeof req.path,mode:req.mode,modeType:typeof req.mode,maskedMode:req.mode&0o777,fd:req.fd,guestPid:pcb.pid,cwd:pcb.cwd,full,
    oldPredicates:{opcode:op===K.OP.FS_CHMOD,path:full==='/usr/local/bin/python',mode:(req.mode&0o777)===0o755},prototypeEqual:proto._fsRpc===wrapped,instanceEqual:kernel._fsRpc===wrapped});
  }catch(e){fail(e);}
  const descriptor=Object.getOwnPropertyDescriptor(kernel,'_respond'),respond=kernel._respond;
  function tapped(target,reply){
   // No product response can be lost to instrumentation failure.
   try{
    if(target===pcb){responses++;const success=!!reply&&!reply.errno;
     let observed=null;if(success)observed=snapshot(kernel,pcb,op,req,full);
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
