'use strict';
// #770: refusing an option must not produce or overwrite a build artifact.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
const {spawnSync} = require('child_process');
const CC = require('../../compiler.js'), COMMON = require('../../os/os-common.js'), HOST = require('../../host.js');
const root = path.resolve(__dirname, '../..'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-options-'));
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('ok ' + name); }
  catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message); }
}
function cli(args) { return spawnSync(process.execPath, [path.join(root, 'compiler.js'), ...args], {cwd: dir, encoding: 'utf8'}); }
try {
  fs.writeFileSync(path.join(dir, 'main.c'), 'int main(void) { return 0; }\n');
  for (const flag of ['-O0', '-O1', '-O2', '-O3', '-Os', '-Og', '-Wall', '-Wextra', '-Wno-typo', '-std=c11', '-c', '-lm', '-g3', '-fno-inlien', '--typo', '-fsanitize=address']) {
    check('host refuses ' + flag, () => {
      fs.rmSync(path.join(dir, 'out.wasm'), {force: true});
      let r = cli([flag, 'main.c', '-o', 'out.wasm']);
      assert.notStrictEqual(r.status, 0, 'silently accepted');
      assert(r.stderr.includes("unrecognized option '" + flag + "'"), r.stderr);
      assert(!fs.existsSync(path.join(dir, 'out.wasm')));
      fs.writeFileSync(path.join(dir, 'out.wasm'), 'preserve');
      r = cli(['main.c', '-o', 'out.wasm', flag]);
      assert.notStrictEqual(r.status, 0);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'out.wasm'), 'utf8'), 'preserve');
    });
  }
  check('host implemented warning and debug controls', () => {
    const flags = ['pointer-decay', 'circular-dependency', 'large-stack-frame', 'empty-translation-unit'].flatMap(f => ['-W' + f, '-Wno-' + f]);
    const r = cli([...flags, '-g2', '-fno-inline', 'main.c', '-o', 'out.wasm']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert(WebAssembly.validate(fs.readFileSync(path.join(dir, 'out.wasm'))));
  });
  check('host help', () => {
    const r = cli(['--help']);
    assert.strictEqual(r.status, 0, r.stderr);
    for (const word of ['Usage:', '-g2', '-fno-inline', '-O', '-W']) assert(r.stdout.includes(word), r.stdout);
    assert.strictEqual(r.stderr, '');
  });
  const kfs = HOST.BLOCK_FS.createV4(new HOST.BLOCK_FS.MemoryByteStore(1 << 20));
  const driver = COMMON.createCcDriver(CC, kfs);
  check('in-OS help succeeds without source access or output writes', () => {
    const r = driver(['cc', '--help'], '/');
    assert.strictEqual(r.exitCode, 0, r.stderr);
    for (const word of ['usage:', '-g2', '-fno-inline', '__require_source', '/usr/doc/toolchain.md']) assert(r.stdout.includes(word), r.stdout);
    assert.strictEqual(r.stderr, '');
    assert.strictEqual(COMMON.readFileBytes(kfs, '/a.out'), null);
  });
  check('in-OS missing inputs remain an error', () => {
    const r = driver(['cc'], '/'); assert.strictEqual(r.exitCode, 1); assert(r.stderr.includes('usage:'));
  });
} finally { fs.rmSync(dir, {recursive: true, force: true}); }
assert.strictEqual(failures, 0);
