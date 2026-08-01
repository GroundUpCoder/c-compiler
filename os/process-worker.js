// process-worker.js — the browser process bootstrap (todos/0004): one of
// these workers per pid, created by the kernel worker (nested workers). The
// browser twin of kernel.js's Node BOOT_SOURCE, brokered arrangement only —
// the OS kernel always owns the filesystem (KERNEL.md fd/data-plane
// amendment), so every process gets a RemoteFS over the kernel page.
'use strict';

// Spawn trace (ticket #350): cross-realm timestamps ride timeOrigin+now()
// (comparable across workers — same monotonic clock). The two stamps below
// are the ONLY always-on cost (two clock reads per spawn); they must run
// unconditionally because the trace flag arrives with the boot message,
// after the phases they measure. Everything else is gated on wd.spawnTrace.
var __PW_T0 = performance.timeOrigin + performance.now();   // realm first-line
importScripts('../host.js', '../kernel.js');
// host.js worker exports: self.runModule, self.BLOCK_FS
// kernel.js worker exports: self.KERNEL
var __PW_T1 = performance.timeOrigin + performance.now();   // importScripts done
function __pwNow() { return performance.timeOrigin + performance.now(); }

self.onmessage = function (e) {
  var wd = e.data;
  if (!wd || wd.type !== 'boot') return;
  self.onmessage = null;   // the kernel speaks SAB+doorbell from here on

  // Spawn trace (ticket #350, default off): collect per-phase stamps and
  // post them to the kernel worker just before 'exited'/'crashed' (before,
  // because the kernel may terminate this worker on receipt of those).
  var TR = wd.spawnTrace
    ? { t0: __PW_T0, t1: __PW_T1, tBoot: __pwNow(), hadModule: !!wd.module }
    : null;
  if (TR) {
    // (c) WASM instantiate span — wrap the constructor for this realm (one
    // process per realm, so this can only see our own instantiate). The
    // trace posts HERE, before main() enters: under the kernel the exit
    // handshake is a SAB RPC and the kernel terminates this worker before
    // runModule's promise resolves, so any post-exit postMessage is lost.
    var OrigInstance = WebAssembly.Instance;
    var Wrapped = function (mod, imp) {
      TR.instStart = __pwNow();
      var inst = new OrigInstance(mod, imp);
      TR.instEnd = __pwNow();
      self.postMessage({ type: 'spawn-trace', pid: wd.pid, tr: TR });
      return inst;
    };
    Wrapped.prototype = OrigInstance.prototype;
    WebAssembly.Instance = Wrapped;
  }

  var client = new KERNEL.KernelClient(wd.kernelPage, function (m, t) {
    if (t) self.postMessage(m, t); else self.postMessage(m);
  });

  // The brokered filesystem: the kernel serves every fs syscall; the wasm
  // env is toWasmEnv REUSED over a RemoteFS (same method surface), with the
  // two in-process-state entries overridden (see kernel.js BOOT_SOURCE).
  // wd.ro (todos/0180) is the sealed system image as an SAB — mounted
  // locally so reads under its prefix (/usr) never cross the RPC boundary.
  var roFs = wd.ro
    ? BLOCK_FS.createV4(new BLOCK_FS.SabByteStore(wd.ro.sab), { readonly: true })
    : null;
  var rfs = new KERNEL.RemoteFS(client, roFs ? { roFs: roFs, roPrefix: wd.ro.prefix } : null);
  if (TR) {
    // (d) first output — toWasmEnv dispatches via `this.`, so wrapping the
    // instance method catches every fd-1/2 write (RemoteFS has no console
    // fast path; stdio goes through this.write → the FS_WRITE RPC).
    var origWrite = rfs.write;
    rfs.write = function (fd, buf, count) {
      if (TR.firstOut === undefined && (fd === 1 || fd === 2)) {
        TR.firstOut = __pwNow();
        // Second fragment — merged by pid page-side (the exit-handshake
        // termination race again: post at the event, not after exit).
        self.postMessage({ type: 'spawn-trace', pid: wd.pid, tr: { firstOut: TR.firstOut } });
      }
      return origWrite.apply(this, arguments);
    };
  }
  // SPSC pipe rings for inherited fds (todos/0181): fast ops gate on the
  // ring's PR_MODE word, so registering a still-brokered ring is free.
  (wd.pipeRings || []).forEach(function (p) { rfs.registerPipeRing(p.fd, p.end, p.sab); });
  var fsFactory = function (ctx) {
    var env = BLOCK_FS.BlockFS.prototype.toWasmEnv.call(rfs, ctx);
    env.__select_impl = rfs.selectImpl(ctx);
    env.isatty = function (fd) { return rfs.isatty(fd); };
    return Promise.resolve({ c: env });
  };

  function envObj(envp) {
    var o = {};
    (envp || []).forEach(function (s) {
      var i = s.indexOf('=');
      if (i > 0) o[s.slice(0, i)] = s.slice(i + 1);
    });
    return o;
  }
  function ship(fd) {
    return function (b) {
      var u = (b instanceof Uint8Array) ? b : new Uint8Array(b);
      self.postMessage({ type: 'out', fd: fd, bytes: u.slice() });
    };
  }

  runModule({
    bytes: wd.image || undefined,
    module: wd.module || undefined,   // pre-compiled Module (todos/0037)
    args: wd.argv,
    env: envObj(wd.envp),
    stdinSab: wd.ttySab || undefined,
    blockFsFactory: fsFactory,
    writeOut: ship(1),
    writeErr: ship(2),
    // rfs wraps spawn() so DUP2 file-actions naming local /usr fds promote
    // to kernel twins (todos/0180); identity when the RO volume is off.
    spawnHooks: rfs.wrapSpawnHooks(client.spawnHooks()),
    pid: wd.pid,
    ppid: wd.ppid,
    // Live ppid off the vDSO page (todos/0179): tracks reparent-to-init.
    getppid: function () { return client.getppid(); },
  }).then(function (code) {
    // Best-effort third fragment: under the kernel this worker is usually
    // terminated at the exit RPC before this runs — tExit is bonus data on
    // the paths where it survives, never load-bearing.
    if (TR) self.postMessage({ type: 'spawn-trace', pid: wd.pid, tr: { tExit: __pwNow() } });
    self.postMessage({ type: 'exited', code: code });
  }, function (err) {
    if (TR) self.postMessage({ type: 'spawn-trace', pid: wd.pid, tr: { tExit: __pwNow() } });
    self.postMessage({ type: 'crashed', error: String((err && err.stack) || err) });
  });
};
