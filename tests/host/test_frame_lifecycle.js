#!/usr/bin/env node
'use strict';
// #764: real wasm frame callbacks settle their caller, with no global
// unhandled-rejection handler. The injected drain is a teardown-order probe,
// not a claim to exercise a GPU device (Dawn/browser e2es cover that backend).
const assert = require('assert');
const CC = require('../../compiler.js');
const HOST = require('../../host.js');
function compile(action) {
  const name = '/frame-life.c';
  const src = '#include <stdio.h>\n#include <stdlib.h>\n#include <SDL3/SDL.h>\n#include <emscripten.h>\n' +
    'static int tick; static void frame(void) { if (++tick < 3) return; ' + action + ' }\n' +
    'int main(void) { emscripten_set_main_loop(frame, 0, 1); return 0; }\n';
  const pp = CC.createDefaultPPRegistry();
  pp.fileReader = p => p === name ? src : null;
  const opts = {compilerOptions: {}, warningFlags: {}, writeErr: s => { throw Error(s); }};
  const units = CC.parseAllUnits({readFileSync: p => { if (p !== name) throw Error(p); return src; }}, pp, [name], opts);
  assert.deepStrictEqual(CC.linkTranslationUnits(units, opts.compilerOptions).errors, []);
  return CC.generateCode(units, 'a.wasm', opts);
}
async function run(action, rejectDrain) {
  const kfs = HOST.BLOCK_FS.create(new HOST.BLOCK_FS.MemoryByteStore(8 * 1024 * 1024));
  let drained = 0;
  let stderr = '';
  const deadline = setTimeout(() => { console.error('frame run did not settle'); process.exit(1); }, 5000);
  try {
    let result;
    try {
      result = { code: await HOST({bytes: compile(action), args: ['/a.wasm'],
        blockFsFactory: async ctx => {
          ctx.gpuDrain = async () => {
            await Promise.resolve();
            drained++;
            if (rejectDrain) throw Error('injected drain failure');
          };
          return {c: HOST.BLOCK_FS.BlockFS.prototype.toWasmEnv.call(kfs, ctx)};
        },
        writeOut: () => {}, writeErr: b => { stderr += new TextDecoder().decode(b); }
      }) };
    } catch (error) { result = {error}; }
    assert.strictEqual(drained, 1, 'drain must finish exactly once before settlement');
    return {...result, stderr};
  } finally { clearTimeout(deadline); }
}
(async () => {
  for (const rejectDrain of [false, true]) {
    const r = await run('*(volatile int *)0x7ffffff0 = 1;', rejectDrain);
    assert(r.error instanceof WebAssembly.RuntimeError, 'frame fault rejects with original trap, even if drain fails');
    assert(/out of bounds/.test(r.error.message));
    assert(/backtrace/.test(r.stderr), 'frame fault remains diagnosable');
  }
  const explicit = await run('exit(23);');
  assert.strictEqual(explicit.code, 23, 'explicit frame exit preserves status');
  assert(!/backtrace/.test(explicit.stderr));
  const clean = await run('SDL_Quit();');
  assert.strictEqual(clean.code, 0, 'clearing callback ends cleanly');
  assert(!/backtrace/.test(clean.stderr));
  console.log('frame lifecycle: trap, failed drain, explicit exit, clean stop passed');
})().catch(e => { console.error(e.stack || e); process.exit(1); });
