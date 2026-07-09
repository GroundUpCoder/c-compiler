// kernel-worker.js — the OS's kernel worker (todos/0004; layout in
// todos/OS.md "Reference build"). Runs once per tab: mounts BlockFS on OPFS
// (SyncAccessHandle is worker-only — this is WHY the kernel lives in a
// worker) — a writable root volume at / plus the read-only baked system
// blob at /usr (todos/0040; materialized by fetch-or-bake when missing or
// stale), owns the process table + tty + fd layer (kernel.js), backs
// /bin/cc with compiler.js, and spawns one nested process worker per pid.
//
// Protocol with the page (os.html, a dumb UI bridge):
//   page -> kernel: {type:'input', data}         raw tty bytes/keystrokes
//                   {type:'resize', cols, rows}
//                   {type:'eof'}
//                   {type:'boot-retry'}          two-tab guard (todos/0045):
//                                                re-attempt the boot lock
//                                                after a boot-locked
//                   {type:'wm-canvas', canvas}   the desktop OffscreenCanvas
//                                                (todos/WM.md — the kernel
//                                                composites in-worker)
//                   {type:'wm-input', ev}        raw desktop key/pointer input
//                   {type:'screen-resize', w, h} dynamic screen resolution
//                                                (todos/0023): resize the
//                                                OffscreenCanvas + wmSetScreen
//                                                (-> EV_SCREEN to the wm)
//   kernel -> page: {type:'out', bytes}          tty output (program + echo)
//                   {type:'boot-log', msg}       boot progress / kernel log
//                   {type:'boot-error', msg}
//                   {type:'boot-locked'}         two-tab guard (todos/0045):
//                                                another tab holds the boot
//                                                lock — nothing was mounted;
//                                                the page shows retry
//                   {type:'ready', mode}         booted; mode = openWorkspace's
//                   {type:'halt', status}        pid 1 exited
//                   {type:'audio', sab, bufferSize, freq, channels, format}
//                                                the mixer's output ring
//                                                (todos/0017) — play with
//                                                host.js createAudioReceiver
//                   {type:'pointer-lock', wanted}  relative mouse (todos/0018):
//                                                the focused surface wants the
//                                                pointer lock (page arms
//                                                click-to-lock / exits); the
//                                                page reports transitions back
//                                                as a {kind:'lockchange'}
//                                                wm-input event
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
var wmCanvas = null;   // the desktop OffscreenCanvas (screen-resize target)
var post = function (m) { self.postMessage(m); };
var pending = [];   // input that raced the boot

