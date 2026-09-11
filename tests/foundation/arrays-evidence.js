'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process');
module.exports=function(kind){
 const root=path.resolve(__dirname,'../..'),base=path.join(root,'build/779');fs.mkdirSync(base,{recursive:true});
 const directory=fs.mkdtempSync(path.join(base,kind+'-'));
 const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
 const files=require('./files');
 const state={start:new Date().toISOString(),status:'running',head:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),node:process.execPath,nodeSha256:hash(fs.readFileSync(process.execPath)),sourcePins:{},inputs:{},records:[]};
 for(const f of ['compiler.js','host.js','os/image.json','os/foundation/lib.json','packages/foundation.json','tests/host/run.js','tests/kernel/run.js',
  'tests/foundation/arrays-corpus.js','tests/foundation/arrays-evidence.js','tests/foundation/arrays-browser.mjs','tests/foundation/arrays-os.js',
  'tests/foundation/corpus.js','tests/foundation/files.js','tests/host/test_foundation_arrays.js','tests/kernel/test_foundation_arrays_e2e.js','tests/browser/os-foundation-arrays.mjs'])
  state.sourcePins[f]=hash(fs.readFileSync(path.join(root,f)));
 for(const [f,bytes] of Object.entries(files))state.inputs[f]=hash(bytes);
 function save(){fs.writeFileSync(path.join(directory,'run.json.tmp'),JSON.stringify(state,null,2)+'\n');fs.renameSync(path.join(directory,'run.json.tmp'),path.join(directory,'run.json'));}
 save();console.log('Arrays evidence:',directory);
 return {directory,record(record){
  const r={...record};
  if(r.wasm){const bytes=Buffer.from(r.wasm);r.wasmSha256=hash(bytes);r.wasmPath=r.name+'-'+r.noInline+'-'+r.gcSections+'.wasm';fs.writeFileSync(path.join(directory,r.wasmPath),bytes);delete r.wasm;}
  state.records.push(r);save();
 },finish(error,metadata={}){Object.assign(state,metadata,{end:new Date().toISOString(),status:error?'fail':'pass',done:!error});if(error)state.error=error.stack||String(error);save();}};
};
