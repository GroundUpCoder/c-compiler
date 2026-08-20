#!/usr/bin/env node
'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const ROOT=path.resolve(__dirname,'../..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'sedit-core-'));
const exe=path.join(tmp,'probe');
const c=cp.spawnSync('cc',['-std=c11','-Wall','-Wextra','-Werror','-fsanitize=address','-DSEDIT_TEST','-DGUCEDIT_STANDALONE','-I.',
  'tests/kernel/sedit_core_probe.c','os/sedit/c_lex.c','os/sedit/document.c','os/sedit/styles.c','os/win32/gucedit_core.c','-o',exe],{cwd:ROOT,encoding:'utf8'});
if(c.status!==0){console.error(c.stdout+c.stderr);process.exit(1);}
const r=cp.spawnSync(exe,[tmp,path.join(ROOT,'vendor/sqlite/sqlite3.h')],{encoding:'utf8'});process.stdout.write(r.stdout);process.stderr.write(r.stderr);if(r.signal)console.log('FAIL probe killed by '+r.signal);const app=fs.readFileSync(path.join(ROOT,'os/sedit/sedit.c'),'utf8');const bounded=/end=scan_off\+32768/.test(app)&&/scan_off-turn_start<262144/.test(app)&&/8000000LL/.test(app)&&/PostMessage\(win,WM_RESTYLE/.test(app);console.log((bounded?'ok ':'FAIL ')+'byte, time, and posted-turn scan bounds');fs.rmSync(tmp,{recursive:true,force:true});process.exit((r.status!==0||r.signal)?1:(!bounded?1:0));
