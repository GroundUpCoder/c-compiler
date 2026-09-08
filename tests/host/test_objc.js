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
  for (const program of round2.crossPrograms) for (const noInline of [false,true]) for (const order of program.orders) {
    const files=program.files;
    const pp=C.createDefaultPPRegistry();
    pp.includePaths.push('.');
    const vfs={readFileSync: name => { const key=path.basename(name); if (!(key in files)) throw Error(name); return files[key]; }, existsSync: name => path.basename(name) in files};
    pp.fileReader=name=>files[path.basename(name)] ?? null;
    const options={compilerOptions:{gcSections:true,noInline},warningFlags:{},writeErr:s=>{throw Error(s);}};
    const units=C.parseAllUnits(vfs,pp,order,options);
    assert.deepStrictEqual(C.linkTranslationUnits(units, options.compilerOptions).errors, []);
    const bytes=C.generateCode(units,'cross.wasm',options);
    assert.equal(await runModule({bytes,fs,args:['cross']}),0);
    console.log('PASS',program.name,order.join(','));
  }
  for (const [name, files, expected] of [
    ['forward-protocol-send', ['@protocol P; @interface A - (int)value; @end id<P> make(void); int main(void){return [make() value]!=7;}', '@protocol P - (double)value; @end @interface B<P> - (double)value; @end @implementation B - (double)value{return 7.0;} @end id<P> make(void){return guc_objc_alloc(B);}'], /ambiguous signature.*across translation units/],
    ['dynamic-linked-signatures', ['@interface A - (int)value; @end id make(void); int main(void){return [make() value]!=7;}', '@interface B - (double)value; @end @implementation B - (double)value{return 7.0;} @end id make(void){return guc_objc_alloc(B);}'], /ambiguous signature.*across translation units/],
    ['dynamic-protocol-schema', ['@protocol P - (int)value; @end id<P> make(void); int main(void){id<P> p=make();return [p value]!=7;}', '@protocol P - (double)value; @end @interface A<P> - (double)value; @end @implementation A - (double)value{return 7.0;} @end id<P> make(void){return guc_objc_alloc(A);}'], /inconsistent Objective-C protocol/],
    ['declared-missing-method', ['@interface A - (int)value; @end int main(void){A*a=guc_objc_alloc(A);return [a value];}', '@interface A @end @implementation A @end'], /Objective-C method.*no implementation/],
    ['layout', ['@interface A {int x;} @end @implementation A @end', '@interface A {double x;} @end int main(void){return 0;}'], /inconsistent Objective-C layout/],
    ['inherited-signature', ['@interface A - (int)value; @end @implementation A - (int)value{return 7;} @end id make(void); int main(void){A *a=make();return [a value]!=7;}', '@interface A @end @interface B:A - (double)value; @end @implementation B - (double)value{return 7.0;} @end id make(void){return guc_objc_alloc(B);}'], /inconsistent Objective-C override/],
    ['protocol-missing-method', ['@protocol P - (int)value; @end @interface A<P> @end int main(void){return 0;}', '@interface A @end @implementation A @end'], /required protocol method.*no implementation/],
    ['protocol-signature', ['@protocol P - (int)value; @end @interface A<P> @end int main(void){A *a=guc_objc_alloc(A); return [a value]!=7;}', '@interface A @end @implementation A - (double)value{return 7.0;} @end'], /inconsistent Objective-C signature/],
    ['masked-signature', ['@interface A @end int unused(void){return 0;}', '@interface A - (int)value; @end int main(void){A *a=guc_objc_alloc(A); return [a value]!=7;}', '@interface A - (double)value; @end @implementation A - (double)value{return 7.0;} @end'], /inconsistent Objective-C signature/],
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
    const tokens=C.tokenize('metadata.m','@protocol P; @interface A @end @implementation A @end const id object; A *typed; const __unsafe_unretained id<P> qualified;', C.createDefaultPPRegistry());
    const parsed=C.parseTokens(tokens.tokens,{filename:'metadata.m'});
    assert.deepStrictEqual(parsed.errors,[]);
    const vars=parsed.translationUnit.definedVariables;
    const object=vars.find(v=>v.name==='object').type;
    const typed=vars.find(v=>v.name==='typed').type;
    assert.notEqual(object.removeQualifiers().constructor,C.Types.PointerType);
    assert.equal(object.removeQualifiers().ownership,'manual');
    assert.equal(typed.className,'A');
    const qualified=vars.find(v=>v.name==='qualified').type;
    assert.equal(qualified.removeQualifiers().ownership,'unsafe_unretained');
    assert.deepStrictEqual(qualified.removeQualifiers().addVolatile().protocols,['P']);
    assert.deepStrictEqual(object.protocols,[]);
    assert.equal(object.removeQualifiers().addVolatile().ownership,'manual');
    console.log('PASS frontend object-pointer metadata');
  }
  compile('@class Ghost; int main(void){return 0;}','forward-class-no-fold',{noFold:true});
  console.log('PASS forward-only class has no runtime dependency without optimization');
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
