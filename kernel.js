// kernel.js — the process control plane (owner side). Design: todos/KERNEL.md.
//
// This is the per-SYSTEM half of the OS: process table, spawn/wait/kill,
// signal routing, and (in later phases) tty line discipline and pipe
// rendezvous. host.js is the per-PROCESS half — it runs inside every process
// worker and knows nothing about other processes; its `spawnHooks` seam is
// how a process reaches this kernel.
//
// Implemented phases (see KERNEL.md "Implementation phases"):
//   Phase 1 — process table (pid/ppid/pgid/sid, RUNNING/ZOMBIE, reaping,
//     orphan reparenting to pid 1, pid-1 exit halts the system); the
//     per-process kernel page (SAB) + JSON block-RPC transport; KernelClient
//     plugging into host.js's spawnHooks seam; spawn/wait/kill/compile.
//   Phase 2 (todos/0001) — asynchronous signal delivery: SIGPEND/SIGBLOCK
//     live on the kernel page, host.js claims deliverable bits at libc safe
//     points and runs C handlers via the __sig_dispatch export; blocking
//     WAIT interrupts with EINTR (krpc-intr); SIGCHLD on child exit; the
//     ordered exit handshake (OP.EXIT).
// Phase 3 (todos/0002) adds the tty object; Phase 4 (todos/0003) pipes/job
// control. The page layout already reserves their state so the SAB format
// is stable.
//
// Environment: plain JS, no build step, Node + browser (same discipline as
// host.js/compiler.js — no Node-only APIs without a typeof-guard). The
// Kernel/KernelClient classes are environment-neutral (SAB + Atomics only);
// worker creation is an injected capability. nodeCreateWorker() is the
// tested Node reference factory; the browser factory ships with the os/
// page (OS.md "Reference build") where it can actually be exercised.

'use strict';

/* ============================================================
 * Kernel page — the per-process SAB shared kernel <-> process.
 *
 * Int32 words (all access via Atomics):
 *   [0] KP_DOORBELL   seq counter; the kernel bumps + notifies it on ANY
 *                     event for this process (RPC response now; signals,
 *                     child-state changes, tty/pipe readiness in later
 *                     phases). Every process-side blocking loop parks here.
 *   [1] KP_SIGPEND    pending-signal bitmask, bit (sig-1) — matches libc's
 *                     sigset_t convention. Kernel ORs bits in; libc claims
 *                     them with Atomics.and at dispatch (Phase 2).
 *   [2] KP_SIGBLOCK   blocked mask (libc writes via sigprocmask; Phase 2).
 *   [3] KP_FLAGS      bit0 STOP-requested; bit1 in-sigdispatch (Phase 2/4).
 *   [4] KP_RPC_STATE  RPC_IDLE / RPC_REQUEST / RPC_DONE.
 *   [5] KP_RPC_OP     opcode of the in-flight request.
 *   [6] KP_RPC_LEN    payload byte length (request, then response).
 *   [7] (reserved)
 *   [8..] payload     UTF-8 JSON (request, then response, in place).
 *
 * One RPC in flight per process by construction: the process worker is
 * parked on the doorbell for the duration of every call.
 * ============================================================ */
var KP_DOORBELL = 0;
var KP_SIGPEND = 1;
var KP_SIGBLOCK = 2;
var KP_FLAGS = 3;
var KP_RPC_STATE = 4;
var KP_RPC_OP = 5;
var KP_RPC_LEN = 6;
var KP_PAYLOAD_OFF = 32;           // byte offset of the payload region
var KP_SIZE = 64 * 1024;           // fits compile stdout/stderr comfortably
var KP_PAYLOAD_CAP = KP_SIZE - KP_PAYLOAD_OFF;

var RPC_IDLE = 0, RPC_REQUEST = 1, RPC_DONE = 2;

/* Opcode space (todos/KERNEL.md): 0x00xx process, 0x01xx tty, 0x02xx pipes,
 * 0x03xx misc, 0x1xxx reserved for WM surfaces. Only the ops the current
 * phase implements are dispatched; the rest respond ENOSYS. */
