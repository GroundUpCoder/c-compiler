'use strict';
const fs=require('fs'),path=require('path');

// Each invocation owns an append-only attempt directory. Publish running before
// compilation, checkpoint failures too, and never overwrite another attempt.
module.exports=function beginEvidence(host) {
  const base=path.resolve(__dirname,'../../build/777');
  fs.mkdirSync(base,{recursive:true});
  const directory=fs.mkdtempSync(path.join(base,'foundation-'+host+'-'+Date.now()+'-'));
  const target=path.join(directory,'run.json');
  const state={runId:path.basename(directory),start:new Date().toISOString(),status:'running',records:[]};
  function save() {
    fs.writeFileSync(target+'.tmp',JSON.stringify(state,null,2)+'\n');
    fs.renameSync(target+'.tmp',target);
  }
  save();
  console.log('Foundation evidence:',target);
  return {
    record(record) {state.records.push(record);save();},
    finish(error,metadata={}) {
      Object.assign(state,metadata,{end:new Date().toISOString(),status:error?'fail':'pass'});
      if(error) state.error=error.stack||String(error);
      save();
    }
  };
};