self.onmessage = function (e) {
  var m = e.data;
  if (!m) return;
  // Two-tab guard (todos/0045): boot-retry must bypass the pending queue —
  // it drives the boot, it can't wait for one.
  if (m.type === 'boot-retry') { startBoot(); return; }
  if (!tty) { pending.push(m); return; }
  if (m.type === 'input') tty.input(typeof m.data === 'string' ? m.data : new Uint8Array(m.data));
  else if (m.type === 'resize') tty.resize(m.cols | 0, m.rows | 0);
  else if (m.type === 'eof') tty.eof();
  else if (m.type === 'wm-canvas') {
    wmCanvas = m.canvas;
    kernel.wmSetScreen(m.canvas.width, m.canvas.height);
    OS_COMPOSITOR.startCompositor(kernel, m.canvas);
  } else if (m.type === 'screen-resize') {
    // Dynamic screen resolution (todos/0023): the page tracks the viewport;
    // the OffscreenCanvas is resized HERE (a transferred canvas can't be
    // resized from the page) and wmSetScreen emits EV_SCREEN + the clamp.
    if (wmCanvas && m.w > 0 && m.h > 0) {
      wmCanvas.width = m.w | 0;
      wmCanvas.height = m.h | 0;
      kernel.wmSetScreen(m.w | 0, m.h | 0);
    }
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
    module: procSpec.module || null,   // pre-compiled Module (todos/0037)
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

// Two-tab boot guard (todos/0045): two tabs would run two KERNELS — two
// process tables, two compositors, two fd brokers — over the same OPFS
// images; BlockFS's dual-instance coherence does not cover that. A Web Lock
// named after the image pair (so unrelated dev pages on this origin never
// collide) is taken BEFORE any OPFS mount and held for the worker's
// lifetime — the browser releases it when the tab closes, including crashes.
// ifAvailable keeps it non-blocking: the losing tab gets {type:'boot-locked'}
// with NOTHING mounted, and the page offers retry (no steal in v1). The
// winning callback parks on a forever-pending promise — the Web Locks idiom
// for "hold until the agent dies".
var SYS_IMG = 'os-system.v5.img';
var ROOT_IMG = 'os-root.v5.img';
var BOOT_LOCK = 'wasm-os:' + SYS_IMG + '+' + ROOT_IMG;
function acquireBootLock() {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return Promise.resolve(true);   // no Web Locks API — boot unguarded
  }
  return new Promise(function (resolve) {
    navigator.locks.request(BOOT_LOCK, { ifAvailable: true }, function (lock) {
      resolve(!!lock);
      if (lock) return new Promise(function () {});   // hold forever
    }).catch(function () { resolve(false); });
  });
}

// Open (creating if absent) a raw OPFS-backed byte store.
async function opfsStore(name) {
  var root = await navigator.storage.getDirectory();
  var fh = await root.getFileHandle(name, { create: true });
  var h = await fh.createSyncAccessHandle();
  return new BLOCK_FS.SyncAccessHandleStore(h);
}

// Copy a fetched blob into an OPFS store, superblock LAST: a crash mid-copy
// leaves no magic, so the next boot sees "stale" and re-materializes.
function materializeBlob(store, bytes) {
  store.resize(0);
  if (bytes.length > 256) store.setBytes(256, bytes.subarray(256));
  store.setBytes(0, bytes.subarray(0, Math.min(256, bytes.length)));
  store.flush();
}

async function boot() {
  if (!(await acquireBootLock())) {
    booting = false;               // let a boot-retry re-enter
    post({ type: 'boot-locked' });
    return;
  }
  post({ type: 'boot-log', msg: 'mounting BlockFS on OPFS…' });
  var manifest = await (await fetch('image.json')).json();
  var seedIo = {
    readAsset: function (name) {
      return fetch(name).then(function (r) {
        if (!r.ok) throw new Error(name + ': HTTP ' + r.status);
        return r.text();
      });
    },
    // bin entries (game data: doom1.wad, ROMs) are repo-relative binaries;
    // seedEntries' chain awaits the promise.
    readBinary: function (p) {
      return fetch('../' + p).then(function (r) {
        if (!r.ok) throw new Error(p + ': HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (ab) { return new Uint8Array(ab); });
    },
    // project entries build repo-relative bin.json trees; the compiler
    // needs a SYNCHRONOUS file reader, so use sync XHR — legal in a
    // worker, and baking is a one-off (cached in the blob afterwards).
    buildProject: function (proj) {
      // Memoize reads INCLUDING misses: include resolution probes several
      // directories per #include across ~40 TUs, which is ~18k lookups for
      // the hush build but only a few hundred distinct paths — uncached,
      // each one is a BLOCKING localhost round trip and first boot spends
      // ~7s in XHR instead of ~1.5s compiling. Safe because the tree can't
      // change mid-bake.
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
  };

  // The system blob (todos/0040): a sealed, read-only BlockFS image mounted
  // at /usr. Materialize when the OPFS copy is missing or version-stale
  // ("upgrade = swap the blob"): prefer a prebaked os/os-system.img served
  // beside the page (tools/mkimage.js output — zero compilation on the boot
  // path), else bake in-worker (the no-build-step dev path). New OPFS names
  // orphan the pre-flip os-system.v4.img/os-user.v4.img pair by design
  // (the 0026 precedent).
  var sysStore = await opfsStore(SYS_IMG);
  var sysMode = 'reused';
  if (OS_COMMON.bakedVersion(BLOCK_FS, sysStore) < (manifest.version | 0)) {
    sysMode = null;
    try {
      var r = await fetch('os-system.img');
      if (r.ok) {
        var blob = new Uint8Array(await r.arrayBuffer());
        var memStore = new BLOCK_FS.MemoryByteStore(blob.length);
        memStore.setBytes(0, blob);
        if (OS_COMMON.bakedVersion(BLOCK_FS, memStore) >= (manifest.version | 0)) {
          post({ type: 'boot-log', msg: 'installing prebaked system image (v' +
            OS_COMMON.bakedVersion(BLOCK_FS, memStore) + ')…' });
          materializeBlob(sysStore, blob);
          sysMode = 'fetched';
        }
      }
    } catch (e) { /* no prebaked blob served — fall through to the bake */ }
    if (!sysMode) {
      await OS_COMMON.bakeSystemImage(BLOCK_FS, CompilerJS, sysStore, manifest, seedIo);
      sysMode = 'baked';
    }
  }
  var sysFs = BLOCK_FS.createV4(sysStore, { readonly: true });

  // The root (writable) volume owns '/' — /etc, /var, /tmp, /root, /dev,
  // /run. Seeded (skeleton + the manifest's `user` section) exactly once,
  // when freshly created; upgrades never write here. (Explicit v3Name so a
  // standalone page's legacy workspace.img on the same origin is never
  // "migrated" into an OS volume — that file has never existed, so the
  // legacy path is inert.)
  var wsRoot = await BLOCK_FS.openWorkspace({ v4Name: ROOT_IMG, v3Name: 'os-root.v3.img' });
  var kfs = new BLOCK_FS.MountFS({ '/': wsRoot.fs, '/usr': sysFs });
  if (wsRoot.mode === 'fresh') {
    post({ type: 'boot-log', msg: 'seeding user volume (manifest v' + manifest.version + ')…' });
    OS_COMMON.initRootVolume(kfs);
    await OS_COMMON.seedEntries(kfs, manifest.user, seedIo);
  }
  var ccCompile = OS_COMMON.createCcDriver(CompilerJS, kfs);

  kernel = new KERNEL.Kernel({
    fs: kfs,
    createWorker: createWorker,
    loadImage: function (p) { return OS_COMMON.readFileBytes(kfs, p); },
    compile: ccCompile,
    onOutput: function (pid, fd, bytes) { post({ type: 'out', bytes: bytes }); },
    onHalt: function (status) { post({ type: 'halt', status: status }); },
    onPointerLock: function (wanted) { post({ type: 'pointer-lock', wanted: wanted }); },
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

  // The audio mixer (todos/0017): one page-owned output ring, kernel-side
  // mixing on a 20ms pump. The page plays it with host.js's
  // createAudioReceiver (resumed on first user gesture — autoplay policy).
  var audioOut = kernel.audioInit({});
  post({ type: 'audio', sab: audioOut.sab, bufferSize: audioOut.bufferSize,
         freq: audioOut.freq, channels: audioOut.channels, format: audioOut.format });
  setInterval(function () { kernel.audioPump(); }, 20);
  await kernel.boot({
    path: '/bin/sh',
    argv: ['sh'],
    envp: ['PATH=/usr/local/bin:/bin', 'HOME=/root', 'TERM=xterm-256color'],
    cwd: '/root',
  });
  await kernel.service({ path: '/bin/wm', argv: ['wm'], envp: ['PATH=/usr/local/bin:/bin'] });
  post({ type: 'ready', mode: sysMode + '/' + wsRoot.mode });

  var queued = pending; pending = [];
  queued.forEach(function (m) { self.onmessage({ data: m }); });
}

// Boot entry — also the boot-retry target (todos/0045). `booting` blocks
// double entry (retry clicks while a boot is in flight or after one won);
// only the lock-lost path resets it. A real boot failure stays terminal
// (reload to reboot), as before.
var booting = false;
function startBoot() {
  if (booting || tty) return;
  booting = true;
  boot().catch(function (e) {
    post({ type: 'boot-error', msg: String((e && e.stack) || e) });
  });
}
startBoot();
