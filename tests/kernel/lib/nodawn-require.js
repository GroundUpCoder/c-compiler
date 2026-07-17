'use strict';
// Force tier 0 (no Dawn) for a boot.js child regardless of the dev
// environment: host.js's lazy GPU probe is `require('webgpu')` inside a
// try/catch (stock Node -> MODULE_NOT_FOUND -> clean adapter-unavailable).
// On machines where the optional `webgpu` devDependency IS installed, the
// no-Dawn acceptance path (menu arch A14, todos/0258) would silently run
// under Dawn instead — so this preload makes require('webgpu') fail exactly
// like an uninstalled package. Loaded via `node --require` (driveBoot
// nodeArgs); worker_threads inherit execArgv, so every process worker's
// probe sees the same MODULE_NOT_FOUND.
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'webgpu') {
    const err = new Error(
      "Cannot find module 'webgpu' (tier 0 forced by tests/kernel/lib/nodawn-require.js)");
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return origLoad.call(this, request, parent, isMain);
};