var OP = {
  SPAWN: 0x0001,
  WAIT: 0x0002,
  KILL: 0x0003,
  EXIT: 0x0004,      // ordered exit handshake (no response; kernel tears down)
  SETPGID: 0x0005,
  GETPGID: 0x0006,
  SETSID: 0x0007,
  SIGDISP: 0x0008,
  SIGMASK: 0x0009,   // reserved: Phase 2
  COMPILE: 0x0301,
};

/* Wait options / status packing — must match <sys/wait.h>. */
var WNOHANG = 0x01;
function W_EXITCODE(code) { return (code & 0xff) << 8; }
function W_TERMSIG(sig) { return sig & 0x7f; }

/* Signal numbering + default actions — must match <signal.h> /
 * __sig_default_action in libc. Kind mirror (__on_sigdisp): 0=DFL 1=IGN
 * 2=HANDLER. */
var SIG = {
  HUP: 1, INT: 2, QUIT: 3, ILL: 4, TRAP: 5, ABRT: 6, BUS: 7, FPE: 8,
  KILL: 9, USR1: 10, SEGV: 11, USR2: 12, PIPE: 13, ALRM: 14, TERM: 15,
  CHLD: 17, CONT: 18, STOP: 19, TSTP: 20, TTIN: 21, TTOU: 22, URG: 23,
  WINCH: 28,
};
var NSIG = 32;
var DISP_DFL = 0, DISP_IGN = 1, DISP_HANDLER = 2;
/* 0=terminate 1=ignore 2=stop 3=continue (libc's __sig_default_action). */
function sigDefaultAction(sig) {
  if (sig === SIG.CHLD || sig === SIG.URG || sig === SIG.WINCH) return 1;
  if (sig === SIG.CONT) return 3;
  if (sig === SIG.STOP || sig === SIG.TSTP || sig === SIG.TTIN || sig === SIG.TTOU) return 2;
  return 0;
}

var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder('utf-8');

function writePayload(i32, u8, obj) {
  var bytes = textEncoder.encode(JSON.stringify(obj === undefined ? {} : obj));
  if (bytes.length > KP_PAYLOAD_CAP) return false;
  u8.set(bytes, KP_PAYLOAD_OFF);
  Atomics.store(i32, KP_RPC_LEN, bytes.length);
  return true;
}

function readPayload(i32, u8) {
  var len = Atomics.load(i32, KP_RPC_LEN);
  if (len <= 0) return {};
  // Copy out of the SAB before decoding (TextDecoder rejects SAB views).
  var copy = new Uint8Array(len);
  copy.set(u8.subarray(KP_PAYLOAD_OFF, KP_PAYLOAD_OFF + len));
  return JSON.parse(textDecoder.decode(copy));
}

/* ============================================================
 * KernelClient — the process-side stub. Lives in the process worker,
 * speaks block-RPC over the kernel page, and adapts to host.js's
 * existing spawnHooks seam so runModule needs no changes.
 *
 *   var client = new KernelClient(kernelPageSab, postToKernel);
 *   runModule({ ..., spawnHooks: client.spawnHooks() });
 *
 * postToKernel(msg) must deliver msg to the kernel's message handler for
 * this process (worker postMessage in both browser and Node).
 * ============================================================ */
function KernelClient(sab, postToKernel) {
  this._i32 = new Int32Array(sab);
  this._u8 = new Uint8Array(sab);
  this._post = postToKernel;
}

/* Synchronous block-RPC: returns the response object ({errno: 'NAME'} on
 * failure — the names flow into ctx.setErrnoName via the hooks contract).
 * `interruptible` ops (WAIT) additionally watch for deliverable signals
 * while parked: the first one posts a krpc-intr message and the kernel
 * answers EINTR (or the already-raced real result — both are fine; the
 * signal delivers at the caller's next safe point). */
KernelClient.prototype.call = function (op, req, interruptible) {
  var i32 = this._i32;
  if (!writePayload(i32, this._u8, req)) return { errno: 'E2BIG' };
  Atomics.store(i32, KP_RPC_OP, op);
  Atomics.store(i32, KP_RPC_STATE, RPC_REQUEST);
  this._post({ type: 'krpc' });
  // Park on the doorbell until the kernel marks the RPC done. Read the seq
  // BEFORE checking state: if the kernel completes in between, wait() sees a
  // stale seq and returns 'not-equal' immediately — no lost wakeup. The
  // doorbell also fires for non-RPC events (signal posts, child changes), so
  // spurious wakes just re-check state and re-park.
  var sentIntr = false;
  for (;;) {
    var seq = Atomics.load(i32, KP_DOORBELL);
    if (Atomics.load(i32, KP_RPC_STATE) === RPC_DONE) break;
    if (interruptible && !sentIntr && this.pending()) {
      sentIntr = true;
      this._post({ type: 'krpc-intr' });
    }
    Atomics.wait(i32, KP_DOORBELL, seq);
  }
  var resp = readPayload(i32, this._u8);
  Atomics.store(i32, KP_RPC_STATE, RPC_IDLE);
  return resp;
};

