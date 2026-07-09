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
  var rfs = new KERNEL.RemoteFS(client);
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
    spawnHooks: client.spawnHooks(),
    pid: wd.pid,
    ppid: wd.ppid,
  }).then(function (code) {
    self.postMessage({ type: 'exited', code: code });
  }, function (err) {
    self.postMessage({ type: 'crashed', error: String((err && err.stack) || err) });
  });
};
