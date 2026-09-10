'use strict';
const fs=require('fs');
const evidence=require('../objc/exceptions-evidence.js')('node');
(async()=>{
  try {
    const C=require('../../compiler.js'),host=require('../../host.js');
    const corpus=require('../objc/exceptions.js'),foundation=require('../foundation/corpus.js'),files=require('../foundation/files.js');
    const records=await corpus.run(C,host,foundation,files,()=>({fs}),r=>evidence.record(r),(r,b)=>evidence.bytes(r,b));
    evidence.finish(null);console.log('PASS Objective-C exceptions:',records.length,'checks');
  } catch(error){evidence.finish(error);throw error;}
})().catch(error=>{console.error(error);process.exitCode=1;});