/* Deliverable = pending and not blocked. */
KernelClient.prototype.pending = function () {
  return Atomics.load(this._i32, KP_SIGPEND) & ~Atomics.load(this._i32, KP_SIGBLOCK);
};

/* Atomically claim all deliverable pending signals; returns the claimed
 * mask (0 if none). Blocked bits stay pending until sigmask() unblocks. */
KernelClient.prototype.sigpoll = function () {
  var i32 = this._i32;
  for (;;) {
    var p = Atomics.load(i32, KP_SIGPEND);
    var take = p & ~Atomics.load(i32, KP_SIGBLOCK);
    if (!take) return 0;
    if (Atomics.compareExchange(i32, KP_SIGPEND, p, p & ~take) === p) return take;
  }
};

/* Publish the libc's blocked mask so the kernel honors it for default
 * actions and so sigpoll leaves blocked bits pending. */
KernelClient.prototype.sigmask = function (mask) {
  Atomics.store(this._i32, KP_SIGBLOCK, mask | 0);
};

/* Park on the doorbell until a signal is deliverable ('signal') or the
 * timeout elapses ('timeout'). ms undefined/null → wait forever. */
KernelClient.prototype.park = function (ms) {
  var i32 = this._i32;
  var deadline = (ms === undefined || ms === null) ? null : Date.now() + ms;
  for (;;) {
    var seq = Atomics.load(i32, KP_DOORBELL);
    if (this.pending()) return 'signal';
    if (deadline === null) {
      Atomics.wait(i32, KP_DOORBELL, seq);
    } else {
      var left = deadline - Date.now();
      if (left <= 0) return 'timeout';
      if (Atomics.wait(i32, KP_DOORBELL, seq, left) === 'timed-out') return 'timeout';
    }
  }
};

/* Adapter to host.js's spawnHooks seam (createSpawn's contract). The Phase 2
 * members (sigpoll/sigmask/park/exit) light up host.js's safe-point signal
 * delivery, interruptible sleeps, and the ordered exit handshake. */
KernelClient.prototype.spawnHooks = function () {
  var self = this;
  return {
    spawn: function (spec) { return self.call(OP.SPAWN, spec); },
    wait: function (pid, options) { return self.call(OP.WAIT, { pid: pid, options: options }, true); },
    kill: function (pid, sig) { return self.call(OP.KILL, { pid: pid, sig: sig }); },
    sigdisp: function (sig, kind) { self.call(OP.SIGDISP, { sig: sig, kind: kind }); },
    compile: function (argv, cwd) { return self.call(OP.COMPILE, { argv: argv, cwd: cwd }); },
    sigpoll: function () { return self.sigpoll(); },
    sigmask: function (mask) { self.sigmask(mask); },
    park: function (ms) { return self.park(ms); },
    exit: function (status) { return self.call(OP.EXIT, { code: status }); },
  };
};

/* ============================================================
 * Kernel — the process table and RPC dispatcher (owner side).
 *
 * Injected capabilities (all optional except createWorker):
 *   createWorker(procSpec) -> handle   REQUIRED. Creates the process worker.
 *       procSpec: { pid, ppid, pgid, path, argv, envp, cwd, actions, flags,
 *                   image (ArrayBuffer), kernelPage (SAB) }
 *       handle:   { postMessage(msg), onMessage(fn), onExit(fn), terminate() }
 *   loadImage(path) -> bytes | Promise<bytes> | null   resolve a spawn path
 *       to a wasm image (null -> ENOENT). The reference OS page reads its
 *       BlockFS; tests inject a map.
 *   compile(argv, cwd) -> {exitCode, stdout, stderr} | {errno}   backs
 *       /bin/cc's __compile. Absent -> ENOSYS.
 *   onOutput(pid, fd, bytes)   a process wrote to fd 1/2 (bytes: Uint8Array).
 *   onHalt(status)             pid 1 exited; `status` is its wait-status.
 *   log(msg)                   kernel diagnostics (default: silent).
 *
 * Worker messages the kernel understands (the bootstrap's side of the
 * contract): {type:'krpc'} — an RPC request is in the kernel page;
 * {type:'out', fd, bytes} — stdout/stderr traffic; {type:'exited', code} —
 * runModule resolved; {type:'crashed', error} — runModule rejected.
 * ============================================================ */
