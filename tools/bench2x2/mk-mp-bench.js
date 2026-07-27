#!/usr/bin/env node
// bench-2x2: turn a plain mp-<heap> root into an INSTRUMENTED bench root.
//
// Adds, and only adds:
//   * benchmod.c            -- the monotonic clock module (see its header)
//   * MICROPY_PY_BENCH  1   -- gates that module
//   * MICROPY_PY_GC     1   -- upstream's own gc module, unmodified, so
//                              gc.collect()/mem_free()/mem_alloc() are visible
//
// Then regenerates genhdr through the repo's OWN supported generator
// (tools/mkmpgenhdr.js --dir), because which qstrs exist is a function of
// mpconfigport.h -- flipping a module on without regenerating fails to link.
//
//   node mk-mp-bench.js <mp-root> <benchmod.c>
const fs = require('fs');
const path = require('path');

const [, , root, benchmod] = process.argv;
if (!root || !benchmod) { console.error('usage: mk-mp-bench.js <mp-root> <benchmod.c>'); process.exit(2); }

fs.copyFileSync(benchmod, path.join(root, 'benchmod.c'));

// --- mpconfigport.h: append the bench gates -------------------------------
const cfgPath = path.join(root, 'mpconfigport.h');
let cfg = fs.readFileSync(cfgPath, 'utf8');
if (cfg.includes('MICROPY_PY_BENCH')) throw new Error('already instrumented: ' + cfgPath);

// Append before the final #endif-free tail: these are plain #defines and
// mpconfigport.h is included wholesale, so end-of-file is safe and keeps the
// diff against the vendored file to one contiguous block.
cfg += `
/* ---- bench-2x2 instrumentation (NOT shipped) ----------------------------
 * MICROPY_PY_GC exposes upstream's unmodified gc module so GC pauses can be
 * observed; MICROPY_PY_BENCH gates benchmod.c, the monotonic clock this port
 * otherwise lacks entirely (mp_hal_ticks_ms is a stub returning 0). Neither
 * touches the allocator, the collector, or any codegen-relevant setting. */
#define MICROPY_PY_GC     (1)
#define MICROPY_PY_BENCH  (1)
`;
fs.writeFileSync(cfgPath, cfg);

// --- bin.json: add the TU --------------------------------------------------
const binPath = path.join(root, 'bin.json');
const bin = JSON.parse(fs.readFileSync(binPath, 'utf8'));
if (!bin.sources.includes('benchmod.c')) {
  // Insert before main.c so the link order matches the other py/ modules.
  const i = bin.sources.indexOf('main.c');
  bin.sources.splice(i < 0 ? bin.sources.length : i, 0, 'benchmod.c');
}
fs.writeFileSync(binPath, JSON.stringify(bin, null, 2) + '\n');

console.log('instrumented ' + root + ' (+benchmod.c, MICROPY_PY_GC, MICROPY_PY_BENCH)');
