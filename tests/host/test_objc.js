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
  for (const order of [['base.m','sub.m','main.m'], ['main.m','sub.m','base.m']]) {
    const files=round2.crossTU;
    const pp=C.createDefaultPPRegistry();
    pp.includePaths.push('.');
    const vfs={readFileSync: name => { const key=path.basename(name); if (!(key in files)) throw Error(name); return files[key]; }, existsSync: name => path.basename(name) in files};
    pp.fileReader=name=>files[path.basename(name)] ?? null;
    const options={compilerOptions:{gcSections:true},warningFlags:{},writeErr:s=>{throw Error(s);}};
    const units=C.parseAllUnits(vfs,pp,order,options);
    assert.deepStrictEqual(C.linkTranslationUnits(units, options.compilerOptions).errors, []);
    const bytes=C.generateCode(units,'cross.wasm',options);
    assert.equal(await runModule({bytes,fs,args:['cross']}),0);
    console.log('PASS cross-TU',order.join(','));
  }
  const pp = C.createDefaultPPRegistry();
  pp.defines.set('DECL', '@NAME'); pp.defines.set('NAME', 'interface');
  const macro = C.tokenize('define.m', 'DECL A @end @implementation A @end', pp);
  assert.equal(macro.errors.length, 0);
  assert.equal(C.parseTokens(macro.tokens, { filename: 'define.m' }).errors.length, 0);
  assert(!pp.defines.has('__OBJC__'));
  const c = C.tokenize('ordinary.c', '@interface A\n@end', pp);
  assert(c.errors.length, 'C must continue rejecting Objective-C');
  assert.throws(() => C.parseAllUnits({}, pp, ['a.m', 'b.m'], { compilerOptions: {} }), /one .m/);
  const aggregate = compile(fs.readFileSync(path.join(__dirname, '../objc/aggregate-abi.c'), 'utf8'), 'aggregate-abi.c');
  assert.equal(await runModule({ bytes: aggregate, fs, args: ['aggregate-abi.c'] }), 0);
  console.log('PASS C-only aggregate ABI control (not Objective-C support)');
  console.log('PASS C-mode and multi-TU refusal');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