var STATE_RUNNING = 'running', STATE_ZOMBIE = 'zombie';

function Kernel(opts) {
  if (!opts || typeof opts.createWorker !== 'function') {
    throw new Error('Kernel: a createWorker capability is required');
  }
  this._createWorker = opts.createWorker;
  this._loadImage = opts.loadImage || function () { return null; };
  this._compile = opts.compile || null;
  this._onOutput = opts.onOutput || function () {};
  this._onHalt = opts.onHalt || function () {};
  this._log = opts.log || function () {};
  this._procs = new Map();   // pid -> PCB
  this._nextPid = 1;
  this._halted = false;
}

/* Boot the system: spawn pid 1 (init). spec: {path, argv, envp, cwd}.
 * Resolves to init's pid (1); rejects if the image can't be loaded. */
Kernel.prototype.boot = function (spec) {
  return this._spawn(null, {
    path: spec.path,
    argv: spec.argv || [spec.path],
    envp: spec.envp || [],
    cwd: spec.cwd || '/',
    actions: [],
    flags: 0,
    pgid: 0,
  }).then(function (r) {
    if (r.errno) throw new Error('boot: ' + r.errno);
    return r.pid;
  });
};

Kernel.prototype.process = function (pid) { return this._procs.get(pid) || null; };
Kernel.prototype.processCount = function () { return this._procs.size; };

/* ---- process creation ---- */

Kernel.prototype._spawn = function (parent, spec) {
  var self = this;
  if (this._halted) return Promise.resolve({ errno: 'ESRCH' });
  if (!spec || typeof spec.path !== 'string') return Promise.resolve({ errno: 'EFAULT' });
  return Promise.resolve(this._loadImage(spec.path)).then(function (image) {
    if (!image) return { errno: 'ENOENT' };
    var pid = self._nextPid++;
    // spec.flags bit0 = "set process group" (posix_spawn normalizes
    // POSIX_SPAWN_SETPGROUP to 1u); pgid 0 means "own pid" per POSIX.
    var pgid = (spec.flags & 1) ? (spec.pgid > 0 ? spec.pgid : pid)
      : (parent ? parent.pgid : pid);
    var pcb = {
      pid: pid,
      ppid: parent ? parent.pid : 0,
      pgid: pgid,
      sid: parent ? parent.sid : pid,
      state: STATE_RUNNING,
      exit: 0,                       // wait-status once ZOMBIE
      children: new Set(),
      envp: spec.envp !== null && spec.envp !== undefined ? spec.envp
        : (parent ? parent.envp : []),
      cwd: spec.cwd !== null && spec.cwd !== undefined ? spec.cwd
        : (parent ? parent.cwd : '/'),
      sigdisp: new Int8Array(NSIG),  // __on_sigdisp mirror; all DFL initially
      waiter: null,                  // deferred WAIT: {sel, options}
      page: null, i32: null, u8: null,
      worker: null,
    };
    var sab = new SharedArrayBuffer(KP_SIZE);
    pcb.page = sab;
    pcb.i32 = new Int32Array(sab);
    pcb.u8 = new Uint8Array(sab);
    self._procs.set(pid, pcb);
    if (parent) parent.children.add(pid);
    var procSpec = {
      pid: pid, ppid: pcb.ppid, pgid: pcb.pgid,
      path: spec.path,
      argv: (spec.argv && spec.argv.length) ? spec.argv : [spec.path],
      envp: pcb.envp,
      cwd: pcb.cwd,
      actions: spec.actions || [],   // carried verbatim; applied in Phase 4
      flags: spec.flags | 0,
      image: image,
      kernelPage: sab,
    };
    try {
      pcb.worker = self._createWorker(procSpec);
    } catch (e) {
      self._procs.delete(pid);
      if (parent) parent.children.delete(pid);
      self._log('spawn: createWorker failed: ' + (e && e.message));
      return { errno: 'EAGAIN' };
    }
    pcb.worker.onMessage(function (msg) { self._onWorkerMessage(pcb, msg); });
    pcb.worker.onExit(function () {
      // Channel death without an 'exited' message = abnormal termination.
      if (pcb.state === STATE_RUNNING) self._exitProcess(pcb, W_TERMSIG(SIG.SEGV));
    });
    return { pid: pid };
  });
};

