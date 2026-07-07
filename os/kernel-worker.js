// kernel-worker.js — the OS's kernel worker (todos/0004; layout in
// todos/OS.md "Reference build"). Runs once per tab: mounts BlockFS on OPFS
// (SyncAccessHandle is worker-only — this is WHY the kernel lives in a
// worker), seeds the image on first boot, owns the process table + tty +
// fd layer (kernel.js), backs /bin/cc with compiler.js, and spawns one
// nested process worker per pid.
//
// Protocol with the page (os.html, a dumb UI bridge):
//   page -> kernel: {type:'input', data}         raw tty bytes/keystrokes
//                   {type:'resize', cols, rows}
//                   {type:'eof'}
//                   {type:'wm-canvas', canvas}   the desktop OffscreenCanvas
//                                                (todos/WM.md — the kernel
//                                                composites in-worker)
//                   {type:'wm-input', ev}        raw desktop key/pointer input
//   kernel -> page: {type:'out', bytes}          tty output (program + echo)
//                   {type:'boot-log', msg}       boot progress / kernel log
//                   {type:'boot-error', msg}
//                   {type:'ready', mode}         booted; mode = openWorkspace's
//                   {type:'halt', status}        pid 1 exited
'use strict';

importScripts('../host.js', '../kernel.js', '../compiler.js', 'os-common.js', 'compositor.js');
try {
  // Optional libc extension (fnmatch/glob/regex — busybox hush needs it).
  // compiler.js's getExtLibMap picks up the EXT_LIB_MAP global it defines.
  importScripts('../libc-ext.js');
} catch (e) { /* absent is fine; cc just lacks the ext headers */ }
// worker globals: BLOCK_FS, runModule (host.js); KERNEL (kernel.js);
// CompilerJS (compiler.js); OS_COMMON (os-common.js)

var kernel = null;
var tty = null;
var post = function (m) { self.postMessage(m); };
var pending = [];   // input that raced the boot

self.onmessage = function (e) {
  var m = e.data;
  if (!m) return;
  if (!tty) { pending.push(m); return; }
  if (m.type === 'input') tty.input(typeof m.data === 'string' ? m.data : new Uint8Array(m.data));
  else if (m.type === 'resize') tty.resize(m.cols | 0, m.rows | 0);
  else if (m.type === 'eof') tty.eof();
  else if (m.type === 'wm-canvas') {
    kernel.wmSetScreen(m.canvas.width, m.canvas.height);
    OS_COMPOSITOR.startCompositor(kernel, m.canvas);
  } else if (m.type === 'wm-input') {
    OS_COMPOSITOR.routeInput(kernel, SDL_WEB, m.ev);
  }
};

function createWorker(procSpec) {
  var w = new Worker('process-worker.js');
  var exitCb = null;
  w.postMessage({
    type: 'boot',
    pid: procSpec.pid, ppid: procSpec.ppid, pgid: procSpec.pgid,
    path: procSpec.path, argv: procSpec.argv, envp: procSpec.envp,
    cwd: procSpec.cwd, actions: procSpec.actions, flags: procSpec.flags,
    image: procSpec.image,
    kernelPage: procSpec.kernelPage,
    ttySab: procSpec.ttySab || null,
    brokered: !!procSpec.brokered,
  });
  return {
    postMessage: function (m) { w.postMessage(m); },
    onMessage: function (fn) { w.onmessage = function (ev) { fn(ev.data); }; },
    // Browsers have no worker 'exit' event; an uncaught error in the worker
    // is the observable equivalent of silent death (kernel treats it as
    // termsig SIGSEGV when no 'exited'/'crashed' message preceded it).
    onExit: function (fn) { exitCb = fn; w.onerror = function () { if (exitCb) exitCb(); }; },
    terminate: function () { w.terminate(); },
  };
}

async function boot() {
  post({ type: 'boot-log', msg: 'mounting BlockFS on OPFS…' });
  var ws = await BLOCK_FS.openWorkspace({ v4Name: 'os.v4.img' });
  var kfs = ws.fs;
  var ccCompile = OS_COMMON.createCcDriver(CompilerJS, kfs);

  var manifest = await (await fetch('image.json')).json();
  await OS_COMMON.seedImage(kfs, manifest, {
    readAsset: function (name) {
      return fetch(name).then(function (r) {
        if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
        return r.text();
      });
    },
    compile: ccCompile,
    // project entries build repo-relative bin.json trees; the compiler
    // needs a SYNCHRONOUS file reader, so use sync XHR — legal in a
    // worker, and seeding is a one-off (cached in the image afterwards).
    buildProject: function (proj) {
      // Memoize reads INCLUDING misses: include resolution probes several
      // directories per #include across ~40 TUs, which is ~18k lookups for
      // the hush build but only a few hundred distinct paths — uncached,
      // each one is a BLOCKING localhost round trip and first boot spends
      // ~7s in XHR instead of ~1.5s compiling. Safe because the tree can't
      // change mid-seed.
      var xhrCache = new Map();
      return OS_COMMON.buildProject(CompilerJS, proj, function (p) {
        if (xhrCache.has(p)) {
          var hit = xhrCache.get(p);
          if (hit === null) throw new Error(p + ': HTTP 404 (cached)');
          return hit;
        }
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '../' + p, false /* synchronous */);
        xhr.send(null);
        if (xhr.status !== 200) {
          xhrCache.set(p, null);
          throw new Error(p + ': HTTP ' + xhr.status);
        }
        xhrCache.set(p, xhr.responseText);
        return xhr.responseText;
      });
    },
    log: function (m) { post({ type: 'boot-log', msg: m }); },
  });

  kernel = new KERNEL.Kernel({
    fs: kfs,
    createWorker: createWorker,
    loadImage: function (p) { return OS_COMMON.readFileBytes(kfs, p); },
    compile: ccCompile,
    onOutput: function (pid, fd, bytes) { post({ type: 'out', bytes: bytes }); },
    onHalt: function (status) { post({ type: 'halt', status: status }); },
    log: function (m) { post({ type: 'boot-log', msg: '[kernel] ' + m }); },
  });
  tty = kernel.createTty({
    output: function (b) { post({ type: 'out', bytes: b instanceof Uint8Array ? b.slice() : Uint8Array.from(b) }); },
    interactiveOut: true,   // xterm IS a human terminal: shells go interactive
  });

  // The WM control plane (todos/0014): the kernel-owned endpoint first, then
  // /bin/wm as a kernel service after pid 1. Failure is non-fatal by design —
  // kernel-chrome is the fallback policy; `wm &` respawns it from the shell.
  kernel.wmServe();
  await kernel.boot({
    path: '/bin/sh',
    argv: ['sh'],
    envp: ['PATH=/bin', 'HOME=/root', 'TERM=xterm-256color'],
    cwd: '/root',
  });
  await kernel.service({ path: '/bin/wm', argv: ['wm'], envp: ['PATH=/bin'] });
  post({ type: 'ready', mode: ws.mode });

  var queued = pending; pending = [];
  queued.forEach(function (m) { self.onmessage({ data: m }); });
}

boot().catch(function (e) {
  post({ type: 'boot-error', msg: String((e && e.stack) || e) });
});
