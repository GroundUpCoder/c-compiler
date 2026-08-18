#!/usr/bin/env node
'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');const ROOT=path.resolve(__dirname,'../..');let fails=0;
function ok(n,x){console.log((x?'  ok   ':'  FAIL ')+n);if(!x)fails++;}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'gucedit-')),exe=path.join(tmp,'probe');
const c=cp.spawnSync('cc',['-std=c11','-Wall','-Wextra','-Werror','-DGUCEDIT_STANDALONE','tests/kernel/gucedit_probe.c','os/win32/gucedit_core.c','-o',exe],{cwd:ROOT,encoding:'utf8'});ok('executable ABI probe compiles',c.status===0,c.stderr);if(c.status===0){const r=cp.spawnSync(exe,[],{encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);ok('executable ABI validation matrix',r.status===0);}fs.rmSync(tmp,{recursive:true,force:true});
const h=fs.readFileSync(path.join(ROOT,'os/win32/gucedit.h'),'utf8');const u=fs.readFileSync(path.join(ROOT,'os/win32/user32.c'),'utf8');
ok('ABI v1 is private and fixed-size',/GUCEDIT_ABI_VERSION 1u/.test(h)&&/sizeof\(GUCEDIT_STYLE_V1\) == 20/.test(h));
ok('generation is exact-byte-change bound at EN_CHANGE',/memcmp\(st->buf, st->generationBytes/.test(u)&&/textGeneration/.test(u));
ok('stale generation has distinct error',/GUCEDIT_ERROR_STALE_GENERATION/.test(u));
ok('production delegates validation to executable core',/gucedit_check_batch\(b, st->buf/.test(u));
ok('production uses preservation-tested replacement core',/gucedit_replace_batch\(&st->styles/.test(u));
ok('destroy frees styles',/free\(st->styles\); st->styles = NULL/.test(u));
ok('selected mark layer uses highlight contrast',/COLOR_HIGHLIGHTTEXT/.test(u)&&/sp && \(sp->flags/.test(u));
ok('test allocator override is compile-time only',/#ifdef GUCEDIT_TEST/.test(u)&&/#define gucedit_alloc malloc/.test(u));
const wasm=path.join(os.tmpdir(),`gucedit-prod-${process.pid}.wasm`),bc=cp.spawnSync('node',['compiler.js','os/sedit/bin.json','-o',wasm],{cwd:ROOT,encoding:'utf8'});let absent=false;if(bc.status===0){const mod=new WebAssembly.Module(fs.readFileSync(wasm)),names=WebAssembly.Module.exports(mod).map(x=>x.name);absent=!names.some(x=>x.includes('gucedit_test_fail_alloc')||x.includes('sedit_document_test_io'));fs.rmSync(wasm,{force:true});}ok('baked production has no test override export',bc.status===0&&absent);
process.exit(fails?1:0);