/* ---- worker message handling ---- */

Kernel.prototype._onWorkerMessage = function (pcb, msg) {
  if (!msg || pcb.state !== STATE_RUNNING) return;
  switch (msg.type) {
    case 'krpc': this._dispatchRpc(pcb); break;
    // A parked interruptible RPC (WAIT) noticed a deliverable signal: answer
    // EINTR if the wait is still registered. If the real result raced in
    // first, the waiter is already gone — ignore, the signal delivers at the
    // caller's next safe point anyway.
    case 'krpc-intr':
      if (pcb.waiter) { pcb.waiter = null; this._respond(pcb, { errno: 'EINTR' }); }
      break;
    case 'out': this._onOutput(pcb.pid, msg.fd, msg.bytes); break;
    case 'exited': this._exitProcess(pcb, W_EXITCODE(msg.code | 0)); break;
    case 'crashed':
      this._log('pid ' + pcb.pid + ' crashed: ' + msg.error);
      this._exitProcess(pcb, W_TERMSIG(SIG.SEGV));
      break;
    default: this._log('pid ' + pcb.pid + ': unknown message ' + msg.type);
  }
};

Kernel.prototype._respond = function (pcb, resp) {
  if (!writePayload(pcb.i32, pcb.u8, resp)) {
    writePayload(pcb.i32, pcb.u8, { errno: 'ENOMEM' });
  }
  Atomics.store(pcb.i32, KP_RPC_STATE, RPC_DONE);
  this._ring(pcb);
};

/* Bump + notify a process's doorbell (any-event wakeup). */
Kernel.prototype._ring = function (pcb) {
  Atomics.add(pcb.i32, KP_DOORBELL, 1);
  Atomics.notify(pcb.i32, KP_DOORBELL);
};

Kernel.prototype._dispatchRpc = function (pcb) {
  var self = this;
  if (Atomics.load(pcb.i32, KP_RPC_STATE) !== RPC_REQUEST) return; // stale ping
  var op = Atomics.load(pcb.i32, KP_RPC_OP);
  var req;
  try { req = readPayload(pcb.i32, pcb.u8); }
  catch (e) { this._respond(pcb, { errno: 'EFAULT' }); return; }
  switch (op) {
    case OP.SPAWN:
      this._spawn(pcb, req).then(function (r) { self._respond(pcb, r); });
      break;
    case OP.WAIT: this._wait(pcb, req.pid | 0, req.options | 0); break;
    case OP.KILL: this._respond(pcb, this.kill(req.pid | 0, req.sig | 0, pcb)); break;
    // Ordered exit handshake (libc exit() → host __exit hook → here). All
    // prior 'out' messages are already processed (same FIFO channel), so the
    // status becomes visible only after the output did. No response — the
    // worker is torn down by _exitProcess.
    case OP.EXIT: this._exitProcess(pcb, W_EXITCODE(req.code | 0)); break;
    case OP.SIGDISP:
      if (req.sig > 0 && req.sig < NSIG) pcb.sigdisp[req.sig] = req.kind | 0;
      this._respond(pcb, {});
      break;
    case OP.SETPGID: this._respond(pcb, this._setpgid(pcb, req.pid | 0, req.pgid | 0)); break;
    case OP.GETPGID: {
      var t = (req.pid | 0) === 0 ? pcb : this._procs.get(req.pid | 0);
      this._respond(pcb, t ? { pgid: t.pgid } : { errno: 'ESRCH' });
      break;
    }
    case OP.SETSID:
      if (pcb.pgid === pcb.pid) { this._respond(pcb, { errno: 'EPERM' }); break; }
      pcb.pgid = pcb.pid; pcb.sid = pcb.pid;
      this._respond(pcb, { sid: pcb.sid });
      break;
    case OP.COMPILE:
      if (!this._compile) { this._respond(pcb, { errno: 'ENOSYS' }); break; }
      Promise.resolve(this._compile(req.argv || [], req.cwd || '/')).then(
        function (r) { self._respond(pcb, r || { errno: 'EIO' }); },
        function (e) {
          self._log('compile hook threw: ' + (e && e.message));
          self._respond(pcb, { errno: 'EIO' });
        });
      break;
    default: this._respond(pcb, { errno: 'ENOSYS' });
  }
};

