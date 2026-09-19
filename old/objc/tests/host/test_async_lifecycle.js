#!/usr/bin/env node
'use strict';
// #782: real Wasm callbacks, strict unhandled-rejection failure, both actual
// engine modes. The injected drain counts teardown; it is not GPU evidence.
const fs = require('fs');
const assert = require('assert');
const evidence = require('./async-lifecycle-evidence.js')();
const mode = process.argv[2];
if (!mode) {
  const cp = require('child_process');
  try {
    for (const backend of ['jspi', 'sync']) {
      const flags = backend === 'sync' ? ['--no-experimental-wasm-jspi'] : [];
      const record = {name: backend, status: 'running'};
      evidence.record(record);
      const r = cp.spawnSync(process.execPath, [...flags, '--unhandled-rejections=strict', __filename, backend],
        {encoding: 'utf8', timeout: 20000});
      Object.assign(record, {exit: r.status, stdout: r.stdout, stderr: r.stderr,
        error: r.error?.message, status: r.status === 0 ? 'pass' : 'fail'});
      evidence.record(record);
      assert.strictEqual(r.status, 0, JSON.stringify(record));
    }
    evidence.finish(null);
    console.log('async lifecycle: JSPI and synchronous callback checks passed');
  } catch (error) { evidence.finish(error); console.error(error); process.exitCode = 1; }
} else {
  const C = require('../../compiler.js'), host = require('../../host.js');
  const foundation = require('../foundation/corpus.js');
  const timeout = setTimeout(() => { console.error('async lifecycle did not settle'); process.exit(1); }, 10000);
  (async () => {
    assert.strictEqual(typeof WebAssembly.Suspending === 'function', mode === 'jspi');
    const lifetimes = mode === 'jspi' ? ['keep', 'frame', 'suspended-main', 'suspended-frame', 'pending-callback', 'suspended-main-catch', 'suspended-frame-catch', 'pending-callback-catch'] : ['keep', 'frame'];
    for (const lifetime of lifetimes) for (const action of ['exit', 'exit-catch', 'trap', 'host-error', 'success']) {
      const record = {name: lifetime + '-' + action, status: 'running'};
      const frame = lifetime === 'frame' || lifetime.startsWith('suspended-frame');
      const pendingCallback = lifetime.startsWith('pending-callback');
      const pause = lifetime.endsWith('-catch') ?
        '__try {usleep(50000);} __catch {write(2,"BAD-CATCH",9);} write(2,"BAD-AFTER",9);' :
        'usleep(50000);write(2,"BAD",3);';
      evidence.record(record);
      try {
        const source = `#include <emscripten.h>
#include <stdlib.h>
#include <unistd.h>
__import void hostError(void);
void fail(void *p) {${pendingCallback ? pause : action === 'exit-catch' ? '__try {exit(23);} __catch {write(2,"BAD-EXIT-CATCH",14);}' : action === 'exit' ? 'exit(23);' : action === 'trap' ? '__builtin_trap();' : action === 'success' ? 'write(2,"OK",2);' : 'hostError();'}}
void bad(void *p) {write(2,"BAD",3);}
void finish(void *p) {${pendingCallback && action === 'trap' ? '__builtin_trap();' : pendingCallback && action === 'host-error' ? 'hostError();' : 'exit(23);'}}
${frame ? '__import void __sdl_set_animation_frame_func(void(*)(void)); void frame(void) {' + (lifetime.startsWith('suspended-frame') ? pause : '') + '}' :
  (lifetime === 'keep' || pendingCallback) ? 'void keep(void) {} __export __no_exit_runtime=keep;' : ''}
int main(void) {emscripten_async_call(fail,0,${lifetime.startsWith('suspended-frame') ? 10 : 0});emscripten_async_call(bad,0,20);
${action === 'success' || pendingCallback ? 'emscripten_async_call(finish,0,15);' : ''}
${frame ? '__sdl_set_animation_frame_func(frame);' :
  lifetime.startsWith('suspended-main') ? pause : ''}return 0;}`;
        record.source = source;
        evidence.record(record);
        const {bytes} = foundation.compile(C, {'/tests/async.c': source}, ['async.c']);
        evidence.bytes(record, bytes);
        let drained = 0, stderr = '', observed;
        const sentinel = new Error('async host identity');
        const block = host.BLOCK_FS.create(new host.BLOCK_FS.MemoryByteStore(8 * 1024 * 1024));
        try {
          record.exit = await host({bytes, args: ['async'],
            blockFsFactory: ctx => {
              ctx.gpuDrain = async () => { await Promise.resolve(); drained++; throw Error('injected drain failure'); };
              const imports = mode === 'jspi' ? host.createFileSystem({fs, ctx}) : {c: block.toWasmEnv(ctx)};
              imports.c.hostError = () => { throw sentinel; };
              return imports;
            }, writeOut: () => {}, writeErr: s => { stderr += typeof s === 'string' ? s : new TextDecoder().decode(s); }
          });
        } catch (error) { observed = error; }
        assert.strictEqual(drained, 1, 'drain once before settlement, even when it fails');
        if (action === 'exit' || action === 'exit-catch' || action === 'success') { assert.strictEqual(record.exit, 23); assert(!observed); }
        else if (action === 'trap') assert(observed instanceof WebAssembly.RuntimeError);
        else assert.strictEqual(observed, sentinel, 'original host exception identity');
        // Let the second callback and suspended main's original sleep expire.
        // Neither may resume application code after termination.
        await new Promise(resolve => setTimeout(resolve, 70));
        assert(!stderr.includes('BAD'), stderr);
        if(action === 'success' && !pendingCallback) assert(stderr.includes('OK'), 'successful callback ran before exit');
        assert.strictEqual(/backtrace/.test(stderr), action === 'trap');
        Object.assign(record, {drained, stderr, errorClass: observed?.constructor.name, status: 'pass'});
        evidence.record(record);
      } catch (error) {
        Object.assign(record, {status: 'fail', error: error.stack}); evidence.record(record); throw error;
      }
    }
    // Ordinary main completion starts teardown before awaiting a slow drain.
    // This is an injected scheduling window, not a real GPU workload.
    for(const status of [0,7]) {
    const record = {name: 'normal-return-delayed-drain-'+status, status: 'running', source: `
#include <emscripten.h>
#include <unistd.h>
void late(void *p) {write(2,"BAD-LATE",8);}
int main(void) {emscripten_async_call(late,0,5);return ${status};}`};
    evidence.record(record);
    try {
      const {bytes} = foundation.compile(C, {'/tests/drain.c': record.source}, ['drain.c']);
      evidence.bytes(record, bytes);
      const block = host.BLOCK_FS.create(new host.BLOCK_FS.MemoryByteStore(8 * 1024 * 1024));
      let output = '', drains = 0;
      record.exit = await host({bytes, args: ['drain'], blockFsFactory: ctx => {
        ctx.gpuDrain = async () => { drains++; await new Promise(resolve => setTimeout(resolve, 40)); };
        return {c: block.toWasmEnv(ctx)};
      }, writeOut: () => {}, writeErr: s => { output += typeof s === 'string' ? s : new TextDecoder().decode(s); }});
      await new Promise(resolve => setTimeout(resolve, 20));
      Object.assign(record, {output, drains});
      assert.strictEqual(record.exit, status);
      assert.strictEqual(drains, 1);
      assert(!output.includes('BAD'), output);
      record.status = 'pass'; evidence.record(record);
    } catch(error) {record.status='fail';record.error=error.stack;evidence.record(record);throw error;}
    }
    evidence.finish(null);
    console.log('PASS async lifecycle', mode);
  })().catch(error => { evidence.finish(error); console.error(error); process.exitCode = 1; })
    .finally(() => clearTimeout(timeout));
}
