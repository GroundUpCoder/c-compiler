// #761: source-built distribution binaries carry usable debug sections.
'use strict';
const assert = require('assert');
const CC = require('../../compiler.js');
const HOST = require('../../host.js');
const COMMON = require('../../os/os-common.js');
const source = 'int main(void) { __builtin_trap(); return 0; }\n';
const files = {'proj/bin.json': JSON.stringify({sources:['main.c']}), 'proj/main.c':source};
const read = p => { assert(p in files, p); return files[p]; };
function sections(bytes, expected) {
  const mod = new WebAssembly.Module(bytes);
  for (const name of ['name', 'c.sourcemap'])
    assert.strictEqual(WebAssembly.Module.customSections(mod, name).length, expected, name);
}
(async () => {
  sections(COMMON.buildProject(CC, 'proj/bin.json', read), 0);
  sections(COMMON.buildProject(CC, 'proj/bin.json', read, {debug:true}), 1);
  const fs = HOST.BLOCK_FS.createV4(new HOST.BLOCK_FS.MemoryByteStore(8 << 20));
  await COMMON.seedEntries(fs, {dirs:['/etc'], files:{
    '/one':{c:'one.c'}, '/project':{project:'proj/bin.json'},
  }}, {
    readAsset: () => source,
    compile: COMMON.createCcDriver(CC, fs),
    buildProject: (p, opts) => COMMON.buildProject(CC, p, read, opts),
  });
  for (const p of ['/one','/project']) {
    const bytes = COMMON.readFileBytes(fs, p);
    sections(bytes, 1);
    let err = '';
    await assert.rejects(HOST({bytes, args:[p], writeErr:b => {err += new TextDecoder().decode(b);}}));
    assert(/main.*(?:one\.c|main\.c):1/.test(err), err);
  }
  console.log('debug image: default API stripped, opt-in and both distribution build paths symbolicate');
})().catch(e => {console.error(e); process.exitCode=1;});
