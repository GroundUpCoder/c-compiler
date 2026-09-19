/* #777: portable tests compile the real library on each host. */
(function(root) {
  'use strict';
  const programs = [
    ...['ownership','pools','identity','scope','immortals','reentrant-growth','scope-flow','scope-snapshot','strings','strings-codec','string-exceptions','string-cleanup','string-bounds'].map(name=>({name,inputs:[name+'.m']})),
    {name:'missing-pool',inputs:['missing-pool.m'],stderr:/autorelease without a pool/},
    {name:'cross-forward',inputs:['cross-main.m','cross-a.m','cross-b.m']},
    {name:'cross-reverse',inputs:['cross-b.m','cross-a.m','cross-main.m']},
    {name:'literal-forward',inputs:['literal-a.m','literal-b.m','literal-inspect.m','literal-main.m']},
    {name:'literal-reverse',inputs:['literal-main.m','literal-inspect.m','literal-b.m','literal-a.m']},
    {name:'exhaustion',inputs:['exhaustion.m'],limitMemory:true},
    {name:'strings-exhaustion',inputs:['strings-exhaustion.m'],limitMemory:true},
    {name:'string-exception-exhaustion',inputs:['string-exception-exhaustion.m'],limitMemory:true},
    {name:'string-diagnostic-exhaustion',inputs:['string-diagnostic-exhaustion.m'],limitMemory:true,failureExit:134,failure:/NSString: cannot allocate exception/},
    {name:'string-bounds-diagnostic-exhaustion',inputs:['string-diagnostic-exhaustion.m'],args:['bounds'],limitMemory:true,failureExit:134,failure:/NSString: cannot allocate exception/},
    {name:'bookkeeping-failure',inputs:['bookkeeping-failure.m'],limitMemory:true,failure:/cannot allocate autorelease bookkeeping/},
    {name:'scoped-failure',inputs:['scoped-failure.m'],limitMemory:true,failure:/cannot allocate scoped autorelease pool/},
    ...['pools cannot be retained','pools cannot be autoreleased','recursive drain'].map((message,i)=>({name:'misuse-'+i,inputs:['misuse.m'],args:[String(i)],failure:new RegExp(message)}))
  ];
  const negative = [
    ['goto-in','int main(void){goto entry; @autoreleasepool {entry:;} return 0;}',/goto cannot enter/],
    ['goto-sibling','int main(void){@autoreleasepool {goto entry;} @autoreleasepool {entry:;} return 0;}',/goto cannot enter/],
    ['switch-in','int main(void){switch(1){@autoreleasepool {case 1: break;}} return 0;}',/case dispatch cannot enter/]
  ];
  function compile(C,files,inputs,opts={}) {
    const pp=C.createDefaultPPRegistry();
    pp.includePaths.push('/include','/tests');
    pp.sourceRoots.push({prefix:'foundation',dir:'/lib'});
    pp.fileReader=name=>files[name] ?? null;
    let diagnostics='';
    const options={compilerOptions:{gcSections:true,...opts},warningFlags:{},writeErr:s=>{diagnostics+=s;}};
    const fs={readFileSync:name=>{if(!(name in files)) throw Error('missing '+name);return files[name];},existsSync:name=>name in files};
    let units;
    try { units=C.parseAllUnits(fs,pp,inputs.map(n=>'/tests/'+n),options); } catch(e) { throw Error(diagnostics||e.message); }
    if(diagnostics) throw Error(diagnostics);
    const linked=C.linkTranslationUnits(units,options.compilerOptions);
    if(linked.errors.length) throw Error(linked.errors.map(e=>e.message).join('\n'));
    return {bytes:C.generateCode(units,'foundation.wasm',options),units};
  }
  // Set only the Wasm memory declaration's maximum to its initial minimum.
  // Instructions/data remain intact; allocation failures exercise real libc.
  function capMemory(bytes) {
    let p=8; const output=Array.from(bytes.subarray(0,8));
    const read=()=>{let value=0,shift=0,b;do{b=bytes[p++];value+=(b&127)*2**shift;shift+=7;}while(b&128);return value;};
    const leb=n=>{const a=[];do{let b=n&127;n=Math.floor(n/128);a.push(b|(n?128:0));}while(n);return a;};
    while(p<bytes.length) {
      const start=p,id=bytes[p++],size=read(),end=p+size;
      if(id===5) {
        const count=read(),flags=read(),minimum=read();
        if(count!==1 || flags!==0) throw Error('unexpected memory declaration');
        const payload=[1,1,...leb(minimum),...leb(minimum)];
        output.push(5,...leb(payload.length),...payload);
      } else for(let i=start;i<end;i++) output.push(bytes[i]);
      p=end;
    }
    return new Uint8Array(output);
  }
  async function run(C,runModule,files,environment,onRecord=()=>{}) {
    const records=[];
    const text=s=>typeof s==='string'?s:new TextDecoder().decode(s);
    for(const noInline of [false,true]) for(const gcSections of [false,true]) for(const program of programs) {
      const record={name:program.name,noInline,gcSections};
      try {
        let {bytes}=compile(C,files,program.inputs,{noInline,gcSections});
        if(program.limitMemory) bytes=capMemory(bytes);
        if(!WebAssembly.validate(bytes)) throw Error('invalid module '+program.name);
        let stdout='',stderr='';
        const exit=await runModule({bytes,args:[program.name,...(program.args||[])],...environment(),writeOut:s=>{stdout+=text(s);},writeErr:s=>{stderr+=text(s);}});
        Object.assign(record,{exit,stdout,stderr});
        if(program.failure) {
          if(exit===0 || exit===2 || (program.failureExit!==undefined && exit!==program.failureExit) || !program.failure.test(stderr)) throw Error(program.name+': wrong failure '+exit+' '+stderr);
        } else if(exit!==0 || !/FOUNDATION .* PASS/.test(stdout) || (program.stderr ? !program.stderr.test(stderr) : !!stderr)) {
          throw Error(program.name+': exit '+exit+' stdout='+stdout+' stderr='+stderr);
        }
        record.status='pass';
      } catch(error) {
        Object.assign(record,{status:'fail',error:error.stack||String(error)});
        records.push(record);await onRecord(record);throw error;
      }
      records.push(record);await onRecord(record);
    }
    for(const [name,source,expected] of negative) {
      let error='';try{compile(C,{...files,['/tests/refusal.m']:source},['refusal.m']);}catch(e){error=e.message;}
      const passed=expected.test(error);
      const record={name,refused:passed,error,status:passed?'pass':'fail'};
      records.push(record);await onRecord(record);
      if(!passed) throw Error(name+': wrong refusal '+error);
    }
    return records;
  }
  const api={programs,negative,compile,capMemory,run};
  if(typeof module!=='undefined') module.exports=api; else root.FoundationCorpus=api;
})(typeof globalThis!=='undefined'?globalThis:this);
