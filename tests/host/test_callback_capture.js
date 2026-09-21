#!/usr/bin/env node
'use strict';
// #784: registration captures a callable. Mutate a real Wasm table between
// registration and invocation; observe explicit re-registration separately.
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const mode = process.argv[2];
if (!mode) {
  for (const backend of ['jspi', 'sync']) {
    const flags = backend === 'sync' ? ['--no-experimental-wasm-jspi'] : [];
    const r = cp.spawnSync(process.execPath, [...flags, '--unhandled-rejections=strict', __filename, backend],
      {encoding: 'utf8', timeout: 30000});
    process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
    assert.equal(r.status, 0, r.error?.message || backend);
  }
} else {
  const C = require('../../compiler.js'), host = require('../../host.js');
  const {compile} = require('../lib/compile-c.js');
  const deadline = setTimeout(() => { console.error('callback capture did not settle'); process.exit(1); }, 20000);
  const sentinel = new Error('callback failure identity');
  async function run(bytes, expected, expectedExit = 0, options = {}) {
    const seen = []; let sdl, tableReads = 0, drained = 0, stderr = '';
    const block = host.BLOCK_FS.create(new host.BLOCK_FS.MemoryByteStore(4 << 20));
    let result, error, frameAtDrain;
    try {
      result = await host({bytes, args: ['callbacks'], onSdl(value) { sdl = value; },
        onReady({instance}) {
          const table = instance.exports.__indirect_function_table;
          if (table) {
            const get = table.get.bind(table);
            table.get = index => { tableReads++; return get(index); };
          }
        },
        blockFsFactory(ctx) {
          ctx.gpuDrain = async () => { drained++; frameAtDrain = sdl.getAnimationFrameFunc(); };
          return {c: {...block.toWasmEnv(ctx),
            observe: value => { seen.push(value); },
            fail: () => { throw sentinel; },
            mutate: (index, replacement) => {
              const table = ctx.getIndirectFunctionTable();
              table.set(index, WebAssembly.Table.prototype.get.call(table, replacement));
            }
          }};
        }, writeOut() {}, writeErr(text) {
          stderr += typeof text === 'string' ? text : new TextDecoder().decode(text);
        }
      });
    } catch (e) { error = e; }
    if (options.failure) assert.equal(error, sentinel);
    else { assert.equal(error, undefined); assert.equal(result, expectedExit); }
    assert.deepEqual(seen, expected);
    if (options.stderr) assert.match(stderr, options.stderr);
    assert.equal(drained, 1);
    assert.equal(frameAtDrain, null, "release frame before drain");
    if (options.reads !== undefined) assert.equal(tableReads, options.reads, 'lookup only at registration');
  }
  function c(source) { return compile(C, {'/tests/capture.c': source}, ['capture.c']).bytes; }
  (async () => {
    assert.equal(typeof WebAssembly.Suspending === 'function', mode === 'jspi');
    await run(c(`
      __import void observe(int); __import void mutate(void(*)(void),void(*)(void));
      __import void __sdl_set_animation_frame_func(void(*)(void));
      void second(void) { observe(2); __sdl_set_animation_frame_func(0); }
      void first(void) { observe(1); __sdl_set_animation_frame_func(first); }
      int main(void) { __sdl_set_animation_frame_func(first); mutate(first,second); return 0; }
    `), [1,2], 0, {reads:2});
    await run(c(`
      #include <stdlib.h>
      #include <emscripten.h>
      __import void observe(int); __import void mutate(void(*)(void*),void(*)(void*));
      void keep(void) {} __export __no_exit_runtime=keep;
      void second(void *p) { observe(2); exit(17); }
      void first(void *p) { observe(1); emscripten_async_call(first,0,0); }
      int main(void) { emscripten_async_call(first,0,0); mutate(first,second); return 0; }
    `), [1,2], 17, {reads:2});
    await run(c(`
      __import void observe(int); __import void __sdl_set_animation_frame_func(void(*)(void));
      void never(void) { observe(99); }
      int main(void) { __sdl_set_animation_frame_func(never); __sdl_set_animation_frame_func(0); return 0; }
    `), [], 0, {reads:1});
    // Exercise each SDL implementation's registration surface with real Wasm
    // functions. Browser construction uses a stub canvas; this is not a GPU test.
    const wasm = new WebAssembly.Instance(new WebAssembly.Module(c(`
      __import void observe(int);
      void first(void) { observe(11); } void second(void) { observe(12); }
      __export first=first; __export second=second;
      int main(void) { return 0; }
    `)), {c:{observe: n => backendSeen.push(n)}});
    const backendSeen = [];
    const table = new WebAssembly.Table({element:'anyfunc', initial:2});
    const ctx = {getIndirectFunctionTable:()=>table, getMemory:()=>wasm.exports.memory,
      getExports:()=>wasm.exports, readString:()=>''};
    const hooks = {wmSabLayout:require('../../kernel.js').WM_SAB_LAYOUT};
    for (const backend of [host.createNullSDL(ctx), host.createBrowserSDL({canvas:{},ctx}),
      host.createSurfaceSDL({ctx,hooks})]) {
      table.set(1,wasm.exports.first);
      backend.c.__sdl_set_animation_frame_func(1);
      table.set(1,wasm.exports.second);
      await backend.getAnimationFrameFunc()();
      backend.c.__sdl_set_animation_frame_func(1);
      await backend.getAnimationFrameFunc()();
      assert.throws(()=>backend.c.__sdl_set_animation_frame_func(2), RangeError);
      assert.throws(()=>backend.c.__sdl_set_animation_frame_func(0x7fffffff), RangeError);
      assert.throws(()=>backend.c.__sdl_set_animation_frame_func_ref(5), TypeError);
      await backend.getAnimationFrameFunc()(); // invalid registration preserves old callback
      backend.c.__sdl_set_animation_frame_func_ref(wasm.exports.first);
      await backend.getAnimationFrameFunc()();
      backend.c.__sdl_set_animation_frame_func_ref(null);
      assert.equal(backend.getAnimationFrameFunc(),null);
      backend.c.__sdl_set_animation_frame_func_ref(wasm.exports.first);
      backend.c.__sdl_quit();
      assert.equal(backend.getAnimationFrameFunc(),null);
    }
    assert.deepEqual(backendSeen,[11,12,12,11,11,12,12,11,11,12,12,11]);
    console.log('PASS callback capture C table mutation, re-registration, zero cancellation:', mode);

  })().catch(e => {console.error(e);process.exitCode=1;}).finally(() => clearTimeout(deadline));
}
