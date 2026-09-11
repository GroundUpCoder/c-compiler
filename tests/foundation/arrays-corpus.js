/* #779: real collection storage and compiler enumeration, shared across hosts. */
(function(root) {
 'use strict';
 const programs=['arrays','array-cleanup','array-enumeration','array-subclasses','array-reentrancy','array-provider'].map(name=>({name,inputs:[name+'.m']}));
 programs.push(
  {name:'array-cross-forward',inputs:['array-cross-main.m','array-cross-a.m','array-cross-b.m'],marker:'array-cross'},
  {name:'array-cross-reverse',inputs:['array-cross-b.m','array-cross-a.m','array-cross-main.m'],marker:'array-cross'},
  {name:'array-uncaught-mutation',inputs:['array-failure.m'],failure:/uncaught Objective-C exception/},
  {name:'array-capacity-overflow',inputs:['array-failure.m'],args:['c'],failure:/NSArray: allocation or capacity exhausted/},
  {name:'array-allocation-exhaustion',inputs:['array-failure.m'],args:['a'],capMemory:true,failure:/NSArray: allocation or capacity exhausted/}
 );
 const negatives=[
  ['number-target','for(int x in a){}',/for-in target must be a modifiable object pointer/],
  ['const-target','for(id const x in a){}',/for-in target must be a modifiable object pointer/],
  ['multiple-targets','for(id x,y in a){}',/for-in requires one uninitialized object declaration/],
  ['initialized-target','for(id x=nil in a){}',/for-in requires one uninitialized object declaration/],
  ['number-collection','for(id x in 1){}',/for-in collection must be an object pointer/],
  ['nonlvalue','for((id)0 in a){}',/expression is not assignable/],
  ['goto-entry','goto entry;for(id x in a){entry:;}',/goto cannot enter an Objective-C protected scope/],
  ['case-entry','switch(1){for(id x in a){case 1:break;}}',/case dispatch cannot enter an Objective-C protected scope/]
 ];
 async function run(C,host,files,base,environment,onRecord=()=>{}) {
  const records=[];const decode=s=>typeof s==='string'?s:new TextDecoder().decode(s);
  for(const noInline of [false,true]) for(const gcSections of [false,true]) for(const p of programs) {
   const r={name:p.name,noInline,gcSections,status:'running'};
   try {
    let {bytes}=base.compile(C,files,p.inputs,{noInline,gcSections});
    if(p.capMemory)bytes=base.capMemory(bytes);
    if(!WebAssembly.validate(bytes))throw Error('invalid Wasm');
    r.wasm=Array.from(bytes);
    const env=environment();
    r.stdout='';r.stderr='';r.exit=await host({...env,bytes,args:[p.name,...(p.args||[])],writeOut:s=>{
      const text=decode(s);r.stdout+=text;
      if(env.trace && text.includes('ARRAY-CLEANUP-FRAME-PROBE=')) (r.stackSamples ||= []).push(env.trace());
    },writeErr:s=>r.stderr+=decode(s)});
    if(p.failure ? (r.exit!==134 || !p.failure.test(r.stderr)) : (r.exit!==0 || r.stderr || !r.stdout.includes('FOUNDATION '+(p.marker||p.name)+' PASS')))throw Error('unexpected result '+JSON.stringify(r));
    if(env.trace && p.name==='array-cleanup') {
      r.wasmStackFrames=(r.stackSamples||[]).map(s=>(s.match(/wasm-function/g)||[]).length);
      if(r.wasmStackFrames.length!==2 || r.wasmStackFrames.some(n=>n<10 || n>100))throw Error('missing or excessive cleanup stack sample');
    }
    r.status='pass';
   }catch(e){r.status='fail';r.error=e.stack||String(e);}
   records.push(r);await onRecord(r);
  }
  for(const [name,body,expected] of negatives) {
   const r={name,status:'running'};
   const source='#include <Foundation/Foundation.h>\nint main(){NSArray *a=[NSArray array];'+body+'return 0;}';
   try {base.compile(C,{...files,'/tests/refusal779.m':source},['refusal779.m']);r.error='compiled unexpectedly';}
   catch(e){r.diagnostic=e.message;r.status=expected.test(e.message)?'pass':'fail';}
   if(r.status==='running')r.status='fail';records.push(r);await onRecord(r);
  }
  for(const [name,source,expected] of [
   ['missing-provider','#define OMIT_PROVIDER\n'+files['/tests/array-provider.m'],/Undefined symbol 'objc_enumerationMutation' during linking/],
   ['bad-state',files['/tests/array-provider.m'].replace('extra[5]','extra[4]'),/requires the NSFastEnumeration state and method ABI/],
   ['bad-provider',files['/tests/array-provider.m'].replace('void objc_enumerationMutation','int objc_enumerationMutation'),/requires void objc_enumerationMutation/]
  ]) {
   const r={name,status:'fail'};
   try{base.compile(C,{...files,'/tests/provider-refusal.m':source},['provider-refusal.m']);r.error='compiled unexpectedly';}
   catch(e){r.diagnostic=e.message;r.status=expected.test(e.message)?'pass':'fail';}
   records.push(r);await onRecord(r);
  }
  if(records.some(r=>r.status!=='pass'))throw Error('Foundation arrays: '+records.filter(r=>r.status!=='pass').map(r=>r.name).join(', '));
  return records;
 }
 const api={programs,negatives,run};if(typeof module!=='undefined')module.exports=api;else root.FoundationArraysCorpus=api;
})(typeof globalThis!=='undefined'?globalThis:this);
