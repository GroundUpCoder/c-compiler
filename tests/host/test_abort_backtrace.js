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
  assert.strictEqual(failures, 0, failures + ' abort diagnostic failures');
})().catch(e => { console.error(e); process.exitCode = 1; });
