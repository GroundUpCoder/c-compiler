'use strict';
const fs=require('fs');
const evidence=require('../foundation/arrays-evidence')('node');
(async()=>{
 try{
  const records=await require('../foundation/arrays-corpus').run(require('../../compiler'),require('../../host'),require('../foundation/files'),require('../foundation/corpus'),()=>({fs,trace:()=>{
   const old=Error.stackTraceLimit;try{Error.stackTraceLimit=256;return new Error('actual cleanup call stack').stack;}finally{Error.stackTraceLimit=old;}
  }}),r=>{evidence.record(r);console.log(r.status.toUpperCase(),r.name,r.noInline,r.gcSections,r.error||r.stdout||r.diagnostic||'');});
  evidence.finish(null);console.log('PASS Foundation arrays:',records.length,'records');
 }catch(e){evidence.finish(e);console.error(e);process.exitCode=1;}
})();
