// Host-level regression test (todos/0233, code-debt scan CD1): the
// `--block-fs=path` CLI path must NOT silently clobber the image on a
// read error. Before the fix, ANY readFileSync failure was swallowed →
// a fresh empty image was created → the writeFileSync at exit OVERWROTE
// the original file. A transient EACCES/EIO on startup destroyed the
// user's image. Now only ENOENT (the legitimate "create a new image"
// case) falls through; any other errno prints to stderr and exits 1
// before a store is ever created.
//
// Run: node tests/host/test_blockfs_cli_clobber.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const COMPILER = path.join(ROOT, 'compiler.js');
const HOST = path.join(ROOT, 'host.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const SRC = '#include <stdio.h>\nint main(void) { printf("RAN\\n"); return 0; }\n';

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blockfs-clobber-'));
  const cFile = path.join(tmp, 'ran.c');
  const wasmFile = path.join(tmp, 'ran.wasm');
  fs.writeFileSync(cFile, SRC);
  cp.execFileSync('node', [COMPILER, cFile, '-o', wasmFile], { stdio: 'pipe' });

  // --- Leg 1: unreadable image must fail loud and stay intact -----------
  // Write-only (0200) makes the startup read fail with EACCES while the
  // exit flush would still succeed — the exact pre-fix clobber scenario
  // (a 000-mode file would coincidentally block the flush too).
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('  skip unreadable-image leg (running as root ignores modes)');
  } else {
    const img = path.join(tmp, 'precious.img');
    const PRECIOUS = 'PRECIOUS BYTES - not a blockfs image, must survive';
    fs.writeFileSync(img, PRECIOUS);
    fs.chmodSync(img, 0o200);
    const r = cp.spawnSync('node', [HOST, wasmFile, '--block-fs=' + img],
      { encoding: 'utf-8' });
    fs.chmodSync(img, 0o600);
    check('unreadable image exits 1', r.status === 1, 'status=' + r.status);
    check('stderr names the image', /cannot read image/.test(r.stderr) && r.stderr.includes(img),
      JSON.stringify(r.stderr));
    check('program never ran', !/RAN/.test(r.stdout), JSON.stringify(r.stdout));
    check('original bytes survive', fs.readFileSync(img, 'utf-8') === PRECIOUS,
      JSON.stringify(fs.readFileSync(img, 'utf-8').slice(0, 60)));
  }

  // --- Leg 2: ENOENT is the legitimate new-image case -------------------
  const fresh = path.join(tmp, 'fresh.img');
  const r2 = cp.spawnSync('node', [HOST, wasmFile, '--block-fs=' + fresh],
    { encoding: 'utf-8' });
  check('missing image runs fine', r2.status === 0, 'status=' + r2.status + ' stderr=' + r2.stderr);
  check('program ran', /RAN/.test(r2.stdout), JSON.stringify(r2.stdout));
  check('fresh image created at exit', fs.existsSync(fresh) && fs.statSync(fresh).size > 0);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? failures + ' check(s) FAILED' : 'test_blockfs_cli_clobber: all checks passed');
  process.exit(failures ? 1 : 0);
}

main();
