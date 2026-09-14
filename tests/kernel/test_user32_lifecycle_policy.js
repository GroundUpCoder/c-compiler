#!/usr/bin/env node
'use strict';
// Compile actual user32.c with synthetic HWNDs and only SDL lifecycle intercepted.
// No boot, bake, browser, native Windows or manual-interaction evidence.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),C=require('../../compiler.js');
const common=require('../../os/os-common.js'),run=require('../../host.js');
const prefix=`#include <windows.h>
#include <SDL3/SDL.h>
static bool test_show(SDL_Window*);
static bool test_hide(SDL_Window*);
static bool test_raise(SDL_Window*);
static bool test_parent(SDL_Window*, SDL_Window*);
static bool test_size(SDL_Window*,int,int);
#define SDL_ShowWindow test_show
#define SDL_HideWindow test_hide
#define SDL_RaiseWindow test_raise
#define SDL_SetWindowSize test_size
#define SDL_SetWindowParent test_parent
`;
const suffix=fs.readFileSync(path.join(__dirname,'user32_lifecycle_policy_probe.c'),'utf8');
const bytes=common.buildProject(C,'tests/lifecycle-policy.json',p=>{
 if(p==='tests/lifecycle-policy.json')return JSON.stringify({type:'bin',deps:['../os/win32/lib.json'],sources:[]});
 const source=fs.readFileSync(path.join(root,p),'utf8');
 return p==='os/win32/user32.c'?prefix+source+'\n'+suffix:source;
});
(async()=>{
 let out='',err='';
 const block=run.BLOCK_FS.create(new run.BLOCK_FS.MemoryByteStore(4<<20));
 const code=await run({bytes,args:['user32-policy'],blockFsFactory:ctx=>({c:block.toWasmEnv(ctx)}),writeOut:s=>{out+=typeof s==='string'?s:new TextDecoder().decode(s);},writeErr:s=>{err+=typeof s==='string'?s:new TextDecoder().decode(s);}});
 process.stdout.write(out);process.stderr.write(err);assert.equal(code,0);assert.match(out,/USER32-LIFECYCLE-POLICY failures=0/);
 const query=common.buildProject(C,'os/wmctl.json',p=>{
  const source=fs.readFileSync(path.join(root,p),'utf8');
  return p==='os/wmctl.c'?'#define main wmctl_application_main\n'+source+'\n'+fs.readFileSync(path.join(__dirname,'wmctl_visibility_policy_probe.c'),'utf8'):source;
 });
 let queryOut='';
 const queryCode=await run({bytes:query,args:['wmctl-policy'],blockFsFactory:ctx=>({c:block.toWasmEnv(ctx)}),writeOut:s=>{queryOut+=typeof s==='string'?s:new TextDecoder().decode(s);}});
 process.stdout.write(queryOut);assert.equal(queryCode,0);assert.match(queryOut,/WMCTL-VISIBILITY-POLICY failures=0/);
})().catch(e=>{console.error(e);process.exitCode=1;});