/* ---- wait / reap ---- */

function waitSelectorMatch(sel, waiterPcb, childPcb) {
  if (sel > 0) return childPcb.pid === sel;
  if (sel === -1) return true;
  if (sel === 0) return childPcb.pgid === waiterPcb.pgid;
  return childPcb.pgid === -sel;
}

Kernel.prototype._wait = function (pcb, sel, options) {
  var candidates = [];
  var self = this;
  pcb.children.forEach(function (cpid) {
    var c = self._procs.get(cpid);
    if (c && waitSelectorMatch(sel, pcb, c)) candidates.push(c);
  });
  if (candidates.length === 0) { this._respond(pcb, { errno: 'ECHILD' }); return; }
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i].state === STATE_ZOMBIE) {
      var z = candidates[i];
      this._reap(z);
      this._respond(pcb, { pid: z.pid, status: z.exit });
      return;
    }
  }
  if (options & WNOHANG) { this._respond(pcb, { pid: 0, status: 0 }); return; }
  pcb.waiter = { sel: sel, options: options };  // answered by _exitProcess
};

Kernel.prototype._reap = function (zombie) {
  this._procs.delete(zombie.pid);
  var parent = this._procs.get(zombie.ppid);
  if (parent) parent.children.delete(zombie.pid);
};

/* ---- exit ---- */

Kernel.prototype._exitProcess = function (pcb, status) {
  if (pcb.state === STATE_ZOMBIE) return;
  pcb.state = STATE_ZOMBIE;
  pcb.exit = status;
  pcb.waiter = null;
  if (pcb.worker) { try { pcb.worker.terminate(); } catch (e) {} }
  pcb.worker = null;

  var self = this;
  // Reparent children (running AND zombie) to init.
  var init = this._procs.get(1);
  pcb.children.forEach(function (cpid) {
    var c = self._procs.get(cpid);
    if (!c) return;
    c.ppid = 1;
    if (init && init !== pcb) {
      init.children.add(cpid);
      // A reparented zombie may satisfy init's pending wait immediately.
      if (c.state === STATE_ZOMBIE && init.waiter &&
          waitSelectorMatch(init.waiter.sel, init, c)) {
        init.waiter = null;
        self._reap(c);
        self._respond(init, { pid: c.pid, status: c.exit });
      }
    }
  });
  pcb.children.clear();

  if (pcb.pid === 1) {
    this._halted = true;
    this._onHalt(status);
    this._procs.delete(1);
    return;
  }

  var parent = this._procs.get(pcb.ppid);
  if (parent && parent.state === STATE_RUNNING) {
    // Post SIGCHLD BEFORE answering a parked wait: the parent wakes on the
    // response and races through its safe point immediately — the pending
    // bit must already be visible so the handler runs before waitpid
    // returns to the program. (Default-ignore drops it; a stray krpc-intr
    // triggered by the post is ignored once the waiter is answered.)
    this._deliver(parent, SIG.CHLD);
    if (parent.waiter && waitSelectorMatch(parent.waiter.sel, parent, pcb)) {
      parent.waiter = null;
      this._reap(pcb);
      this._respond(parent, { pid: pcb.pid, status: status });
    } else {
      // No pending wait: stay a zombie until reaped; ring so any parked
      // parent re-checks its world.
      this._ring(parent);
    }
  } else {
    // Parent already gone: we were (or just became) init's child; init will
    // reap us, or we ride out as a zombie under it.
    if (!this._procs.get(1)) this._reap(pcb);
  }
};

