#!/usr/bin/env node
'use strict';
// #760: explicit abort diagnostics, actual fd2, and an equal-status clean exit.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CC = require('../../compiler.js');
const HOST = require('../../host.js');
const COMMON = require('../../os/os-common.js');
const src = fs.readFileSync(path.join(__dirname, '../fixtures/abort-backtrace.c'), 'utf8');
const kfs = HOST.BLOCK_FS.createV4(new HOST.BLOCK_FS.MemoryByteStore(8 << 20));
const enc = new TextEncoder(), dec = new TextDecoder();
let fd = kfs.open('/abort.c', 0x241, 0o644);
const source = enc.encode(src); kfs.write(fd, source, source.length); kfs.close(fd);
const built = COMMON.createCcDriver(CC, kfs)(['cc', '-g', '/abort.c', '-o', '/abort.wasm'], '/');
assert.strictEqual(built.exitCode, 0, built.stderr);
const bytes = COMMON.readFileBytes(kfs, '/abort.wasm');
(async () => {
  let failures = 0;
  for (const mode of ['abort', 'assert', 'exit', 'handled', 'closed']) {
    let consoleErr = '', stdout = '';
    const code = await HOST({bytes, args: ['/abort.wasm', mode],
      blockFsFactory: async ctx => {
        const env = kfs.toWasmEnv(ctx);
        const efd = kfs.open('/err', 0x241, 0o644); kfs.dup2(efd, 2); kfs.close(efd);
        return {c: env};
      }, writeErr: b => { consoleErr += dec.decode(b); }, writeOut: b => { stdout += dec.decode(b); }});
    const err = COMMON.readFileText(kfs, '/err');
    try {
      assert.strictEqual(code, 134, mode);
      assert.strictEqual(consoleErr, '', 'redirected/closed fd2 leaked to host console');
      if (mode === 'exit' || mode === 'closed') assert.strictEqual(err, '', mode);
      else {
        assert(/fatal: abort/.test(err), err);
        assert(!/wasm trap/.test(err), 'abort falsely reported as a trap');
        for (const name of ['depth3', 'depth2', 'depth1', 'main']) assert(new RegExp('\\b' + name + '\\b').test(err), err);
        const marker = mode === 'assert' ? 'ASSERT_SITE' : 'ABORT_SITE';
        const line = src.split('\n').findIndex(s => s.includes(marker)) + 1;
        assert(err.includes('/abort.c:' + line), err);
        assert.strictEqual((err.match(/wasm backtrace/g) || []).length, 1, err);
        if (mode === 'assert') assert(/Assertion failed:.*expected assertion/.test(err), err);
        if (mode === 'handled') assert(stdout.includes('handled 6'), stdout);
      }
      console.log('  ok ' + mode);
    } catch (e) { failures++; console.error('  FAIL ' + mode + ': ' + e.message); }
  }
  // The unit corpus still owns assert_fail's stdout + exit status. Its old
  // exact stderr golden predates #760 and cannot represent dynamic wasm frame
  // offsets. Preserve the exact assertion line here, then validate the added
  // diagnostic structurally against the SAME unit fixture (no duplicate C).
  const unitDir = path.join(__dirname, '../unit/stdlib/assert_fail');
  const unitSrc = fs.readFileSync(path.join(unitDir, 'main.c'), 'utf8');
  const unitBytes = enc.encode(unitSrc);
  const ufd = kfs.open('/assert-unit.c', 0x241, 0o644);
  kfs.write(ufd, unitBytes, unitBytes.length); kfs.close(ufd);
  const unitBuilt = COMMON.createCcDriver(CC, kfs)(['cc', '/assert-unit.c', '-o', '/assert-unit.wasm'], '/');
  assert.strictEqual(unitBuilt.exitCode, 0, unitBuilt.stderr);
  let unitErr = '', unitOut = '';
  const unitCode = await HOST({bytes: COMMON.readFileBytes(kfs, '/assert-unit.wasm'), args: ['/assert-unit.wasm'],
    writeErr: b => {unitErr += dec.decode(b);}, writeOut: b => {unitOut += dec.decode(b);}});
  const assertLine = unitSrc.split('\n').findIndex(line => line.includes('assert(1 == 2)')) + 1;
  assert.strictEqual(unitCode, Number(fs.readFileSync(path.join(unitDir, 'expected.exitcode'), 'utf8')));
  assert.strictEqual(unitOut, fs.readFileSync(path.join(unitDir, 'expected.stdout'), 'utf8'));
  assert.strictEqual(unitErr.split('\n')[0], 'Assertion failed: 1 == 2, file /assert-unit.c, line ' + assertLine);
  assert(unitErr.includes('/assert-unit.wasm: fatal: abort: abort() called'), unitErr);
  assert.strictEqual((unitErr.match(/wasm backtrace/g) || []).length, 1, unitErr);
  assert(/#0\s+wasm-function\[\d+\]/.test(unitErr), unitErr);
  assert(unitErr.includes('this binary carries no function names or source map'), unitErr);
  console.log('  ok unit assert_fail: exact predicate/file/line, stdout, exit and new unsymbolized abort chain');
  assert.strictEqual(failures, 0, failures + ' abort diagnostic failures');
})().catch(e => { console.error(e); process.exitCode = 1; });
