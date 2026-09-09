'use strict';
const fs=require('fs');
const evidence=require('../foundation/evidence.js')('node');
(async()=>{
  try {
    const C=require('../../compiler.js'),runModule=require('../../host.js');
    const corpus=require('../foundation/corpus.js'),files=require('../foundation/files.js');
    const records=await corpus.run(C,runModule,files,()=>({fs}),record=>evidence.record(record));
    evidence.finish(null);
    for(const record of records) console.log('PASS',record.name,record.noInline,record.gcSections);
  } catch(error) {evidence.finish(error);throw error;}
})().catch(e=>{console.error(e);process.exitCode=1;});