/* ---- kill ----
 * Routing per todos/KERNEL.md: pid > 0 exact; pid 0 = sender's pgroup;
 * pid < -1 = pgroup -pid; pid -1 unsupported (EPERM) — no "everyone" in v1.
 * Action = disposition mirror: HANDLER -> post SIGPEND bit (delivery is
 * Phase 2; the bit + doorbell are already correct); IGN -> drop; DFL ->
 * default action (terminate class ends the process; ignore class drops;
 * stop/continue classes are Phase 4 — dropped with a log for now).
 * SIGKILL/SIGSTOP never consult the mirror. `sender` is the calling PCB
 * (null for kernel/embedder-initiated kills). */
Kernel.prototype.kill = function (pid, sig, sender) {
  if (!(sig > 0 && sig < NSIG)) return { errno: 'EINVAL' };
  var targets = [];
  var self = this;
  if (pid > 0) {
    var t = this._procs.get(pid);
    if (!t || t.state !== STATE_RUNNING) return { errno: 'ESRCH' };
    targets.push(t);
  } else if (pid === -1) {
    return { errno: 'EPERM' };
  } else {
    var pgid = pid === 0 ? (sender ? sender.pgid : 0) : -pid;
    this._procs.forEach(function (p) {
      if (p.state === STATE_RUNNING && p.pgid === pgid) targets.push(p);
    });
    if (targets.length === 0) return { errno: 'ESRCH' };
  }
  for (var i = 0; i < targets.length; i++) this._deliver(targets[i], sig);
  return {};
};

Kernel.prototype._deliver = function (pcb, sig) {
  if (sig === SIG.KILL) { this._exitProcess(pcb, W_TERMSIG(sig)); return; }
  var disp = pcb.sigdisp[sig];
  if (disp === DISP_IGN) return;
  if (disp === DISP_HANDLER) {
    // Post the pending bit and ring the doorbell. Phase 2 wires the libc
    // safe-point dispatch that consumes this; until then a caught signal is
    // recorded but not yet asynchronously delivered (same as the previous
    // external kernels, which dropped it entirely).
    Atomics.or(pcb.i32, KP_SIGPEND, 1 << (sig - 1));
    this._ring(pcb);
    return;
  }
  switch (sigDefaultAction(sig)) {
    case 0:
      // Terminate — but honor the target's published blocked mask: a blocked
      // fatal signal stays pending; libc applies the default action when
      // sigprocmask unblocks it (it kill-selfs, so the termsig still
      // round-trips as WIFSIGNALED).
      if (Atomics.load(pcb.i32, KP_SIGBLOCK) & (1 << (sig - 1))) {
        Atomics.or(pcb.i32, KP_SIGPEND, 1 << (sig - 1));
        this._ring(pcb);
      } else {
        this._exitProcess(pcb, W_TERMSIG(sig));
      }
      break;
    case 1: break;                                           // ignore
    default:
      // stop/continue: todos/0003 (job control). Dropped, loudly.
      this._log('pid ' + pcb.pid + ': stop/cont signal ' + sig + ' dropped (todos/0003)');
  }
};

/* ============================================================
 * nodeCreateWorker — the tested Node reference createWorker factory.
 *
 *   var kernel = new Kernel({
 *     createWorker: nodeCreateWorker({ hostPath, kernelPath }),
 *     ...
 *   });
 *
 * Each process worker: fresh worker_thread running BOOT_SOURCE, which loads
 * host.js, builds a KernelClient over the kernel page, gives the process a
 * private in-memory BlockFS (per-process fs is Phase 1 scope — a shared
 * OPFS store is the browser story, a shared SAB store is future Node work),
 * chdirs to the spawn cwd, and runs the image. stdout/stderr flow back as
 * {type:'out'} messages (bytes copied out of wasm memory first — postMessage
 * would otherwise clone the whole wasm heap or ship a detached view).
 * fd_actions are NOT applied yet (Phase 4, with pipes); they arrive in
 * workerData for forward compatibility.
 * ============================================================ */
