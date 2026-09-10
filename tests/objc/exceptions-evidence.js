'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process');
module.exports=function(host) {
  const root=path.resolve(__dirname,'../..'),base=path.join(root,'build/objc781');
  fs.mkdirSync(base,{recursive:true});
  const directory=fs.mkdtempSync(path.join(base,host+'-'+Date.now()+'-'));
  const pins={};
  for(const file of ['compiler.js','host.js','tests/host/run.js','tests/host/test_async_lifecycle.js','tests/objc/exceptions.js','tests/objc/exceptions-evidence.js',
    'tests/host/test_objc_exceptions.js','tests/objc/exceptions-browser.mjs','tests/foundation/corpus.js',
    'tests/foundation/files.js','tests/objc/exceptions-os.js','tests/kernel/test_objc_exceptions_e2e.js','tests/browser/os-objc-exceptions.mjs',...fs.readdirSync(path.join(root,'os/foundation')).filter(n=>/\.(m|h)$/.test(n)).map(n=>'os/foundation/'+n)])
    if(fs.existsSync(path.join(root,file))) pins[file]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
  const state={start:new Date().toISOString(),head:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),pins,status:'running',records:[]};
  const key=r=>r.name+JSON.stringify(r.options||{});
  function save(){fs.writeFileSync(path.join(directory,'run.json'),JSON.stringify(state,null,2)+'\n');}
  save();console.log('Objective-C exception evidence:',directory);
  return {
    record(r){const i=state.records.findIndex(v=>key(v)===key(r));if(i<0)state.records.push({...r});else state.records[i]={...r};save();},
    bytes(r,bytes){fs.writeFileSync(path.join(directory,state.records.length+'-'+r.name+'.wasm'),bytes);},
    finish(error,extra={}){Object.assign(state,extra,{done:!error,end:new Date().toISOString(),status:error?'fail':'pass'});if(error)state.error=error.stack||String(error);save();}
  };
};
