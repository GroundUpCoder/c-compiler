'use strict';
// #796: retired inputs fail on both compiler entry paths; C remains runnable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const C = require('../../compiler.js');
const common = require('../../os/os-common.js');
const {compile} = require('../lib/compile-c.js');
const runModule = require('../../host.js');
const {spawnSync} = require('node:child_process');

// Valid modules for the retired executors: an unused, formerly served import
// plus an empty _start. Neither module relies on the C compiler or rustc.
function retiredModule(namespace, name, params, results) {
  const str = s => [Buffer.byteLength(s), ...Buffer.from(s)];
  const section = (id, bytes) => [id, bytes.length, ...bytes];
  return new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [2, 0x60, params.length, ...params, results.length, ...results, 0x60, 0, 0]),
    ...section(2, [1, ...str(namespace), ...str(name), 0, 0]),
    ...section(3, [1, 1]),
    ...section(5, [1, 0, 1]),
    ...section(7, [2, ...str('_start'), 0, 1, ...str('memory'), 2, 0]),
    ...section(10, [1, 2, 0, 0x0b]),
  ]);
}
(async () => {
  const source = '#ifdef __OBJC__\n#error leaked language mode\n#endif\nint main(void){return 0;}';
  const rejected = C.tokenize('retired.m', source, C.createDefaultPPRegistry());
  assert.match(rejected.errors[0].message, /Objective-C support has been retired/);
  assert.throws(() => compile(C, {'/tests/retired.m':source}, ['retired.m']), /support has been retired/);
  const {bytes} = compile(C, {'/tests/main.c':source}, ['main.c']);
  assert.equal(await require('../../host.js')({bytes,fs,args:['main']}),0);
  for (const [namespace, name, params, results] of [
    ['ss', 'Math.sin', [0x7c], [0x7c]],
    ['wasi_snapshot_preview1', 'args_sizes_get', [0x7f, 0x7f], [0x7f]],
  ]) {
    const bytes = retiredModule(namespace, name, params, results);
    assert(WebAssembly.validate(bytes));
    const bfs = runModule.BLOCK_FS.createV4(new runModule.BLOCK_FS.MemoryByteStore(1 << 20));
    await assert.rejects(runModule({bytes, args: [], writeOut() {}, writeErr() {},
      blockFsFactory: ctx => ({c: bfs.toWasmEnv(ctx)}),
    }), error => /import/i.test(error.message) && error.message.includes(namespace));
  }
  for (const [script, flag] of [['tools/mkpkg.js', '--rust'], ['serve.js', '--packages-index=rust']]) {
    const result = spawnSync(process.execPath, [script, flag], {cwd: path.resolve(__dirname, '../..'), encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown (option|producer)/);
  }
  for (const text of ['@interface A @end', 'int main(void){id x=nil;return 0;}'])
    assert.throws(() => compile(C, {'/tests/main.c':text}, ['main.c']));
  assert.equal(common.srclibDriftPackages().foundation, undefined);
  const root=path.resolve(__dirname,'../..'), archive=path.join(root,'old/objc');
  const manifest=JSON.parse(fs.readFileSync(path.join(archive,'manifest.json'),'utf8'));
  for(const entry of manifest.files) {
    const data=fs.readFileSync(path.join(archive,entry.path));
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'),entry.sha256,entry.path);
  }
  console.log('PASS language retirement, C execution, package retirement and archive integrity');
})().catch(error=>{console.error(error);process.exitCode=1;});
