#!/usr/bin/env node
'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');const ROOT=path.resolve(__dirname,'../..');let fails=0;
function ok(n,x){console.log((x?'  ok   ':'  FAIL ')+n);if(!x)fails++;}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'gucedit-')),exe=path.join(tmp,'probe');
const c=cp.spawnSync('cc',['-std=c11','-Wall','-Wextra','-Werror','-DGUCEDIT_STANDALONE','tests/kernel/gucedit_probe.c','os/win32/gucedit_core.c','-o',exe],{cwd:ROOT,encoding:'utf8'});ok('executable ABI probe compiles',c.status===0,c.stderr);if(c.status===0){const r=cp.spawnSync(exe,[],{encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);ok('executable ABI validation matrix',r.status===0);}fs.rmSync(tmp,{recursive:true,force:true});
const h=fs.readFileSync(path.join(ROOT,'os/win32/gucedit.h'),'utf8');
ok('ABI v1 is private and fixed-size',/GUCEDIT_ABI_VERSION 1u/.test(h)&&/sizeof\(GUCEDIT_STYLE_V1\) == 20/.test(h));
// #729: the six regex.test(<user32.c source>) legs that stood here were
// mutation-proven inert (a dead comment kept them green). The mechanisms they
// named execute now: the generation step and batch check/replace run in the
// probe above (gucedit_generation_advance was extracted for exactly that),
// and the wired pipeline — EN_CHANGE generation advance, GEM_SETSTYLES
// validation, styled paint — is pinned end to end by test_sedit_e2e's big-file
// highlight shot and os-sedit.mjs. The compile-time-only allocator override
// keeps its behavioural half below: the baked wasm exports no test symbol.
const wasm=path.join(os.tmpdir(),`gucedit-prod-${process.pid}.wasm`),bc=cp.spawnSync('node',['compiler.js','os/sedit/bin.json','-o',wasm],{cwd:ROOT,encoding:'utf8'});let absent=false;if(bc.status===0){const mod=new WebAssembly.Module(fs.readFileSync(wasm)),names=WebAssembly.Module.exports(mod).map(x=>x.name);absent=!names.some(x=>x.includes('gucedit_test_fail_alloc')||x.includes('sedit_document_test_io'));fs.rmSync(wasm,{force:true});}ok('baked production has no test override export',bc.status===0&&absent);
process.exit(fails?1:0);
