// process-worker.js — the browser process bootstrap (todos/0004): one of
// these workers per pid, created by the kernel worker (nested workers). The
// browser twin of kernel.js's Node BOOT_SOURCE, brokered arrangement only —
// the OS kernel always owns the filesystem (KERNEL.md fd/data-plane
// amendment), so every process gets a RemoteFS over the kernel page.
'use strict';

importScripts('../host.js', '../kernel.js');
// host.js worker exports: self.runModule, self.BLOCK_FS
// kernel.js worker exports: self.KERNEL

self.onmessage = function (e) {
  var wd = e.data;
  if (!wd || wd.type !== 'boot') return;
  self.onmessage = null;   // the kernel speaks SAB+doorbell from here on

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
    self.postMessage({ type: 'exited', code: code });
  }, function (err) {
    self.postMessage({ type: 'crashed', error: String((err && err.stack) || err) });
  });
};