var BOOT_SOURCE = [
  "'use strict';",
  "var wt = require('worker_threads');",
  "var wd = wt.workerData;",
  "var runModule = require(wd.hostPath);",
  "var K = require(wd.kernelPath);",
  "var BLOCK_FS = runModule.BLOCK_FS;",
  "var client = new K.KernelClient(wd.kernelPage, function (m) { wt.parentPort.postMessage(m); });",
  "var store = new BLOCK_FS.MemoryByteStore(1 << 20);",
  "var bfs = BLOCK_FS.createV4(store);",
  "if (wd.cwd && wd.cwd !== '/') { try { bfs.chdir(wd.cwd); } catch (e) {} }",
  "function envObj(envp) { var o = {}; (envp || []).forEach(function (s) {",
  "  var i = s.indexOf('='); if (i > 0) o[s.slice(0, i)] = s.slice(i + 1); }); return o; }",
  "function ship(fd) { return function (b) {",
  "  var u = (b instanceof Uint8Array) ? b : new Uint8Array(b);",
  "  wt.parentPort.postMessage({ type: 'out', fd: fd, bytes: u.slice() }); }; }",
  "runModule({",
  "  bytes: wd.image,",
  "  args: wd.argv,",
  "  env: envObj(wd.envp),",
  "  blockFsFactory: function (ctx) { return Promise.resolve({ c: bfs.toWasmEnv(ctx) }); },",
  "  writeOut: ship(1),",
  "  writeErr: ship(2),",
  "  spawnHooks: client.spawnHooks(),",
  "  pid: wd.pid,",
  "  ppid: wd.ppid,",
  "}).then(function (code) {",
  "  wt.parentPort.postMessage({ type: 'exited', code: code });",
  "}, function (e) {",
  "  wt.parentPort.postMessage({ type: 'crashed', error: String((e && e.stack) || e) });",
  "});",
].join('\n');

function nodeCreateWorker(config) {
  if (typeof process === 'undefined') {
    throw new Error('nodeCreateWorker: Node only (the browser factory ships with the os/ page)');
  }
  var hostPath = config.hostPath, kernelPath = config.kernelPath;
  var Worker = require('worker_threads').Worker;
  return function createWorker(procSpec) {
    // The image crosses as a plain ArrayBuffer clone (images are re-spawnable;
    // never transfer). The kernel page crosses as the SAB it is.
    var image = procSpec.image;
    var imageBuf = image instanceof Uint8Array
      ? image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength)
      : image;
    var w = new Worker(BOOT_SOURCE, {
      eval: true,
      workerData: {
        hostPath: hostPath,
        kernelPath: kernelPath,
        pid: procSpec.pid, ppid: procSpec.ppid, pgid: procSpec.pgid,
        path: procSpec.path, argv: procSpec.argv, envp: procSpec.envp,
        cwd: procSpec.cwd, actions: procSpec.actions, flags: procSpec.flags,
        image: imageBuf,
        kernelPage: procSpec.kernelPage,
      },
      // Program stdout/stderr flow through {type:'out'} messages (writeOut/
      // writeErr are overridden in BOOT_SOURCE); the worker's own process
      // streams stay inherited so stray diagnostics remain visible.
    });
    return {
      postMessage: function (m) { w.postMessage(m); },
      onMessage: function (fn) { w.on('message', fn); },
      onExit: function (fn) { w.on('exit', fn); },
      terminate: function () { w.terminate(); },
    };
  };
}

/* ---- environment exports (host.js discipline) ---- */
var KERNEL_EXPORTS = {
  Kernel: Kernel,
  KernelClient: KernelClient,
  nodeCreateWorker: nodeCreateWorker,
  OP: OP,
  SIG: SIG,
  KP_SIZE: KP_SIZE,
  KP_DOORBELL: KP_DOORBELL,
  KP_SIGPEND: KP_SIGPEND,
  KP_SIGBLOCK: KP_SIGBLOCK,
  KP_FLAGS: KP_FLAGS,
  KP_RPC_STATE: KP_RPC_STATE,
  KP_RPC_OP: KP_RPC_OP,
  KP_RPC_LEN: KP_RPC_LEN,
  KP_PAYLOAD_OFF: KP_PAYLOAD_OFF,
  RPC_IDLE: RPC_IDLE,
  RPC_REQUEST: RPC_REQUEST,
  RPC_DONE: RPC_DONE,
  writePayload: writePayload,
  readPayload: readPayload,
  W_EXITCODE: W_EXITCODE,
  W_TERMSIG: W_TERMSIG,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = KERNEL_EXPORTS;
} else if (typeof window !== 'undefined') {
  window.KERNEL = KERNEL_EXPORTS;
} else if (typeof self !== 'undefined') {
  self.KERNEL = KERNEL_EXPORTS;
}
