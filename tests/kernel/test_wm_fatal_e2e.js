#!/usr/bin/env node
// R5 (todos/0255): wm.c's fatal diagnostics must name the layer that
// actually failed. Pre-fix, the EV_SCREEN recreate paths funneled through
// the errno-bearing fatal(), so an SDL_CreateWindow failure — which sets
// SDL_GetError(), not errno — printed "wm: cannot recreate the desktop
// window: Success" (or whatever stale errno was lying around). Post-fix
// they go through fatal_sdl(), which reports SDL_GetError(); the
// errno-bearing socket/wmp_read die() callers are untouched.
//
// The REAL wm.c binary runs against a real kernel (nodeCreateWorker, the
// cfgstore-e2e harness shape) and the failure is forced through the real
// mechanism: the kernel's SURFACE_CREATE rejects w > 8192, so
// wmSetScreen(9000, 500) makes the EV_SCREEN recreate's SDL_CreateWindow
// genuinely fail inside wm.c. A second kernel boots with screen 9000x500
// so the INITIAL make_desk fails too (that path printed no cause at all
// pre-fix; both must now name the SDL cause).
//
// Run: node tests/kernel/test_wm_fatal_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const HOST = path.join(ROOT, 'host.js');
const KERNEL = path.join(ROOT, 'kernel.js');
const COMPILER = path.join(ROOT, 'compiler.js');
const K = require(KERNEL);
const { BLOCK_FS } = require(HOST);

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const SDL_CAUSE = 'SDL_CreateWindow: host failed to create a window';

// ---- compile the real wm.c ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-wmfatal-'));
const wmWasmPath = path.join(tmp, 'wm.wasm');
cp.execFileSync('node', [COMPILER, path.join(ROOT, 'os/wm.c'),
  '-I' + path.join(ROOT, 'os'), '-o', wmWasmPath], { stdio: 'pipe' });
const wmWasm = fs.readFileSync(wmWasmPath);

function until(cond, ms, what) {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    (function poll() {
      if (cond()) return res();
      if (Date.now() - t0 > ms) return rej(new Error('timeout waiting for ' + what));
      setTimeout(poll, 25);
    })();
  });
}

// One kernel + one wm service; returns {kernel, err: () => stderr-so-far}.
function bootWm(screen) {
  const store = new BLOCK_FS.MemoryByteStore(4 << 20);
  const kfs = BLOCK_FS.createV4(store);
  let err = '';
  const kernel = new K.Kernel({
    fs: kfs,
    createWorker: K.nodeCreateWorker({ hostPath: HOST, kernelPath: KERNEL }),
    loadImage: (p) => (p === '/bin/wm' ? wmWasm : null),
    onOutput: (pid, fd, bytes) => { if (fd === 2) err += Buffer.from(bytes).toString(); },
    onHalt: () => {},
    log: () => {},
    screen,
  });
  kernel.wmServe();
  return { kernel, err: () => err };
}

(async () => {
  // ---- leg 1: EV_SCREEN recreate failure (the R5 regression) ----
  {
    const { kernel, err } = bootWm({ w: 800, h: 500 });
    await kernel.service({ path: '/bin/wm', argv: ['wm'], envp: ['PATH=/bin', 'HOME=/root'] });
    // desktop + taskbar up means the wm is subscribed and past init
    await until(() => kernel._surfaces.size >= 2, 30000, 'wm desktop+taskbar');
    kernel.wmSetScreen(9000, 500);   // SURFACE_CREATE rejects w > 8192
    await until(() => err().includes('cannot recreate the desktop window'), 30000,
      'wm recreate-failure stderr');
    const line = (err().split('\n').find((l) => l.includes('cannot recreate')) || '');
    check('recreate failure names the SDL cause (pre-fix: ": Success")',
      line.includes('cannot recreate the desktop window: ' + SDL_CAUSE), line);
    check('recreate failure never reports strerror(errno)',
      !/cannot recreate the desktop window: (Success|No such|Connection)/.test(err()), line);
  }

  // ---- leg 2: INITIAL make_desk failure names the cause too ----
  {
    const { kernel, err } = bootWm({ w: 9000, h: 500 });
    await kernel.service({ path: '/bin/wm', argv: ['wm'], envp: ['PATH=/bin', 'HOME=/root'] });
    await until(() => err().includes('cannot create the desktop window'), 30000,
      'wm initial-create stderr');
    const line = (err().split('\n').find((l) => l.includes('cannot create')) || '');
    check('initial-create failure names the SDL cause (pre-fix: no cause)',
      line.includes('cannot create the desktop window: ' + SDL_CAUSE), line);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures === 0 ? '\nwm fatal e2e: PASS' : `\nwm fatal e2e: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
