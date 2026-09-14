#!/usr/bin/env node
'use strict';
// Compiled real WM event-policy regression with a deterministic socket seam.
// No OS boot or manual/browser evidence.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),C=require('../../compiler.js');
const common=require('../../os/os-common.js'),run=require('../../host.js');
const prefix='#include "wm_proto.h"\nstatic int test_read(int,void*,int);\nstatic int test_send(int,uint32_t,const int32_t*,int);\n#define wmp_read_all test_read\n#define wmp_send test_send\n#define main wm_application_main\n';
const suffix=fs.readFileSync(path.join(__dirname,'wm_lifecycle_policy_probe.c'),'utf8');
const bytes=common.buildProject(C,'os/wm.json',p=>{
 const source=fs.readFileSync(path.join(root,p),'utf8');
 return p==='os/wm.c'?prefix+source+'\n'+suffix:source;
});
(async()=>{
 let out='',err='';
 const block=run.BLOCK_FS.create(new run.BLOCK_FS.MemoryByteStore(4<<20));
 const code=await run({bytes,args:['wm-policy'],blockFsFactory:ctx=>({c:block.toWasmEnv(ctx)}),writeOut:s=>{out+=typeof s==='string'?s:new TextDecoder().decode(s);},writeErr:s=>{err+=typeof s==='string'?s:new TextDecoder().decode(s);}});
 process.stdout.write(out);process.stderr.write(err);assert.equal(code,0);assert.match(out,/WM-LIFECYCLE-POLICY failures=0/);
})().catch(e=>{console.error(e);process.exitCode=1;});
