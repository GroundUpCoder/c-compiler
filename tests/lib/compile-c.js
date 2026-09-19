'use strict';
// Compile an in-memory C program through the real source/link/codegen pipeline.
  function compile(C,files,inputs,opts={}) {
    const pp=C.createDefaultPPRegistry();
    pp.includePaths.push('/include','/tests');
    pp.fileReader=name=>files[name] ?? null;
    let diagnostics='';
    const options={compilerOptions:{gcSections:true,...opts},warningFlags:{},writeErr:s=>{diagnostics+=s;}};
    const fs={readFileSync:name=>{if(!(name in files)) throw Error('missing '+name);return files[name];},existsSync:name=>name in files};
    let units;
    try { units=C.parseAllUnits(fs,pp,inputs.map(n=>'/tests/'+n),options); } catch(e) { throw Error(diagnostics||e.message); }
    if(diagnostics) throw Error(diagnostics);
    const linked=C.linkTranslationUnits(units,options.compilerOptions);
    if(linked.errors.length) throw Error(linked.errors.map(e=>e.message).join('\n'));
    return {bytes:C.generateCode(units,'test.wasm',options),units};
  }
module.exports = {compile};
