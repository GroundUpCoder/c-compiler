'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../../compiler.js');
const runModule = require('../../host.js');
const cases = require('../objc/cases.js');
const round2 = require('../objc/round2.js');
function compile(source, name, extra = {}) {
  if (!name.endsWith('.c')) name += '.m';
  const pp = C.createDefaultPPRegistry();
  let diagnostics = "";
  const options = { compilerOptions: { gcSections: true, ...extra }, warningFlags: {}, writeErr: s => { diagnostics += s; } };
  let units;
  try { units = C.parseAllUnits({ readFileSync: () => source }, pp, [name], options); }
  catch(e) { throw Error(diagnostics || e.message); }
  if (diagnostics) throw Error(diagnostics);
  const link = C.linkTranslationUnits(units, options.compilerOptions);
  assert.deepStrictEqual(link.errors, []);
  return C.generateCode(units, name + '.wasm', options);
}
async function main() {
  const positives = [['core', fs.readFileSync(path.join(__dirname, '../objc/core.m'), 'utf8')], ...cases.positive, ...round2.positive];
  for (const noInline of [false, true]) for (const [name, source] of positives) {
    const bytes = compile(source, name, { noInline });
    assert(WebAssembly.validate(bytes));
    const exit = await runModule({ bytes, fs, args: [name], writeOut: () => {}, writeErr: s => { throw Error(s); } });
    assert.strictEqual(exit, 0, name);
    console.log('PASS', name, noInline ? 'no-inline' : 'default');
  }
  for (const [name, source, expected] of [...cases.negative, ...round2.negative]) {
    assert.throws(() => compile(source, name), expected, name);
    console.log('PASS refusal', name);
  }
  for (const noInline of [false,true]) for (const order of [['base.m','sub.m','main.m'], ['main.m','sub.m','base.m']]) {
    const files=round2.crossTU;
    const pp=C.createDefaultPPRegistry();
    pp.includePaths.push('.');
    const vfs={readFileSync: name => { const key=path.basename(name); if (!(key in files)) throw Error(name); return files[key]; }, existsSync: name => path.basename(name) in files};
    pp.fileReader=name=>files[path.basename(name)] ?? null;
    const options={compilerOptions:{gcSections:true,noInline},warningFlags:{},writeErr:s=>{throw Error(s);}};
    const units=C.parseAllUnits(vfs,pp,order,options);
    assert.deepStrictEqual(C.linkTranslationUnits(units, options.compilerOptions).errors, []);
    const bytes=C.generateCode(units,'cross.wasm',options);
    assert.equal(await runModule({bytes,fs,args:['cross']}),0);
    console.log('PASS cross-TU',order.join(','));
  }
  for (const [name, files, expected] of [
    ['layout', ['@interface A {int x;} @end @implementation A @end', '@interface A {double x;} @end int main(void){return 0;}'], /inconsistent Objective-C layout/],
    ['signature', ['@interface A - (int)x; @end @implementation A - (int)x{return 0;} @end', '@interface A - (double)x; @end int main(void){return 0;}'], /inconsistent Objective-C signature/],
    ['duplicate', ['@interface A @end @implementation A @end', '@interface A @end @implementation A @end int main(void){return 0;}'], /Duplicate definition/],
    ['missing', ['@interface A @end int main(void){return guc_objc_alloc(A)==0;}'], /Undefined symbol.*class_A/],
  ]) {
    const options={compilerOptions:{},warningFlags:{},writeErr:s=>{throw Error(s);}};
    const units=C.parseAllUnits({readFileSync: p=>files[parseInt(p)]}, C.createDefaultPPRegistry(), files.map((_,i)=>i+'.m'),options);
    const errors=C.linkTranslationUnits(units,options.compilerOptions).errors;
    assert(errors.some(e=>expected.test(e.message)), name+': '+JSON.stringify(errors));
    console.log('PASS cross-TU refusal',name);
  }
  {
    const tokens=C.tokenize('metadata.m','@interface A @end @implementation A @end const id object; A *typed;', C.createDefaultPPRegistry());
    const parsed=C.parseTokens(tokens.tokens,{filename:'metadata.m'});
    assert.deepStrictEqual(parsed.errors,[]);
    const vars=parsed.translationUnit.definedVariables;
    const object=vars.find(v=>v.name==='object').type;
    const typed=vars.find(v=>v.name==='typed').type;
    assert.notEqual(object.removeQualifiers().constructor,C.Types.PointerType);
    assert.equal(object.removeQualifiers().ownership,'manual');
    assert.equal(typed.className,'A');
    assert.deepStrictEqual(object.protocols,[]);
    assert.equal(object.removeQualifiers().addVolatile().ownership,'manual');
    console.log('PASS frontend object-pointer metadata');
  }
  const pp = C.createDefaultPPRegistry();
  pp.defines.set('DECL', '@NAME'); pp.defines.set('NAME', 'interface');
  const macro = C.tokenize('define.m', 'DECL A @end @implementation A @end', pp);
  assert.equal(macro.errors.length, 0);
  assert.equal(C.parseTokens(macro.tokens, { filename: 'define.m' }).errors.length, 0);
  assert(!pp.defines.has('__OBJC__'));
  const c = C.tokenize('ordinary.c', '@interface A\n@end', pp);
  assert(c.errors.length, 'C must continue rejecting Objective-C');
  const aggregate = compile(fs.readFileSync(path.join(__dirname, '../objc/aggregate-abi.c'), 'utf8'), 'aggregate-abi.c');
  assert.equal(await runModule({ bytes: aggregate, fs, args: ['aggregate-abi.c'] }), 0);
  console.log('PASS C-only aggregate ABI control (not Objective-C support)');
  console.log('PASS C-mode isolation');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
