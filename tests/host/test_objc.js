'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../../compiler.js');
const runModule = require('../../host.js');
const cases = require('../objc/cases.js');
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
  const positives = [['core', fs.readFileSync(path.join(__dirname, '../objc/core.m'), 'utf8')], ...cases.positive];
  for (const noInline of [false, true]) for (const [name, source] of positives) {
    const bytes = compile(source, name, { noInline });
    assert(WebAssembly.validate(bytes));
    const exit = await runModule({ bytes, fs, args: [name], writeOut: () => {}, writeErr: s => { throw Error(s); } });
    assert.strictEqual(exit, 0, name);
    console.log('PASS', name, noInline ? 'no-inline' : 'default');
  }
  for (const [name, source, expected] of cases.negative) {
    assert.throws(() => compile(source, name), expected, name);
    console.log('PASS refusal', name);
  }
  const pp = C.createDefaultPPRegistry();
  const c = C.tokenize('ordinary.c', '@interface A\n@end', pp);
  assert(c.errors.length, 'C must continue rejecting Objective-C');
  assert.throws(() => C.parseAllUnits({}, pp, ['a.m', 'b.m'], { compilerOptions: {} }), /one .m/);
  const aggregate = compile(fs.readFileSync(path.join(__dirname, '../objc/aggregate-abi.c'), 'utf8'), 'aggregate-abi.c');
  assert.equal(await runModule({ bytes: aggregate, fs, args: ['aggregate-abi.c'] }), 0);
  console.log('PASS C-only aggregate ABI control (not Objective-C support)');
  console.log('PASS C-mode and multi-TU refusal');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
