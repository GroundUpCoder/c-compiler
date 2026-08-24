#!/usr/bin/env node
'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const ROOT=path.resolve(__dirname,'../..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'sedit-core-'));
const exe=path.join(tmp,'probe');
const c=cp.spawnSync('cc',['-std=c11','-Wall','-Wextra','-Werror','-fsanitize=address','-DSEDIT_TEST','-DGUCEDIT_STANDALONE','-I.',
  'tests/kernel/sedit_core_probe.c','os/sedit/c_lex.c','os/sedit/document.c','os/sedit/styles.c','os/win32/gucedit_core.c','-o',exe],{cwd:ROOT,encoding:'utf8'});
if(c.status!==0){console.error(c.stdout+c.stderr);process.exit(1);}
// #729: the regex-over-sedit.c "scan bounds" check that stood here was
// mutation-proven inert (an unbounded rewrite stayed green). The bounds now
// EXECUTE in the probe: sedit_scan_turn — the extracted turn the production
// restyle_step calls — runs under an injected clock (byte cap, chunk
// granularity, time cap, one-feed equality); the posted-turn wiring is pinned
// by test_sedit_e2e's big-file highlight shot, which needs multiple turns.
const r=cp.spawnSync(exe,[tmp,path.join(ROOT,'vendor/sqlite/sqlite3.h')],{encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);if(r.signal)console.log('FAIL probe killed by '+r.signal);fs.rmSync(tmp,{recursive:true,force:true});process.exit((r.status!==0||r.signal)?1:0);
