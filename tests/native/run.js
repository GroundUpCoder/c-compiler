'use strict';
// Optional integration tier: absence is explicitly reported. Run sdl.js or
// webgpu.js directly to REQUIRE those backends (release validation).
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname,'../..');
const tests = ['sdl.js', 'webgpu.js'];
require('../lib/suite-runner.js').assertMemberRegistry({
  dir: __dirname, pattern: /^(?!run\.js$).*\.js$/,
  label: 'tests/native/run.js', entries: tests.map(file => ({file})), exclude: [],
});
const addon = path.join(root,'build/native/sdl3.node');
if (!fs.existsSync(addon)) {
  console.log('SKIP native integration: build/native/sdl3.node absent; run node native/build.js. Missing-addon behavior is tested by test_native_optional.js.');
} else {
  const native = require(addon); // An installed but broken build is a failure.
  for (const test of tests) {
    if (test === 'webgpu.js' && typeof native.WGPU_CreateInstance !== 'function') {
      console.log('SKIP native WebGPU integration: addon built with --no-webgpu');
      continue;
    }
    const result = spawnSync(process.execPath,[path.join(__dirname,test)],{cwd:root,stdio:'inherit',timeout:120000});
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
