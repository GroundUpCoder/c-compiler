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
//   Phase 3 (todos/0002) — the Tty object: kernel-side line discipline,
//     termios RPCs, control chars as fg-pgroup signals (Ctrl-C = SIGINT).
//   Phase 4 (todos/0003) — pipes as OFDs (PIPE_CREATE + kernel-side buffers,
//     blocking read/write via deferred RPCs, EOF/EPIPE + SIGPIPE, select
//     readiness) and job control (STOPPED state, cooperative stop at safe
//     points via KP_FLAGS.STOP, SIGCONT resume, WUNTRACED/WCONTINUED,
//     SIGTTIN for background tty readers).
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
var KP_RPC_KIND = 7;               // payload encoding: RPCK_JSON | RPCK_RAW
var KP_PAYLOAD_OFF = 32;           // byte offset of the payload region
var KP_SIZE = 64 * 1024;           // fits compile stdout/stderr comfortably
var KP_PAYLOAD_CAP = KP_SIZE - KP_PAYLOAD_OFF;

var RPC_IDLE = 0, RPC_REQUEST = 1, RPC_DONE = 2;
var KF_STOP = 1;                   // KP_FLAGS bit0: park at the next safe point
var RPCK_JSON = 0, RPCK_RAW = 1;   // RAW: fs read/write bulk bytes — no JSON,
                                   // no structured clone, one memcpy each way

/* Opcode space (todos/KERNEL.md): 0x00xx process, 0x01xx tty, 0x02xx pipes,
 * 0x03xx misc, 0x04xx brokered fs, 0x05xx AF_UNIX sockets, 0x1xxx reserved
 * for WM surfaces. Only the ops the current phase implements are
 * dispatched; the rest respond ENOSYS. */
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
  TCGETATTR: 0x0101,
  TCSETATTR: 0x0102,
  TCGETPGRP: 0x0103,
  TCSETPGRP: 0x0104,
  // 0x02xx pipes. Post-0009 only CREATE is an opcode: the design doc's
  // PIPE_REF/CLOSE/WAIT/NOTIFY are subsumed by the kernel-owned fd layer
  // (OFD refcounts + FS_READ/FS_WRITE/FS_CLOSE + the doorbell).
  PIPE_CREATE: 0x0201,
  COMPILE: 0x0301,
  // 0x04xx — the brokered filesystem (KERNEL.md "fd/data-plane amendment").
  FS_OPEN: 0x0401, FS_CLOSE: 0x0402, FS_READ: 0x0403, FS_WRITE: 0x0404,
  FS_LSEEK: 0x0405, FS_STAT: 0x0406, FS_LSTAT: 0x0407, FS_FSTAT: 0x0408,
  FS_ACCESS: 0x0409, FS_UNLINK: 0x040A, FS_RENAME: 0x040B, FS_MKDIR: 0x040C,
  FS_RMDIR: 0x040D, FS_LINK: 0x040E, FS_SYMLINK: 0x040F, FS_READLINK: 0x0410,
  FS_FTRUNCATE: 0x0411, FS_CHMOD: 0x0412, FS_FCHMOD: 0x0413, FS_CHDIR: 0x0414,
  FS_GETCWD: 0x0415, FS_DUP: 0x0416, FS_DUP2: 0x0417, FS_OPENDIR: 0x0418,
  FS_REALPATH: 0x0419, FS_UTIME: 0x041A, FS_FUTIME: 0x041B, FS_ISATTY: 0x041C,
  FS_SELECT: 0x041D, FS_FCNTL_DUPFD: 0x041E,
  // 0x05xx — AF_UNIX sockets (todos/0008). Stream-only; data flows through
  // FS_READ/FS_WRITE/FS_CLOSE/FS_SELECT like every other OFD kind.
  SOCK_SOCKET: 0x0501, SOCK_BIND: 0x0502, SOCK_LISTEN: 0x0503,
  SOCK_ACCEPT: 0x0504, SOCK_CONNECT: 0x0505, SOCK_PAIR: 0x0506,
  SOCK_SHUTDOWN: 0x0507,
};

/* Wait options / status packing — must match <sys/wait.h>. */
var WNOHANG = 0x01, WUNTRACED = 0x02, WCONTINUED = 0x08;
function W_EXITCODE(code) { return (code & 0xff) << 8; }
function W_TERMSIG(sig) { return sig & 0x7f; }
function W_STOPCODE(sig) { return ((sig & 0xff) << 8) | 0x7f; }
var W_CONTINUED_STATUS = 0xffff;

/* Pipes (todos/0003): kernel-side buffers — rendezvous, not bulk data.
 * PIPE_ATOMIC mirrors POSIX PIPE_BUF (writes that small never interleave:
 * they defer whole rather than land partially). */
var PIPE_CAP = 64 * 1024;
var PIPE_ATOMIC = 512;

/* AF_UNIX sockets (todos/0008): a connection is two pipe-shaped directions
 * (same fields, same waiter queues), so the entire blocking/EOF/EPIPE/
 * select machinery is the pipe machinery. */
function sockDir() {
  return { buf: [], cap: PIPE_CAP, rOpen: true, wOpen: true,
           readWaiters: [], writeWaiters: [] };
}
var S_IFSOCK_MODE = 0o140000;

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
  Atomics.store(i32, KP_RPC_KIND, RPCK_JSON);
  return true;
}

function writeRawPayload(i32, u8, bytes) {
  if (bytes.length > KP_PAYLOAD_CAP) return false;
  u8.set(bytes, KP_PAYLOAD_OFF);
  Atomics.store(i32, KP_RPC_LEN, bytes.length);
  Atomics.store(i32, KP_RPC_KIND, RPCK_RAW);
  return true;
}

function readPayload(i32, u8) {
  var len = Atomics.load(i32, KP_RPC_LEN);
  if (Atomics.load(i32, KP_RPC_KIND) === RPCK_RAW) {
    var raw = new Uint8Array(len);
    raw.set(u8.subarray(KP_PAYLOAD_OFF, KP_PAYLOAD_OFF + len));
    return { raw: raw };
  }
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
/* Raw-payload variant (FS_WRITE): `bytes` land in the payload region as-is
 * (op-specific layout); the response comes back through the same
 * readPayload (JSON or raw). */
KernelClient.prototype.callRaw = function (op, bytes, interruptible) {
  if (!writeRawPayload(this._i32, this._u8, bytes)) return { errno: 'E2BIG' };
  return this._finish(op, interruptible);
};

KernelClient.prototype.call = function (op, req, interruptible) {
  if (!writePayload(this._i32, this._u8, req)) return { errno: 'E2BIG' };
  return this._finish(op, interruptible);
};

KernelClient.prototype._finish = function (op, interruptible) {
  this._stopWait();          // a stopped process issues no new syscalls
  var i32 = this._i32;
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

/* Job control (todos/0003): park while the kernel asserts STOP, until
 * SIGCONT clears the flag (SIGKILL terminates the worker outright). Runs at
 * the two safe-point families a process is guaranteed to hit: entry to
 * every kernel RPC (_finish — i.e. every brokered syscall) and sigpoll
 * (host.js's env-import return probe, when __sig_dispatch is exported). */
KernelClient.prototype._stopWait = function () {
  var i32 = this._i32;
  while (Atomics.load(i32, KP_FLAGS) & KF_STOP) {
    var seq = Atomics.load(i32, KP_DOORBELL);
    if (!(Atomics.load(i32, KP_FLAGS) & KF_STOP)) break;
    Atomics.wait(i32, KP_DOORBELL, seq);
  }
};

/* Atomically claim all deliverable pending signals; returns the claimed
 * mask (0 if none). Blocked bits stay pending until sigmask() unblocks. */
KernelClient.prototype.sigpoll = function () {
  this._stopWait();
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
    setpgid: function (pid, pgid) { return self.call(OP.SETPGID, { pid: pid, pgid: pgid }); },
    getpgid: function (pid) { return self.call(OP.GETPGID, { pid: pid }); },
    sigdisp: function (sig, kind) { self.call(OP.SIGDISP, { sig: sig, kind: kind }); },
    compile: function (argv, cwd) { return self.call(OP.COMPILE, { argv: argv, cwd: cwd }); },
    sigpoll: function () { return self.sigpoll(); },
    sigmask: function (mask) { self.sigmask(mask); },
    park: function (ms) { return self.park(ms); },
    exit: function (status) { return self.call(OP.EXIT, { code: status }); },
    // Phase 3 tty control plane (line discipline lives kernel-side).
    ttyGetattr: function () { return self.call(OP.TCGETATTR, {}); },
    ttySetattr: function (actions, t) {
      return self.call(OP.TCSETATTR, {
        actions: actions, iflag: t.iflag, oflag: t.oflag,
        cflag: t.cflag, lflag: t.lflag, cc: t.cc,
      });
    },
    ttyGetpgrp: function () { return self.call(OP.TCGETPGRP, {}); },
    ttySetpgrp: function (pgid) { return self.call(OP.TCSETPGRP, { pgid: pgid }); },
  };
};

/* ============================================================
 * Tty — the terminal as a kernel object (todos/KERNEL.md Phase 3).
 *
 * The tty SAB is the same ring format host.js's BlockFS stdin path already
 * consumes (SI_* header, 32 bytes, ring after) — the kernel is simply the
 * producer where the page used to be, and the LINE DISCIPLINE moves here:
 * canonical-mode editing (erase/kill/EOF), echo, ICRNL, and ISIG control
 * chars routed as signals to the FOREGROUND PROCESS GROUP (VINTR -> SIGINT:
 * Ctrl-C finally means something). The UI bridge stays dumb — raw bytes in
 * via tty.input(), echo/output bytes out via the output callback; a
 * scripted bridge (tests, agents) and xterm.js are two consumers of the
 * same byte protocol (OS.md "agent-friendly by construction").
 *
 * v1 scope (documented limits): ONE tty per system, attached to every
 * process; single-ACTIVE-reader assumption (the ring consume path is not
 * multi-consumer-atomic — real shells park in waitpid while the fg child
 * reads, so this holds in practice; brokered mode formalizes it with
 * SIGTTIN for background readers, see the FS_READ dispatch);
 * VEOF on an empty line is sticky EOF, not transient.
 * ============================================================ */

/* SI_* header layout — MUST match host.js (BlockFS setStdinSab). */
var SI_SEQ = 0, SI_AVAIL = 1, SI_WRITEPOS = 2, SI_READPOS = 3,
    SI_EOF = 4, SI_COLS = 5, SI_ROWS = 6, SI_TERMIOS = 7;
var SI_HDR_BYTES = 32;

/* termios bits the line discipline consults — MUST match <termios.h>. */
var T_ICRNL = 0x100, T_INLCR = 0x40, T_IGNCR = 0x80;          // c_iflag
var T_OPOST = 0x1, T_ONLCR = 0x2;                              // c_oflag
var T_ECHOE = 0x2, T_ECHOK = 0x4, T_ECHO = 0x8, T_ECHONL = 0x10,
    T_ISIG = 0x80, T_ICANON = 0x100;                           // c_lflag
var V_EOF = 0, V_ERASE = 3, V_KILL = 5, V_INTR = 8, V_QUIT = 9,
    V_SUSP = 10, V_START = 12, V_STOP = 13, V_MIN = 16, V_TIME = 17;
var NCCS = 20;
var TCSAFLUSH = 2;

function defaultCc() {
  var cc = new Array(NCCS).fill(0);
  cc[V_EOF] = 4;      // ^D
  cc[V_ERASE] = 127;  // DEL
  cc[V_KILL] = 21;    // ^U
  cc[V_INTR] = 3;     // ^C
  cc[V_QUIT] = 28;    // ^\
  cc[V_SUSP] = 26;    // ^Z
  cc[V_START] = 17;   // ^Q
  cc[V_STOP] = 19;    // ^S
  cc[V_MIN] = 1;
  return cc;
}

function Tty(kernel, opts) {
  this._kernel = kernel;
  this._output = opts.output || function () {};
  var ringSize = opts.ringSize || 64 * 1024;
  this.sab = new SharedArrayBuffer(SI_HDR_BYTES + ringSize);
  this._i32 = new Int32Array(this.sab, 0, 8);
  this._ring = new Uint8Array(this.sab, SI_HDR_BYTES, ringSize);
  Atomics.store(this._i32, SI_COLS, opts.cols || 80);
  Atomics.store(this._i32, SI_ROWS, opts.rows || 24);
  this.fgPgid = 0;              // set at boot; tcsetpgrp moves it
  this._line = [];              // canonical-mode edit buffer
  // Brokered mode (the fd/data-plane amendment): cooked bytes queue here
  // and the kernel serves deferred FS_READ RPCs from it — the SAB ring is
  // unused for data (the header still carries winsize for TIOCGWINSZ).
  // Ring mode (standalone pages) keeps the Phase-3 behavior.
  this._brokered = false;
  this._cooked = [];
  this._eofFlag = false;
  // Bridge-declared: a human terminal is attached, so std fd 1/2 should be
  // tty-kind (isatty true -> shells prompt). See Kernel._stdOfds.
  this.interactiveOut = !!opts.interactiveOut;
  this.termios = {
    iflag: T_ICRNL,
    oflag: T_OPOST | T_ONLCR,
    cflag: 0xB00,               // CS8|CREAD (matches the legacy canned value)
    lflag: T_ISIG | T_ICANON | T_ECHO | T_ECHOE | T_ECHOK,
    cc: defaultCc(),
  };
  this._publishModeWord();
}

/* Legacy 3-bit mode word (icanon/echo/opost) — kept current so pre-kernel
 * page observers keep working; nothing kernel-side reads it back. */
Tty.prototype._publishModeWord = function () {
  var t = this.termios;
  var mode = ((t.lflag & T_ICANON) ? 1 : 0) | ((t.lflag & T_ECHO) ? 2 : 0)
    | ((t.oflag & T_OPOST) ? 4 : 0);
  Atomics.store(this._i32, SI_TERMIOS, mode);
};

/* Wake anything parked on the ring futex (readers re-scan; also rung by the
 * kernel when it posts a signal, so a blocked read can turn into EINTR). */
Tty.prototype.wakeReaders = function () {
  Atomics.add(this._i32, SI_SEQ, 1);
  Atomics.notify(this._i32, SI_SEQ);
};

/* Commit cooked bytes: brokered mode queues them for deferred FS_READ
 * RPCs; ring mode writes the shared ring. Overflow drops (like a real tty
 * input queue) — loudly, via the kernel log. */
Tty.prototype._push = function (bytes) {
  if (this._brokered) {
    for (var bi = 0; bi < bytes.length; bi++) this._cooked.push(bytes[bi]);
    this._kernel._ttyNotify(this);
    return;
  }
  var i32 = this._i32, ring = this._ring, size = ring.length;
  var free = size - Atomics.load(i32, SI_AVAIL);
  var n = Math.min(bytes.length, free);
  if (n < bytes.length) this._kernel._log('tty: input ring overflow, dropping ' + (bytes.length - n) + ' bytes');
  var wp = Atomics.load(i32, SI_WRITEPOS);
  for (var k = 0; k < n; k++) ring[(wp + k) % size] = bytes[k];
  Atomics.store(i32, SI_WRITEPOS, (wp + n) % size);
  Atomics.add(i32, SI_AVAIL, n);
  this.wakeReaders();
};

Tty.prototype._echo = function (bytes) {
  if (bytes.length) this._output(Uint8Array.from(bytes));
};

Tty.prototype._echoNl = function () {
  var t = this.termios;
  this._echo((t.oflag & T_OPOST) && (t.oflag & T_ONLCR) ? [13, 10] : [10]);
};

Tty.prototype._signalFg = function (sig) {
  // Route by pgid directly — NOT via kill(-pgid): a foreground pgid of 1
  // would encode as kill(-1), which POSIX reserves for "every process".
  if (this.fgPgid > 0) this._kernel._killPgid(this.fgPgid, sig);
};

/* Raw bytes from the UI bridge (keystrokes). String or Uint8Array. */
Tty.prototype.input = function (data) {
  var bytes = typeof data === 'string' ? textEncoder.encode(data) : data;
  var t = this.termios;
  var raw = [];
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b === 13) {
      if (t.iflag & T_IGNCR) continue;
      if (t.iflag & T_ICRNL) b = 10;
    } else if (b === 10 && (t.iflag & T_INLCR)) {
      b = 13;
    }
    if (t.lflag & T_ISIG) {
      var sig = b === t.cc[V_INTR] ? SIG.INT
        : b === t.cc[V_QUIT] ? SIG.QUIT
        : b === t.cc[V_SUSP] ? SIG.TSTP : 0;
      if (sig) {
        if (raw.length) { this._push(raw); raw = []; }
        this._line.length = 0;                       // POSIX: flush the edit buffer
        if (t.lflag & T_ECHO) { this._echo([94, 64 + (b & 31)]); this._echoNl(); } // ^C style
        this._signalFg(sig);
        continue;
      }
    }
    if (t.lflag & T_ICANON) {
      if (b === t.cc[V_ERASE]) {
        if (this._line.length) {
          this._line.pop();
          if ((t.lflag & T_ECHO) && (t.lflag & T_ECHOE)) this._echo([8, 32, 8]);
        }
        continue;
      }
      if (b === t.cc[V_KILL]) {
        if ((t.lflag & T_ECHO) && (t.lflag & T_ECHOK)) {
          while (this._line.length) { this._line.pop(); this._echo([8, 32, 8]); }
        } else {
          this._line.length = 0;
        }
        continue;
      }
      if (b === t.cc[V_EOF]) {
        if (this._line.length) { this._push(this._line); this._line = []; }
        else this.eof();                             // sticky EOF (v1)
        continue;
      }
      if (b === 10) {
        this._line.push(10);
        if (t.lflag & (T_ECHO | T_ECHONL)) this._echoNl();
        this._push(this._line);
        this._line = [];
        continue;
      }
      this._line.push(b);
      if (t.lflag & T_ECHO) this._echo([b]);
    } else {
      raw.push(b);
      if (t.lflag & T_ECHO) this._echo([b]);
    }
  }
  if (raw.length) this._push(raw);
};

/* The bridge reports a resize; the fg pgroup learns via SIGWINCH. */
Tty.prototype.resize = function (cols, rows) {
  var changed = Atomics.load(this._i32, SI_COLS) !== cols ||
    Atomics.load(this._i32, SI_ROWS) !== rows;
  Atomics.store(this._i32, SI_COLS, cols);
  Atomics.store(this._i32, SI_ROWS, rows);
  if (changed) this._signalFg(SIG.WINCH);
};

/* End of input (agent closed stdin / user hit the page's EOF control). */
Tty.prototype.eof = function () {
  this._eofFlag = true;
  Atomics.store(this._i32, SI_EOF, 1);
  if (this._brokered) { this._kernel._ttyNotify(this); return; }
  this.wakeReaders();
};

/* Brokered readiness (select) and read service. */
Tty.prototype.readable = function () {
  return this._cooked.length > 0 || this._eofFlag;
};
Tty.prototype.take = function (count) {
  var n = Math.min(count, this._cooked.length);
  return Uint8Array.from(this._cooked.splice(0, n));
};

Tty.prototype.getattr = function () {
  var t = this.termios;
  return { iflag: t.iflag, oflag: t.oflag, cflag: t.cflag, lflag: t.lflag, cc: t.cc.slice() };
};

Tty.prototype.setattr = function (actions, t) {
  this.termios.iflag = t.iflag >>> 0;
  this.termios.oflag = t.oflag >>> 0;
  this.termios.cflag = t.cflag >>> 0;
  this.termios.lflag = t.lflag >>> 0;
  if (Array.isArray(t.cc)) {
    for (var i = 0; i < NCCS; i++) this.termios.cc[i] = (t.cc[i] | 0) & 0xff;
  }
  if (actions === TCSAFLUSH) {
    // Discard unread input (rare; the benign race with a mid-read consumer
    // is acceptable — flush during concurrent reads is undefined anyway).
    Atomics.store(this._i32, SI_READPOS, Atomics.load(this._i32, SI_WRITEPOS));
    Atomics.store(this._i32, SI_AVAIL, 0);
    this._line = [];
  }
  this._publishModeWord();
  this.wakeReaders();
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
var STATE_RUNNING = 'running', STATE_STOPPED = 'stopped', STATE_ZOMBIE = 'zombie';

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
  this._tty = null;
  // The brokered filesystem (KERNEL.md "fd/data-plane amendment"): with an
  // opts.fs BlockFS instance, the kernel owns per-process fd tables over a
  // system-wide open-file-description table, and processes reach the fs via
  // 0x04xx RPCs (host.js RemoteFS). Without opts.fs, processes keep their
  // own private in-process fs (the standalone/Phase-1 arrangement).
  this._fs = opts.fs || null;
  this._brokered = !!opts.fs;
  this._ofds = new Map();    // ofdId -> { id, kind:'file'|'tty'|'out'|'null'|'pipe'|'socket', refs, bfsFd?, ch?, pipe?, end?, st?, rx?, tx?, path?, backlog?, pending?, acceptWaiters? }
  this._nextOfd = 1;
  this._std = null;          // lazy singleton OFDs for default stdio
  this._ttyWaiters = [];     // pids with a deferred tty FS_READ, FIFO
  this._sockBinds = new Map(); // resolved path -> listener/bound socket ofdId
}

Kernel.prototype._makeOfd = function (kind, extra) {
  var o = { id: this._nextOfd++, kind: kind, refs: 0 };
  if (extra) for (var k in extra) o[k] = extra[k];
  this._ofds.set(o.id, o);
  return o;
};

Kernel.prototype._ofdUnref = function (id) {
  var o = this._ofds.get(id);
  if (!o || --o.refs > 0) return;
  this._ofds.delete(id);
  if (o.kind === 'file') this._fs.close(o.bfsFd);
  else if (o.kind === 'pipe') {
    // Last reference to this end anywhere in the system: the peers must
    // learn (readers see EOF, writers see EPIPE + SIGPIPE).
    if (o.end === 'read') o.pipe.rOpen = false; else o.pipe.wOpen = false;
    this._pipeNotify(o.pipe);
  } else if (o.kind === 'socket') {
    if (o.st === 'conn') {
      // Both directions lose this side: the peer reads EOF and writes EPIPE.
      o.rx.rOpen = false; o.tx.wOpen = false;
      this._pipeNotify(o.rx); this._pipeNotify(o.tx);
    } else if (o.st === 'listening' || o.st === 'bound') {
      // Unregister the rendezvous (only if it still points here — a
      // rebind after unlink may have replaced the entry).
      if (this._sockBinds.get(o.path) === o.id) this._sockBinds.delete(o.path);
      if (o.st === 'listening') {
        // Never-accepted queued connections: their client ends must learn.
        for (var pi = 0; pi < o.pending.length; pi++) {
          var pc = o.pending[pi];
          pc.rx.rOpen = false; pc.tx.wOpen = false;
          this._pipeNotify(pc.rx); this._pipeNotify(pc.tx);
        }
        o.pending.length = 0;
      }
    }
  }
};

Kernel.prototype._stdOfds = function () {
  if (!this._std) {
    // interactiveOut (a createTty opt, set by the UI bridge): fd 1/2 are
    // THE TTY, like a real login terminal — isatty(1) turns true and
    // shells go interactive (prompts, line editing, job control). Without
    // it (piped/CI runs) stdout stays a plain output channel and program
    // output is byte-clean. Writes route identically either way; only the
    // OFD kind (and thus isatty) differs.
    var ttyStd = this._tty && this._tty.interactiveOut;
    this._std = {
      in_: this._makeOfd(this._tty ? 'tty' : 'null', { ch: 0 }),
      out: this._makeOfd(ttyStd ? 'tty' : 'out', { ch: 1 }),
      err: this._makeOfd(ttyStd ? 'tty' : 'out', { ch: 2 }),
    };
  }
  return this._std;
};

/* Absolute path in `pcb`'s working directory (BlockFS normalizes . and ..
 * on absolute paths; the kernel only supplies the base). */
Kernel.prototype._pathFor = function (pcb, p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p.charCodeAt(0) === 47) return p;
  return (pcb.cwd === '/' ? '' : pcb.cwd) + '/' + p;
};

/* Create the system tty (call BEFORE boot; v1: one tty, attached to every
 * process). opts: { cols, rows, ringSize, output(bytes) } — output receives
 * echo/control bytes for the UI bridge to render; process stdout still
 * flows through onOutput. Returns the Tty (input/resize/eof/sab). */
Kernel.prototype.createTty = function (opts) {
  this._tty = new Tty(this, opts || {});
  this._tty._brokered = this._brokered;
  return this._tty;
};

/* Boot the system: spawn pid 1 (init). spec: {path, argv, envp, cwd}.
 * Resolves to init's pid (1); rejects if the image can't be loaded. */
Kernel.prototype.boot = function (spec) {
  var self = this;
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
    if (self._tty && !self._tty.fgPgid) {
      var init = self._procs.get(r.pid);
      self._tty.fgPgid = init ? init.pgid : r.pid;
    }
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
      pendingStop: 0,                // stop signal not yet reported via WUNTRACED
      pendingCont: false,            // continue not yet reported via WCONTINUED
      children: new Set(),
      envp: spec.envp !== null && spec.envp !== undefined ? spec.envp
        : (parent ? parent.envp : []),
      cwd: spec.cwd !== null && spec.cwd !== undefined ? spec.cwd
        : (parent ? parent.cwd : '/'),
      sigdisp: new Int8Array(NSIG),  // __on_sigdisp mirror; all DFL initially
      // ONE deferred RPC at a time (the worker is parked):
      // {op:'wait',sel,options} | {op:'ttyread',count} | {op:'select',r,w,timer}
      // | {op:'piperead',pipe,count} | {op:'pipewrite',pipe,data}
      waiter: null,
      fds: new Map(),                // procFd -> ofdId (brokered mode)
      page: null, i32: null, u8: null,
      worker: null,
      tty: self._tty,                // v1: the one system tty (or null)
    };
    var sab = new SharedArrayBuffer(KP_SIZE);
    pcb.page = sab;
    pcb.i32 = new Int32Array(sab);
    pcb.u8 = new Uint8Array(sab);

    // Brokered fd table: full POSIX inheritance (every parent fd, sharing
    // the open file descriptions), then the spawn file_actions in order.
    // The kernel IS the parent's fd table, so no translation is needed —
    // the payoff of the fd/data-plane amendment.
    if (self._brokered) {
      var inherit = parent ? parent.fds : null;
      if (inherit) {
        inherit.forEach(function (ofdId, fd) {
          var o = self._ofds.get(ofdId);
          if (o) { o.refs++; pcb.fds.set(fd, ofdId); }
        });
      } else {
        var std = self._stdOfds();
        std.in_.refs++; pcb.fds.set(0, std.in_.id);
        std.out.refs++; pcb.fds.set(1, std.out.id);
        std.err.refs++; pcb.fds.set(2, std.err.id);
      }
      var actions = spec.actions || [];
      for (var ai = 0; ai < actions.length; ai++) {
        var a = actions[ai];
        var fail = null;
        if (a.op === 0) {           // DUP2: child fd `arg` -> child fd `fd`
          var srcId = pcb.fds.get(a.arg);
          if (srcId === undefined) fail = 'EBADF';
          else {
            self._ofds.get(srcId).refs++;
            var oldId = pcb.fds.get(a.fd);
            if (oldId !== undefined) self._ofdUnref(oldId);
            pcb.fds.set(a.fd, srcId);
          }
        } else if (a.op === 1) {    // OPEN path at fd (arg = oflag)
          var bfsFd = self._fs.open(self._pathFor(pcb, a.path), a.arg | 0, a.mode | 0);
          if (bfsFd === null) fail = self._fs._lastError || 'EIO';
          else {
            var no = self._makeOfd('file', { bfsFd: bfsFd });
            no.refs++;
            var prevId = pcb.fds.get(a.fd);
            if (prevId !== undefined) self._ofdUnref(prevId);
            pcb.fds.set(a.fd, no.id);
          }
        } else if (a.op === 2) {    // CLOSE
          var cId = pcb.fds.get(a.fd);
          if (cId !== undefined) { self._ofdUnref(cId); pcb.fds.delete(a.fd); }
        }
        if (fail) {
          pcb.fds.forEach(function (id) { self._ofdUnref(id); });
          return { errno: fail };
        }
      }
    }

    self._procs.set(pid, pcb);
    if (parent) parent.children.add(pid);
    var procSpec = {
      pid: pid, ppid: pcb.ppid, pgid: pcb.pgid,
      path: spec.path,
      argv: (spec.argv && spec.argv.length) ? spec.argv : [spec.path],
      envp: pcb.envp,
      cwd: pcb.cwd,
      actions: spec.actions || [],   // brokered: already applied kernel-side above
      flags: spec.flags | 0,
      image: image,
      kernelPage: sab,
      ttySab: pcb.tty ? pcb.tty.sab : null,
      brokered: self._brokered,
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
  // STOPPED still accepts messages: a krpc/exit can race the stop, and
  // dropping the krpc would deadlock the parked worker awaiting a response.
  if (!msg || pcb.state === STATE_ZOMBIE) return;
  switch (msg.type) {
    case 'krpc': this._dispatchRpc(pcb); break;
    // A parked interruptible RPC (WAIT / tty FS_READ / FS_SELECT / pipe
    // FS_READ/FS_WRITE) noticed a deliverable signal: answer EINTR if it's
    // still registered. If the real
    // result raced in first, the waiter is already gone — ignore, the signal
    // delivers at the caller's next safe point anyway.
    case 'krpc-intr':
      if (pcb.waiter) { this._cancelWaiter(pcb); this._respond(pcb, { errno: 'EINTR' }); }
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
    case OP.TCGETATTR:
      this._respond(pcb, pcb.tty ? pcb.tty.getattr() : { errno: 'ENOTTY' });
      break;
    case OP.TCSETATTR:
      if (!pcb.tty) { this._respond(pcb, { errno: 'ENOTTY' }); break; }
      pcb.tty.setattr(req.actions | 0, req);
      this._respond(pcb, {});
      break;
    case OP.TCGETPGRP:
      this._respond(pcb, pcb.tty ? { pgid: pcb.tty.fgPgid } : { errno: 'ENOTTY' });
      break;
    case OP.TCSETPGRP:
      if (!pcb.tty) { this._respond(pcb, { errno: 'ENOTTY' }); break; }
      if (!(req.pgid > 0)) { this._respond(pcb, { errno: 'EINVAL' }); break; }
      pcb.tty.fgPgid = req.pgid | 0;
      this._respond(pcb, {});
      break;
    case OP.PIPE_CREATE: {
      // Pipes are just another OFD kind (the fd/data-plane amendment's
      // payoff): two descriptions over one kernel-side buffer, riding the
      // same fd tables, inheritance, fd_actions, FS_READ/WRITE/CLOSE and
      // select paths as files. Brokered mode only — standalone pages keep
      // host.js's in-process pipes.
      if (!this._brokered) { this._respond(pcb, { errno: 'ENOSYS' }); break; }
      var pipe = {
        buf: [], cap: PIPE_CAP, rOpen: true, wOpen: true,
        readWaiters: [], writeWaiters: [],   // pids with a deferred RPC, FIFO
      };
      var ro = this._makeOfd('pipe', { pipe: pipe, end: 'read' });
      var wo = this._makeOfd('pipe', { pipe: pipe, end: 'write' });
      ro.refs++; wo.refs++;
      var rfd = 0; while (pcb.fds.has(rfd)) rfd++;
      pcb.fds.set(rfd, ro.id);
      var wfd = 0; while (pcb.fds.has(wfd)) wfd++;
      pcb.fds.set(wfd, wo.id);
      this._respond(pcb, { rfd: rfd, wfd: wfd });
      break;
    }
    case OP.COMPILE:
      if (!this._compile) { this._respond(pcb, { errno: 'ENOSYS' }); break; }
      Promise.resolve(this._compile(req.argv || [], req.cwd || '/')).then(
        function (r) { self._respond(pcb, r || { errno: 'EIO' }); },
        function (e) {
          self._log('compile hook threw: ' + (e && e.message));
          self._respond(pcb, { errno: 'EIO' });
        });
      break;
    default:
      if ((op & 0xff00) === 0x0400) { this._fsRpc(pcb, op, req); break; }
      if ((op & 0xff00) === 0x0500) { this._sockRpc(pcb, op, req); break; }
      this._respond(pcb, { errno: 'ENOSYS' });
  }
};

Kernel.prototype._respondRaw = function (pcb, bytes) {
  if (!writeRawPayload(pcb.i32, pcb.u8, bytes)) {
    writePayload(pcb.i32, pcb.u8, { errno: 'ENOMEM' });
  }
  Atomics.store(pcb.i32, KP_RPC_STATE, RPC_DONE);
  this._ring(pcb);
};

/* ---- the brokered filesystem (0x04xx) ----
 * One BlockFS instance (this._fs) serves every process; per-process fd maps
 * point at shared open file descriptions. A 'file' OFD is backed by one
 * BlockFS fd of the kernel instance — its position IS the shared offset, so
 * dup/inheritance get POSIX open-file-description semantics for free, and
 * BlockFS's tested unlink-while-open refcounts become system-global. */
Kernel.prototype._fsRpc = function (pcb, op, req) {
  var self = this;
  var fs = this._fs;
  if (!fs) { this._respond(pcb, { errno: 'ENOSYS' }); return; }
  var eFs = function () { return { errno: fs._lastError || 'EIO' }; };
  var ofdOf = function (fd) {
    var id = pcb.fds.get(fd | 0);
    return id === undefined ? null : self._ofds.get(id) || null;
  };
  var allocFd = function (min) {
    var fd = min | 0;
    while (pcb.fds.has(fd)) fd++;
    return fd;
  };
  var P = function (p) { return self._pathFor(pcb, p); };
  var r;

  switch (op) {
    case OP.FS_OPEN: {
      var bfsFd = fs.open(P(req.path), req.flags | 0, req.mode | 0);
      if (bfsFd === null) { this._respond(pcb, eFs()); return; }
      var o = this._makeOfd('file', { bfsFd: bfsFd });
      o.refs++;
      var fd = allocFd(0);
      pcb.fds.set(fd, o.id);
      this._respond(pcb, { fd: fd });
      return;
    }
    case OP.FS_CLOSE: {
      var id = pcb.fds.get(req.fd | 0);
      if (id === undefined) { this._respond(pcb, { errno: 'EBADF' }); return; }
      this._ofdUnref(id);
      pcb.fds.delete(req.fd | 0);
      this._respond(pcb, {});
      return;
    }
    case OP.FS_READ: {
      var o1 = ofdOf(req.fd);
      if (!o1) { this._respond(pcb, { errno: 'EBADF' }); return; }
      var count = Math.min(req.count | 0, KP_PAYLOAD_CAP);
      if (o1.kind === 'file') {
        var buf = new Uint8Array(count);
        var n = fs.read(o1.bfsFd, buf, count);
        if (n === null) { this._respond(pcb, eFs()); return; }
        this._respondRaw(pcb, buf.subarray(0, n));
        return;
      }
      if (o1.kind === 'null') { this._respondRaw(pcb, new Uint8Array(0)); return; }
      if (o1.kind === 'pipe') {
        if (o1.end !== 'read') { this._respond(pcb, { errno: 'EBADF' }); return; }
        this._streamRead(pcb, o1.pipe, count);
        return;
      }
      if (o1.kind === 'socket') {
        if (o1.st !== 'conn') { this._respond(pcb, { errno: 'ENOTCONN' }); return; }
        this._streamRead(pcb, o1.rx, count);
        return;
      }
      if (o1.kind === 'tty') {
        var tty = pcb.tty;
        if (!tty) { this._respondRaw(pcb, new Uint8Array(0)); return; }
        // Job control (todos/0003): a background pgroup reading the tty gets
        // SIGTTIN (stop class); if it's ignored or blocked, POSIX says the
        // read fails with EIO instead. The read itself returns EINTR — after
        // SIGCONT the libc caller retries, now (typically) in the foreground.
        if (tty.fgPgid > 0 && pcb.pgid !== tty.fgPgid) {
          if (pcb.sigdisp[SIG.TTIN] === DISP_IGN ||
              (Atomics.load(pcb.i32, KP_SIGBLOCK) & (1 << (SIG.TTIN - 1)))) {
            this._respond(pcb, { errno: 'EIO' });
            return;
          }
          this._killPgid(pcb.pgid, SIG.TTIN);
          this._respond(pcb, { errno: 'EINTR' });
          return;
        }
        if (tty._cooked.length > 0) { this._respondRaw(pcb, tty.take(count)); return; }
        if (tty._eofFlag) { this._respondRaw(pcb, new Uint8Array(0)); return; }
        pcb.waiter = { op: 'ttyread', count: count };   // served by _ttyNotify
        this._ttyWaiters.push(pcb.pid);
        return;
      }
      this._respond(pcb, { errno: 'EBADF' });           // 'out'
      return;
    }
    case OP.FS_WRITE: {
      // Raw request: [u32 fd][bytes...]
      var rawq = req.raw;
      if (!rawq || rawq.length < 4) { this._respond(pcb, { errno: 'EFAULT' }); return; }
      var wfd = rawq[0] | (rawq[1] << 8) | (rawq[2] << 16) | (rawq[3] << 24);
      var data = rawq.subarray(4);
      var o2 = ofdOf(wfd);
      if (!o2) { this._respond(pcb, { errno: 'EBADF' }); return; }
      if (o2.kind === 'file') {
        var wn = fs.write(o2.bfsFd, data, data.length);
        if (wn === null) { this._respond(pcb, eFs()); return; }
        this._respond(pcb, { n: wn });
        return;
      }
      if (o2.kind === 'pipe') {
        if (o2.end !== 'write') { this._respond(pcb, { errno: 'EBADF' }); return; }
        this._streamWrite(pcb, o2.pipe, data);
        return;
      }
      if (o2.kind === 'socket') {
        if (o2.st !== 'conn') { this._respond(pcb, { errno: 'ENOTCONN' }); return; }
        this._streamWrite(pcb, o2.tx, data);
        return;
      }
      if (o2.kind === 'out') { this._onOutput(pcb.pid, o2.ch, data.slice()); this._respond(pcb, { n: data.length }); return; }
      if (o2.kind === 'tty') { this._onOutput(pcb.pid, o2.ch || 1, data.slice()); this._respond(pcb, { n: data.length }); return; }
      this._respond(pcb, { n: data.length });           // 'null'
      return;
    }
    case OP.FS_LSEEK: {
      var o3 = ofdOf(req.fd);
      if (!o3) { this._respond(pcb, { errno: 'EBADF' }); return; }
      if (o3.kind !== 'file') { this._respond(pcb, { errno: 'ESPIPE' }); return; }
      r = fs.lseek(o3.bfsFd, req.offset, req.whence | 0);
      this._respond(pcb, r === null ? eFs() : { offset: r });
      return;
    }
    case OP.FS_STAT: r = fs.stat(P(req.path)); this._respond(pcb, r === null ? eFs() : { st: r }); return;
    case OP.FS_LSTAT: r = fs.lstat(P(req.path)); this._respond(pcb, r === null ? eFs() : { st: r }); return;
    case OP.FS_FSTAT: {
      var o4 = ofdOf(req.fd);
      if (!o4) { this._respond(pcb, { errno: 'EBADF' }); return; }
      if (o4.kind === 'file') {
        r = fs.fstat(o4.bfsFd);
        this._respond(pcb, r === null ? eFs() : { st: r });
      } else if (o4.kind === 'pipe') {
        this._respond(pcb, { st: { ino: 0, mode: 0x1000 | 0o600, nlink: 1, size: o4.pipe.buf.length, atime: 0, mtime: 0, ctime: 0, rdev: 0 } });
      } else if (o4.kind === 'socket') {
        this._respond(pcb, { st: { ino: 0, mode: S_IFSOCK_MODE | 0o777, nlink: 1, size: o4.st === 'conn' ? o4.rx.buf.length : 0, atime: 0, mtime: 0, ctime: 0, rdev: 0 } });
      } else {
        // Character device (tty / console / null).
        this._respond(pcb, { st: { ino: 0, mode: 0x2000 | 0o666, nlink: 1, size: 0, atime: 0, mtime: 0, ctime: 0, rdev: 0 } });
      }
      return;
    }
    case OP.FS_ACCESS: r = fs.access(P(req.path), req.mode | 0); this._respond(pcb, r === null ? eFs() : {}); return;
    case OP.FS_UNLINK: r = fs.unlink(P(req.path)); this._respond(pcb, r === null ? eFs() : {}); return;
    case OP.FS_RENAME: r = fs.rename(P(req.from), P(req.to)); this._respond(pcb, r === null ? eFs() : {}); return;
    case OP.FS_MKDIR: r = fs.mkdir(P(req.path), req.mode | 0); this._respond(pcb, r === null ? eFs() : {}); return;
    case OP.FS_RMDIR: r = fs.rmdir(P(req.path)); this._respond(pcb, r === null ? eFs() : {}); return;
    case OP.FS_LINK: r = fs.link(P(req.from), P(req.to)); this._respond(pcb, r === null ? eFs() : {}); return;
    case OP.FS_SYMLINK: r = fs.symlink(req.target, P(req.path)); this._respond(pcb, r === null ? eFs() : {}); return;
    case OP.FS_READLINK: {
      // BlockFS.readlink is buffer-style (POSIX shape); the RPC carries the
      // target as a string. PATH_MAX here is BlockFS's path component budget.
      var lbuf = new Uint8Array(4096);
      r = fs.readlink(P(req.path), lbuf, lbuf.length);
      this._respond(pcb, r === null ? eFs()
        : { target: new TextDecoder().decode(lbuf.subarray(0, r)) });
      return;
    }
    case OP.FS_FTRUNCATE: {
      var o5 = ofdOf(req.fd);
      if (!o5 || o5.kind !== 'file') { this._respond(pcb, { errno: 'EBADF' }); return; }
      r = fs.ftruncate(o5.bfsFd, req.size | 0);
      this._respond(pcb, r === null ? eFs() : {});
      return;
    }
    case OP.FS_CHMOD: r = fs.chmod(P(req.path), req.mode | 0); this._respond(pcb, r === null ? eFs() : {}); return;
    case OP.FS_FCHMOD: {
      var o6 = ofdOf(req.fd);
      if (!o6 || o6.kind !== 'file') { this._respond(pcb, { errno: 'EBADF' }); return; }
      r = fs.fchmod(o6.bfsFd, req.mode | 0);
      this._respond(pcb, r === null ? eFs() : {});
      return;
    }
    case OP.FS_UTIME: r = fs.utime(P(req.path), req.atime, req.mtime); this._respond(pcb, r === null ? eFs() : {}); return;
    case OP.FS_FUTIME: {
      var o7 = ofdOf(req.fd);
      if (!o7 || o7.kind !== 'file') { this._respond(pcb, { errno: 'EBADF' }); return; }
      r = fs.futime(o7.bfsFd, req.atime, req.mtime);
      this._respond(pcb, r === null ? eFs() : {});
      return;
    }
    case OP.FS_CHDIR: {
      var abs = P(req.path);
      var resolved;
      try { resolved = fs._resolvePath(abs); } catch (e) { resolved = null; }
      if (!resolved) { this._respond(pcb, { errno: fs._lastError || 'ENOENT' }); return; }
      var st = fs.stat(resolved);
      if (st === null) { this._respond(pcb, eFs()); return; }
      if ((st.mode & 0xF000) !== 0x4000) { this._respond(pcb, { errno: 'ENOTDIR' }); return; }
      pcb.cwd = resolved;
      this._respond(pcb, {});
      return;
    }
    case OP.FS_GETCWD: this._respond(pcb, { cwd: pcb.cwd }); return;
    case OP.FS_DUP: {
      var o8 = ofdOf(req.fd);
      if (!o8) { this._respond(pcb, { errno: 'EBADF' }); return; }
      o8.refs++;
      var dfd = allocFd(0);
      pcb.fds.set(dfd, o8.id);
      this._respond(pcb, { fd: dfd });
      return;
    }
    case OP.FS_DUP2: {
      var o9 = ofdOf(req.fd);
      if (!o9) { this._respond(pcb, { errno: 'EBADF' }); return; }
      if ((req.fd | 0) !== (req.newfd | 0)) {
        o9.refs++;
        var prev = pcb.fds.get(req.newfd | 0);
        if (prev !== undefined) this._ofdUnref(prev);
        pcb.fds.set(req.newfd | 0, o9.id);
      }
      this._respond(pcb, { fd: req.newfd | 0 });
      return;
    }
    case OP.FS_FCNTL_DUPFD: {
      var oA = ofdOf(req.fd);
      if (!oA) { this._respond(pcb, { errno: 'EBADF' }); return; }
      oA.refs++;
      var mfd = allocFd(req.min | 0);
      pcb.fds.set(mfd, oA.id);
      this._respond(pcb, { fd: mfd });
      return;
    }
    case OP.FS_OPENDIR: {
      var dh = fs.opendir(P(req.path));
      if (dh === null) { this._respond(pcb, eFs()); return; }
      var entries = [];
      for (;;) {
        var ent = fs.readdir(dh);
        if (ent === null) break;
        entries.push({ ino: ent.ino, type: ent.type, name: ent.name });
      }
      fs.closedir(dh);
      this._respond(pcb, { entries: entries });
      return;
    }
    case OP.FS_REALPATH: {
      var rp;
      try { rp = fs._resolvePath(P(req.path)); } catch (e) { rp = null; }
      this._respond(pcb, rp ? { path: rp } : { errno: fs._lastError || 'ENOENT' });
      return;
    }
    case OP.FS_ISATTY: {
      var oB = ofdOf(req.fd);
      this._respond(pcb, { tty: oB && oB.kind === 'tty' ? 1 : 0 });
      return;
    }
    case OP.FS_SELECT: {
      var ready = this._selectScan(pcb, req.r || [], req.w || []);
      if (ready.count > 0 || req.timeoutMs === 0) { this._respond(pcb, ready); return; }
      var w = { op: 'select', r: req.r || [], w: req.w || [], timer: null };
      if (req.timeoutMs !== null && req.timeoutMs !== undefined) {
        w.timer = setTimeout(function () {
          if (pcb.waiter === w) {
            self._cancelWaiter(pcb);
            self._respond(pcb, self._selectScan(pcb, w.r, w.w));
          }
        }, req.timeoutMs);
      }
      pcb.waiter = w;                                   // completed by _ttyNotify
      return;
    }
    default: this._respond(pcb, { errno: 'ENOSYS' });
  }
};

/* ---- AF_UNIX sockets (0x05xx; todos/0008) ----
 * Stream sockets over the pipe machinery: a connection is a pair of
 * pipe-shaped directions (client tx == server rx and vice versa); bind is a
 * real S_IFSOCK node in BlockFS plus an entry in the kernel's rendezvous
 * map; connect never blocks (the queued connection's buffers are usable
 * before accept — data simply waits). Data plane and select ride the
 * existing FS_READ/FS_WRITE/FS_CLOSE/FS_SELECT paths via the 'socket' OFD
 * kind. Brokered mode only, like PIPE_CREATE. */
Kernel.prototype._sockRpc = function (pcb, op, req) {
  var self = this;
  var fs = this._fs;
  if (!this._brokered) { this._respond(pcb, { errno: 'ENOSYS' }); return; }
  var ofdOf = function (fd) {
    var id = pcb.fds.get(fd | 0);
    return id === undefined ? null : self._ofds.get(id) || null;
  };
  var attach = function (target, o) {          // new OFD -> lowest free fd of `target`
    o.refs++;
    var fd = 0;
    while (target.fds.has(fd)) fd++;
    target.fds.set(fd, o.id);
    return fd;
  };
  var sockOf = function (fd) {                 // 'socket'-kind OFD or null+respond
    var o = ofdOf(fd);
    if (!o) { self._respond(pcb, { errno: 'EBADF' }); return null; }
    if (o.kind !== 'socket') { self._respond(pcb, { errno: 'ENOTSOCK' }); return null; }
    return o;
  };

  switch (op) {
    case OP.SOCK_SOCKET: {
      var no = this._makeOfd('socket', { st: 'fresh' });
      this._respond(pcb, { fd: attach(pcb, no) });
      return;
    }
    case OP.SOCK_BIND: {
      var ob = sockOf(req.fd); if (!ob) return;
      if (ob.st !== 'fresh') { this._respond(pcb, { errno: 'EINVAL' }); return; }
      var abs = this._pathFor(pcb, String(req.path || ''));
      // The socket node is a real S_IFSOCK inode (mknod: no data extent) —
      // ls/stat/test -S see it; EEXIST is POSIX's EADDRINUSE here.
      if (fs.mknod(abs, S_IFSOCK_MODE | 0o777, 0) !== 0) {
        var be = fs._lastError || 'EIO';
        this._respond(pcb, { errno: be === 'EEXIST' ? 'EADDRINUSE' : be });
        return;
      }
      var resolved;
      try { resolved = fs._resolvePath(abs); } catch (e) { resolved = abs; }
      ob.st = 'bound';
      ob.path = resolved || abs;
      this._sockBinds.set(ob.path, ob.id);
      this._respond(pcb, {});
      return;
    }
    case OP.SOCK_LISTEN: {
      var ol = sockOf(req.fd); if (!ol) return;
      if (ol.st === 'conn') { this._respond(pcb, { errno: 'EISCONN' }); return; }
      if (ol.st === 'fresh') { this._respond(pcb, { errno: 'EDESTADDRREQ' }); return; }
      var bl = req.backlog | 0;
      if (bl < 1) bl = 1; if (bl > 128) bl = 128;
      if (ol.st === 'bound') { ol.st = 'listening'; ol.pending = []; ol.acceptWaiters = []; }
      ol.backlog = bl;
      this._respond(pcb, {});
      return;
    }
    case OP.SOCK_CONNECT: {
      var oc = sockOf(req.fd); if (!oc) return;
      if (oc.st === 'conn') { this._respond(pcb, { errno: 'EISCONN' }); return; }
      if (oc.st !== 'fresh') { this._respond(pcb, { errno: 'EINVAL' }); return; }
      var cabs = this._pathFor(pcb, String(req.path || ''));
      var cres;
      try { cres = fs._resolvePath(cabs); } catch (e) { cres = null; }
      var cst = cres ? fs.stat(cres) : null;
      if (!cst) { this._respond(pcb, { errno: fs._lastError || 'ENOENT' }); return; }
      if ((cst.mode & 0xF000) !== S_IFSOCK_MODE) { this._respond(pcb, { errno: 'ECONNREFUSED' }); return; }
      var lid = this._sockBinds.get(cres);
      var lo = lid === undefined ? null : this._ofds.get(lid);
      if (!lo || lo.st !== 'listening') { this._respond(pcb, { errno: 'ECONNREFUSED' }); return; }
      // Serve a parked accept directly; otherwise queue within the backlog.
      var served = false;
      while (lo.acceptWaiters.length) {
        var apid = lo.acceptWaiters[0];
        var apcb = this._procs.get(apid);
        if (!apcb || !apcb.waiter || apcb.waiter.op !== 'accept' || apcb.waiter.lofd !== lo) {
          lo.acceptWaiters.shift();
          continue;
        }
        served = true;
        break;
      }
      if (!served && lo.pending.length >= lo.backlog) {
        this._respond(pcb, { errno: 'ECONNREFUSED' });
        return;
      }
      var a = sockDir(), b = sockDir();            // a: client->server, b: server->client
      oc.st = 'conn'; oc.rx = b; oc.tx = a;
      if (served) {
        var acc = this._procs.get(lo.acceptWaiters[0]);
        this._cancelWaiter(acc);
        var so = this._makeOfd('socket', { st: 'conn', rx: a, tx: b });
        this._respond(acc, { fd: attach(acc, so) });
      } else {
        lo.pending.push({ rx: a, tx: b });
        this._recheckSelects();                    // listener became read-ready
      }
      this._respond(pcb, {});
      return;
    }
    case OP.SOCK_ACCEPT: {
      var oa = sockOf(req.fd); if (!oa) return;
      if (oa.st !== 'listening') { this._respond(pcb, { errno: 'EINVAL' }); return; }
      if (oa.pending.length) {
        var conn = oa.pending.shift();
        var ao = this._makeOfd('socket', { st: 'conn', rx: conn.rx, tx: conn.tx });
        this._respond(pcb, { fd: attach(pcb, ao) });
        return;
      }
      pcb.waiter = { op: 'accept', lofd: oa };     // served by SOCK_CONNECT
      oa.acceptWaiters.push(pcb.pid);
      return;
    }
    case OP.SOCK_PAIR: {
      var pa = sockDir(), pb = sockDir();
      var e0 = this._makeOfd('socket', { st: 'conn', rx: pb, tx: pa });
      var e1 = this._makeOfd('socket', { st: 'conn', rx: pa, tx: pb });
      this._respond(pcb, { fd0: attach(pcb, e0), fd1: attach(pcb, e1) });
      return;
    }
    case OP.SOCK_SHUTDOWN: {
      var os = sockOf(req.fd); if (!os) return;
      if (os.st !== 'conn') { this._respond(pcb, { errno: 'ENOTCONN' }); return; }
      var how = req.how | 0;
      if (how < 0 || how > 2) { this._respond(pcb, { errno: 'EINVAL' }); return; }
      // Shutdown is connection-global (unlike close, which is per-reference).
      if (how !== 1) { os.rx.rOpen = false; this._pipeNotify(os.rx); }   // SHUT_RD/RDWR
      if (how !== 0) { os.tx.wOpen = false; this._pipeNotify(os.tx); }   // SHUT_WR/RDWR
      this._respond(pcb, {});
      return;
    }
    default: this._respond(pcb, { errno: 'ENOSYS' });
  }
};

/* Readiness for FS_SELECT: files and non-pipe write interest are always
 * ready; a tty read is ready when cooked bytes or EOF are waiting; a pipe
 * read is ready on data or writer-gone EOF, a pipe write on free space or
 * reader-gone (the write then surfaces EPIPE). */
Kernel.prototype._selectScan = function (pcb, rfds, wfds) {
  var self = this;
  var r = [], w = [];
  rfds.forEach(function (fd) {
    var id = pcb.fds.get(fd | 0);
    var o = id === undefined ? null : self._ofds.get(id);
    if (!o) { r.push(fd); return; }                     // EBADF surfaces on use
    if (o.kind === 'tty') { if (pcb.tty && pcb.tty.readable()) r.push(fd); }
    else if (o.kind === 'pipe') {
      if (o.end !== 'read' || o.pipe.buf.length > 0 || !o.pipe.wOpen) r.push(fd);
    }
    else if (o.kind === 'socket') {
      // conn: data or peer-gone EOF; listening: a queued connection;
      // fresh/bound: ready (the read fails immediately, so it won't block).
      if (o.st === 'conn') { if (o.rx.buf.length > 0 || !o.rx.wOpen) r.push(fd); }
      else if (o.st === 'listening') { if (o.pending.length > 0) r.push(fd); }
      else r.push(fd);
    }
    else if (o.kind !== 'out') r.push(fd);
  });
  wfds.forEach(function (fd) {
    var id = pcb.fds.get(fd | 0);
    var o = id === undefined ? null : self._ofds.get(id);
    if (o && o.kind === 'pipe' && o.end === 'write' &&
        o.pipe.buf.length >= o.pipe.cap && o.pipe.rOpen) return;   // full: not ready
    if (o && o.kind === 'socket' && o.st === 'conn' &&
        o.tx.buf.length >= o.tx.cap && o.tx.rOpen) return;         // full: not ready
    w.push(fd);
  });
  return { count: r.length + w.length, r: r, w: w };
};

/* Cooked tty data / EOF arrived: serve deferred reads FIFO, then re-check
 * deferred selects with tty interest. */
Kernel.prototype._ttyNotify = function (tty) {
  while (this._ttyWaiters.length) {
    var pid = this._ttyWaiters[0];
    var pcb = this._procs.get(pid);
    if (!pcb || !pcb.waiter || pcb.waiter.op !== 'ttyread') { this._ttyWaiters.shift(); continue; }
    if (tty._cooked.length > 0) {
      var count = pcb.waiter.count;
      this._cancelWaiter(pcb);
      this._respondRaw(pcb, tty.take(count));
    } else if (tty._eofFlag) {
      this._cancelWaiter(pcb);
      this._respondRaw(pcb, new Uint8Array(0));
    } else {
      break;                                            // no data yet
    }
  }
  this._recheckSelects();
};

/* Re-scan every deferred select after any readiness change (tty bytes,
 * pipe data/space, pipe end closed). */
Kernel.prototype._recheckSelects = function () {
  var self = this;
  this._procs.forEach(function (pcb) {
    if (pcb.waiter && pcb.waiter.op === 'select') {
      var ready = self._selectScan(pcb, pcb.waiter.r, pcb.waiter.w);
      if (ready.count > 0) {
        self._cancelWaiter(pcb);
        self._respond(pcb, ready);
      }
    }
  });
};

/* Blocking stream ops shared by pipes and connected sockets — `dir` is one
 * pipe-shaped direction. Deferred waiters register under the pipe op names
 * so _pipeNotify/_cancelWaiter serve both kinds unchanged. */
Kernel.prototype._streamRead = function (pcb, dir, count) {
  if (dir.buf.length > 0) {
    var n = Math.min(count, dir.buf.length);
    this._respondRaw(pcb, Uint8Array.from(dir.buf.splice(0, n)));
    this._pipeNotify(dir);                        // space freed: writers may proceed
    return;
  }
  if (!dir.wOpen) { this._respondRaw(pcb, new Uint8Array(0)); return; }  // EOF
  pcb.waiter = { op: 'piperead', pipe: dir, count: count };  // served by _pipeNotify
  dir.readWaiters.push(pcb.pid);
};

Kernel.prototype._streamWrite = function (pcb, dir, data) {
  if (!dir.rOpen || !dir.wOpen) {
    // POSIX: write to a pipe/socket nobody reads = EPIPE + SIGPIPE (default
    // action terminates — the `yes | head` pipeline death). !wOpen is the
    // socket shutdown(SHUT_WR) case: the direction's write side is gone
    // even though this OFD is still referenced.
    this._respond(pcb, { errno: 'EPIPE' });
    this._deliver(pcb, SIG.PIPE);
    return;
  }
  var free = dir.cap - dir.buf.length;
  if (free === 0 || (data.length <= PIPE_ATOMIC && data.length > free)) {
    // Full (or a PIPE_ATOMIC-small write that would split): block.
    // Copy the bytes OUT of the SAB payload region — it's reused.
    pcb.waiter = { op: 'pipewrite', pipe: dir, data: data.slice() };
    dir.writeWaiters.push(pcb.pid);
    return;
  }
  var n = Math.min(free, data.length);
  for (var i = 0; i < n; i++) dir.buf.push(data[i]);
  this._respond(pcb, { n: n });
  this._pipeNotify(dir);                          // data arrived: readers may proceed
};

/* Pipe state changed (write, read, end closed): serve deferred readers
 * (data / EOF) and writers (space / EPIPE+SIGPIPE) until nothing more
 * moves, then re-check deferred selects. Serving a read frees space and
 * serving a write supplies data, so loop until a full pass makes no
 * progress. Reentrancy (a SIGPIPE death unrefs fds and re-enters) is safe:
 * every service re-checks pcb.waiter before acting. */
Kernel.prototype._pipeNotify = function (pipe) {
  var progress = true;
  while (progress) {
    progress = false;
    while (pipe.readWaiters.length) {
      var rpcb = this._procs.get(pipe.readWaiters[0]);
      if (!rpcb || !rpcb.waiter || rpcb.waiter.op !== 'piperead' || rpcb.waiter.pipe !== pipe) {
        pipe.readWaiters.shift();
        continue;
      }
      if (pipe.buf.length > 0) {
        var count = rpcb.waiter.count;
        this._cancelWaiter(rpcb);
        this._respondRaw(rpcb, Uint8Array.from(pipe.buf.splice(0, Math.min(count, pipe.buf.length))));
        progress = true;
      } else if (!pipe.wOpen) {
        this._cancelWaiter(rpcb);
        this._respondRaw(rpcb, new Uint8Array(0));     // EOF
        progress = true;
      } else {
        break;                                          // no data yet
      }
    }
    while (pipe.writeWaiters.length) {
      var wpcb = this._procs.get(pipe.writeWaiters[0]);
      if (!wpcb || !wpcb.waiter || wpcb.waiter.op !== 'pipewrite' || wpcb.waiter.pipe !== pipe) {
        pipe.writeWaiters.shift();
        continue;
      }
      if (!pipe.rOpen || !pipe.wOpen) {   // !wOpen: shutdown(SHUT_WR) raced a parked write
        this._cancelWaiter(wpcb);
        this._respond(wpcb, { errno: 'EPIPE' });
        this._deliver(wpcb, SIG.PIPE);
        progress = true;
        continue;
      }
      var data = wpcb.waiter.data;
      var free = pipe.cap - pipe.buf.length;
      if (free === 0 || (data.length <= PIPE_ATOMIC && data.length > free)) break;
      this._cancelWaiter(wpcb);
      var n = Math.min(free, data.length);
      for (var i = 0; i < n; i++) pipe.buf.push(data[i]);
      this._respond(wpcb, { n: n });
      progress = true;
    }
  }
  this._recheckSelects();
};

/* ---- process groups ----
 * setpgid(pid, pgid): pid 0 = the caller, pgid 0 = "target's own pid".
 * POSIX scoping kept simple for one user: the target must be the caller or
 * one of its children, in the same session. (Latent since Phase 1 — the
 * dispatch existed but nothing defined this until the shell port's libc
 * wrappers landed, todos/0005.) */
Kernel.prototype._setpgid = function (pcb, pid, pgid) {
  var t = (pid === 0) ? pcb : this._procs.get(pid);
  if (!t || t.state === STATE_ZOMBIE) return { errno: 'ESRCH' };
  if (t !== pcb && !pcb.children.has(t.pid)) return { errno: 'ESRCH' };
  if (t.sid !== pcb.sid) return { errno: 'EPERM' };
  t.pgid = (pgid > 0) ? pgid : t.pid;
  return {};
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
  // Job control (todos/0003): unreported stop/continue transitions satisfy a
  // wait that asked for them; each transition is reported exactly once.
  for (var j = 0; j < candidates.length; j++) {
    var c = candidates[j];
    if ((options & WUNTRACED) && c.state === STATE_STOPPED && c.pendingStop) {
      var ssig = c.pendingStop;
      c.pendingStop = 0;
      this._respond(pcb, { pid: c.pid, status: W_STOPCODE(ssig) });
      return;
    }
    if ((options & WCONTINUED) && c.pendingCont) {
      c.pendingCont = false;
      this._respond(pcb, { pid: c.pid, status: W_CONTINUED_STATUS });
      return;
    }
  }
  if (options & WNOHANG) { this._respond(pcb, { pid: 0, status: 0 }); return; }
  pcb.waiter = { op: 'wait', sel: sel, options: options };  // answered by _exitProcess
};

/* Drop a deferred RPC registration (answered, interrupted, or the process
 * died) — clears timers and tty wait-queue membership. */
Kernel.prototype._cancelWaiter = function (pcb) {
  var w = pcb.waiter;
  pcb.waiter = null;
  if (!w) return;
  if (w.timer) clearTimeout(w.timer);
  if (w.op === 'ttyread') {
    var i = this._ttyWaiters.indexOf(pcb.pid);
    if (i >= 0) this._ttyWaiters.splice(i, 1);
  } else if (w.op === 'piperead' || w.op === 'pipewrite') {
    var q = w.op === 'piperead' ? w.pipe.readWaiters : w.pipe.writeWaiters;
    var j = q.indexOf(pcb.pid);
    if (j >= 0) q.splice(j, 1);
  } else if (w.op === 'accept') {
    var k = w.lofd.acceptWaiters.indexOf(pcb.pid);
    if (k >= 0) w.lofd.acceptWaiters.splice(k, 1);
  }
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
  this._cancelWaiter(pcb);
  if (pcb.worker) { try { pcb.worker.terminate(); } catch (e) {} }
  pcb.worker = null;
  // Release every fd — this is what makes SIGKILL leak-free under the
  // brokered fs: the kernel, not the dead worker, owns the descriptions,
  // so unlink-while-open lifetimes complete even on a hard kill.
  var self0 = this;
  pcb.fds.forEach(function (ofdId) { self0._ofdUnref(ofdId); });
  pcb.fds.clear();

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
      if (c.state === STATE_ZOMBIE && init.waiter && init.waiter.op === 'wait' &&
          waitSelectorMatch(init.waiter.sel, init, c)) {
        self._cancelWaiter(init);
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
    if (parent.waiter && parent.waiter.op === 'wait' &&
        waitSelectorMatch(parent.waiter.sel, parent, pcb)) {
      this._cancelWaiter(parent);
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
    // STOPPED processes are valid targets (SIGCONT/SIGKILL must reach them);
    // zombies are not (they only await reaping).
    if (!t || t.state === STATE_ZOMBIE) return { errno: 'ESRCH' };
    targets.push(t);
  } else if (pid === -1) {
    return { errno: 'EPERM' };
  } else {
    var pgid = pid === 0 ? (sender ? sender.pgid : 0) : -pid;
    if (this._killPgid(pgid, sig) === 0) return { errno: 'ESRCH' };
    return {};
  }
  for (var i = 0; i < targets.length; i++) this._deliver(targets[i], sig);
  return {};
};

/* Deliver sig to every live (running or stopped) member of a pgroup;
 * returns the member count. Used by pgroup kill() and by the tty's
 * control-char routing. */
Kernel.prototype._killPgid = function (pgid, sig) {
  var targets = [];
  this._procs.forEach(function (p) {
    if (p.state !== STATE_ZOMBIE && p.pgid === pgid) targets.push(p);
  });
  for (var i = 0; i < targets.length; i++) this._deliver(targets[i], sig);
  return targets.length;
};

Kernel.prototype._deliver = function (pcb, sig) {
  if (sig === SIG.KILL) { this._exitProcess(pcb, W_TERMSIG(sig)); return; }
  // SIGCONT resumes a stopped process REGARDLESS of disposition (POSIX);
  // any handler then delivers normally through the mirror below.
  if (sig === SIG.CONT) this._contProcess(pcb);
  // SIGSTOP is uncatchable and never consults the mirror.
  if (sig === SIG.STOP) { this._stopProcess(pcb, sig); return; }
  var disp = pcb.sigdisp[sig];
  if (disp === DISP_IGN) return;
  if (disp === DISP_HANDLER) {
    // Post the pending bit; libc claims it at its next safe point and runs
    // the handler. Also wake the tty ring: a read blocked on the SI_SEQ
    // futex must re-scan, notice the pending signal, and turn into EINTR.
    Atomics.or(pcb.i32, KP_SIGPEND, 1 << (sig - 1));
    this._ring(pcb);
    if (pcb.tty) pcb.tty.wakeReaders();
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
        if (pcb.tty) pcb.tty.wakeReaders();
      } else {
        this._exitProcess(pcb, W_TERMSIG(sig));
      }
      break;
    case 1: break;                                           // ignore
    case 2: this._stopProcess(pcb, sig); break;              // TSTP/TTIN/TTOU at DFL
    default: break;                                          // CONT: resumed above
  }
};

/* ---- job control (todos/0003) ----
 * Stop is cooperative, like signal delivery: the kernel sets KP_FLAGS.STOP
 * and rings; the process parks inside KernelClient.sigpoll at its next safe
 * point (so a pure-compute loop stops only at its next env import — same
 * caveat as catchable signals; SIGKILL remains the backstop). A process
 * already parked in a deferred RPC simply stays parked; if the RPC completes
 * while stopped, the worker runs to the next safe point and parks there. */

Kernel.prototype._stopProcess = function (pcb, sig) {
  if (pcb.state !== STATE_RUNNING) return;             // already stopped, or a zombie
  pcb.state = STATE_STOPPED;
  pcb.pendingStop = sig;                               // unreported for WUNTRACED
  pcb.pendingCont = false;
  Atomics.or(pcb.i32, KP_FLAGS, KF_STOP);
  this._ring(pcb);
  if (pcb.tty) pcb.tty.wakeReaders();                  // ring-mode reads re-scan -> safe point
  this._jobNotifyParent(pcb, 'stop');
};

Kernel.prototype._contProcess = function (pcb) {
  if (pcb.state !== STATE_STOPPED) return;
  pcb.state = STATE_RUNNING;
  pcb.pendingStop = 0;
  pcb.pendingCont = true;                              // unreported for WCONTINUED
  Atomics.and(pcb.i32, KP_FLAGS, ~KF_STOP);
  this._ring(pcb);                                     // wakes the stop-park
  this._jobNotifyParent(pcb, 'cont');
};

/* SIGCHLD + a parked wait answer for a stop/continue transition — the same
 * ordering discipline as _exitProcess (pending bit visible before the wait
 * response wakes the parent). */
Kernel.prototype._jobNotifyParent = function (pcb, kind) {
  var parent = this._procs.get(pcb.ppid);
  if (!parent || parent.state === STATE_ZOMBIE) return;
  this._deliver(parent, SIG.CHLD);
  var need = kind === 'stop' ? WUNTRACED : WCONTINUED;
  if (parent.waiter && parent.waiter.op === 'wait' &&
      (parent.waiter.options & need) &&
      waitSelectorMatch(parent.waiter.sel, parent, pcb)) {
    var status = kind === 'stop' ? W_STOPCODE(pcb.pendingStop) : W_CONTINUED_STATUS;
    if (kind === 'stop') pcb.pendingStop = 0; else pcb.pendingCont = false;
    this._cancelWaiter(parent);
    this._respond(parent, { pid: pcb.pid, status: status });
  } else {
    this._ring(parent);
  }
};

/* ============================================================
 * RemoteFS — the process-side client of the brokered filesystem.
 *
 * Implements the same JS method surface (names, arguments, null +
 * _lastError conventions) that BlockFS.prototype.toWasmEnv dispatches to
 * via `this.`, so the wasm env is built by REUSING toWasmEnv over this
 * object: BLOCK_FS.BlockFS.prototype.toWasmEnv.call(remoteFs, ctx). Two
 * env entries need overriding afterwards (isatty and __select_impl — their
 * toWasmEnv versions consult in-process state that doesn't exist here);
 * everything else flows through these methods as RPCs.
 * ============================================================ */
function RemoteFS(client) {
  this._c = client;
  this._lastError = null;
  // Markers so toWasmEnv's fd-1/2 console fast path sees "redirectable
  // entries" and routes writes through this.write (i.e. the kernel).
  this._fdTable = [];
  this._fdTable[0] = { type: 'remote' };
  this._fdTable[1] = { type: 'remote' };
  this._fdTable[2] = { type: 'remote' };
  this._dirs = [];              // opendir snapshots: {entries, pos}
  this._stdinSab = null;        // never set: stdin flows via FS_READ RPCs
  this._stdinCtrl = null;       // winsize words only (TIOCGWINSZ)
  this._pipeBroker = null;      // unused: brokered pipes are kernel OFDs (PIPE_CREATE)
  this._sigcheck = null;        // assigned by toWasmEnv; unused (no ring waits)
}

RemoteFS.prototype._setErr = function (name) { this._lastError = name; return null; };
RemoteFS.prototype._ok = function (resp) {
  return (resp && resp.errno) ? this._setErr(resp.errno) : resp;
};
/* Winsize-only wiring: keep _stdinSab null so no ring path ever engages. */
RemoteFS.prototype.setStdinSab = function (sab) {
  this._stdinCtrl = sab ? new Int32Array(sab, 0, 8) : null;
};

RemoteFS.prototype.open = function (path, flags, mode) {
  var r = this._ok(this._c.call(OP.FS_OPEN, { path: path, flags: flags, mode: mode }));
  if (r === null) return null;
  this._fdTable[r.fd] = { type: 'remote' };
  return r.fd;
};
RemoteFS.prototype.close = function (fd) {
  var r = this._ok(this._c.call(OP.FS_CLOSE, { fd: fd }));
  if (r === null) return null;
  delete this._fdTable[fd];
  return 0;
};
RemoteFS.prototype.read = function (fd, buf, count) {
  // Interruptible: a tty read defers kernel-side; a posted signal turns it
  // into EINTR (regular files respond immediately, so it never fires).
  var r = this._c.call(OP.FS_READ, { fd: fd, count: Math.min(count, 60000) }, true);
  if (r.errno) return this._setErr(r.errno);
  if (!r.raw) return this._setErr('EIO');
  buf.set(r.raw);
  return r.raw.length;
};
RemoteFS.prototype.write = function (fd, buf, count) {
  var n = Math.min(count, 60000);
  var payload = new Uint8Array(4 + n);
  payload[0] = fd & 0xff; payload[1] = (fd >> 8) & 0xff;
  payload[2] = (fd >> 16) & 0xff; payload[3] = (fd >> 24) & 0xff;
  payload.set(buf.subarray(0, n), 4);
  // Interruptible: a full-pipe write defers kernel-side; a posted signal
  // turns it into EINTR (files/tty/out respond immediately — never fires).
  var r = this._ok(this._c.callRaw(OP.FS_WRITE, payload, true));
  return r === null ? null : r.n;
};
RemoteFS.prototype.lseek = function (fd, offset, whence) {
  var r = this._ok(this._c.call(OP.FS_LSEEK, { fd: fd, offset: offset, whence: whence }));
  return r === null ? null : r.offset;
};
RemoteFS.prototype.stat = function (p) { var r = this._ok(this._c.call(OP.FS_STAT, { path: p })); return r && r.st; };
RemoteFS.prototype.lstat = function (p) { var r = this._ok(this._c.call(OP.FS_LSTAT, { path: p })); return r && r.st; };
RemoteFS.prototype.fstat = function (fd) { var r = this._ok(this._c.call(OP.FS_FSTAT, { fd: fd })); return r && r.st; };
RemoteFS.prototype.access = function (p, mode) { return this._ok(this._c.call(OP.FS_ACCESS, { path: p, mode: mode })) && 0; };
RemoteFS.prototype.unlink = function (p) { return this._ok(this._c.call(OP.FS_UNLINK, { path: p })) && 0; };
RemoteFS.prototype.rename = function (a, b) { return this._ok(this._c.call(OP.FS_RENAME, { from: a, to: b })) && 0; };
RemoteFS.prototype.mkdir = function (p, mode) { return this._ok(this._c.call(OP.FS_MKDIR, { path: p, mode: mode })) && 0; };
RemoteFS.prototype.rmdir = function (p) { return this._ok(this._c.call(OP.FS_RMDIR, { path: p })) && 0; };
RemoteFS.prototype.link = function (a, b) { return this._ok(this._c.call(OP.FS_LINK, { from: a, to: b })) && 0; };
RemoteFS.prototype.symlink = function (target, p) { return this._ok(this._c.call(OP.FS_SYMLINK, { target: target, path: p })) && 0; };
/* Buffer-style like BlockFS.readlink — toWasmEnv is reused over RemoteFS,
 * so the signatures must match (the RPC itself carries a string). */
RemoteFS.prototype.readlink = function (p, buf, bufsize) {
  var r = this._ok(this._c.call(OP.FS_READLINK, { path: p }));
  if (r === null) return null;
  var bytes = new TextEncoder().encode(r.target);
  var n = Math.min(bytes.length, bufsize);
  for (var i = 0; i < n; i++) buf[i] = bytes[i];
  return n;
};
RemoteFS.prototype.ftruncate = function (fd, size) { return this._ok(this._c.call(OP.FS_FTRUNCATE, { fd: fd, size: size })) && 0; };
RemoteFS.prototype.chmod = function (p, mode) { return this._ok(this._c.call(OP.FS_CHMOD, { path: p, mode: mode })) && 0; };
RemoteFS.prototype.fchmod = function (fd, mode) { return this._ok(this._c.call(OP.FS_FCHMOD, { fd: fd, mode: mode })) && 0; };
RemoteFS.prototype.utime = function (p, a, m) { return this._ok(this._c.call(OP.FS_UTIME, { path: p, atime: a, mtime: m })) && 0; };
RemoteFS.prototype.futime = function (fd, a, m) { return this._ok(this._c.call(OP.FS_FUTIME, { fd: fd, atime: a, mtime: m })) && 0; };
RemoteFS.prototype.chdir = function (p) { return this._ok(this._c.call(OP.FS_CHDIR, { path: p })) && 0; };
RemoteFS.prototype.getcwd = function () {
  var r = this._ok(this._c.call(OP.FS_GETCWD, {}));
  return r === null ? null : r.cwd;
};
RemoteFS.prototype.dup = function (fd) {
  var r = this._ok(this._c.call(OP.FS_DUP, { fd: fd }));
  if (r === null) return null;
  this._fdTable[r.fd] = { type: 'remote' };
  return r.fd;
};
RemoteFS.prototype.dup2 = function (oldfd, newfd) {
  var r = this._ok(this._c.call(OP.FS_DUP2, { fd: oldfd, newfd: newfd }));
  if (r === null) return null;
  this._fdTable[r.fd] = { type: 'remote' };
  return r.fd;
};
RemoteFS.prototype.fcntl_dupfd = function (fd, min) {
  var r = this._ok(this._c.call(OP.FS_FCNTL_DUPFD, { fd: fd, min: min }));
  if (r === null) return null;
  this._fdTable[r.fd] = { type: 'remote' };
  return r.fd;
};
RemoteFS.prototype.opendir = function (p) {
  var r = this._ok(this._c.call(OP.FS_OPENDIR, { path: p }));
  if (r === null) return null;
  this._dirs.push({ entries: r.entries, pos: 0 });
  return this._dirs.length - 1;
};
RemoteFS.prototype.readdir = function (h) {
  var d = this._dirs[h];
  if (!d || d.pos >= d.entries.length) return null;
  return d.entries[d.pos++];
};
RemoteFS.prototype.closedir = function (h) { this._dirs[h] = undefined; return 0; };
RemoteFS.prototype._resolvePath = function (p) {
  var r = this._c.call(OP.FS_REALPATH, { path: p });
  return r.errno ? p : r.path;   // best effort, like the lexical resolver
};
RemoteFS.prototype.isatty = function (fd) {
  var r = this._c.call(OP.FS_ISATTY, { fd: fd });
  return r.errno ? 0 : r.tty;
};
RemoteFS.prototype.pipe = function () {
  var r = this._ok(this._c.call(OP.PIPE_CREATE, {}));
  if (r === null) return null;
  this._fdTable[r.rfd] = { type: 'remote' };
  this._fdTable[r.wfd] = { type: 'remote' };
  return [r.rfd, r.wfd];
};
/* AF_UNIX sockets (todos/0008). Data flows through read/write above; only
 * the control plane needs methods. accept is interruptible (it parks
 * kernel-side until a connect arrives — EINTR per POSIX). */
RemoteFS.prototype.sockSocket = function () {
  var r = this._ok(this._c.call(OP.SOCK_SOCKET, {}));
  if (r === null) return null;
  this._fdTable[r.fd] = { type: 'remote' };
  return r.fd;
};
RemoteFS.prototype.sockBind = function (fd, path) { return this._ok(this._c.call(OP.SOCK_BIND, { fd: fd, path: path })) && 0; };
RemoteFS.prototype.sockListen = function (fd, backlog) { return this._ok(this._c.call(OP.SOCK_LISTEN, { fd: fd, backlog: backlog })) && 0; };
RemoteFS.prototype.sockConnect = function (fd, path) { return this._ok(this._c.call(OP.SOCK_CONNECT, { fd: fd, path: path })) && 0; };
RemoteFS.prototype.sockAccept = function (fd) {
  var r = this._ok(this._c.call(OP.SOCK_ACCEPT, { fd: fd }, true));
  if (r === null) return null;
  this._fdTable[r.fd] = { type: 'remote' };
  return r.fd;
};
RemoteFS.prototype.sockPair = function () {
  var r = this._ok(this._c.call(OP.SOCK_PAIR, {}));
  if (r === null) return null;
  this._fdTable[r.fd0] = { type: 'remote' };
  this._fdTable[r.fd1] = { type: 'remote' };
  return [r.fd0, r.fd1];
};
RemoteFS.prototype.sockShutdown = function (fd, how) { return this._ok(this._c.call(OP.SOCK_SHUTDOWN, { fd: fd, how: how })) && 0; };

/* The brokered __select_impl (replaces toWasmEnv's in-process scanner):
 * fd-set bitmaps <-> fd lists; readiness, blocking, and timeout are all
 * kernel-side; interruption surfaces as EINTR per POSIX. */
RemoteFS.prototype.selectImpl = function (ctx) {
  var self = this;
  return function (nfds, readfds_ptr, writefds_ptr, exceptfds_ptr,
    timeout_sec, timeout_usec, has_timeout) {
    var mem = new DataView(ctx.getMemory().buffer);
    function toList(ptr) {
      if (!ptr) return [];
      var out = [];
      for (var fd = 0; fd < nfds && fd < 64; fd++) {
        if (mem.getInt32(ptr + ((fd >> 5) * 4), true) & (1 << (fd & 31))) out.push(fd);
      }
      return out;
    }
    var req = {
      r: toList(readfds_ptr), w: toList(writefds_ptr),
      timeoutMs: has_timeout ? (timeout_sec * 1000 + timeout_usec / 1000) : null,
    };
    var resp = self._c.call(OP.FS_SELECT, req, true);
    if (resp.errno) { ctx.setErrnoName(resp.errno); return -1; }
    var out = new DataView(ctx.getMemory().buffer);
    function writeList(ptr, list) {
      if (!ptr) return;
      var b = [0, 0];
      list.forEach(function (fd) { b[fd >> 5] |= (1 << (fd & 31)); });
      out.setInt32(ptr, b[0], true);
      out.setInt32(ptr + 4, b[1], true);
    }
    writeList(readfds_ptr, resp.r || []);
    writeList(writefds_ptr, resp.w || []);
    writeList(exceptfds_ptr, []);
    return (resp.r ? resp.r.length : 0) + (resp.w ? resp.w.length : 0);
  };
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
 * In brokered mode fd_actions were already applied kernel-side at spawn;
 * they still arrive in workerData for the standalone path's benefit.
 * ============================================================ */
var BOOT_SOURCE = [
  "'use strict';",
  "var wt = require('worker_threads');",
  "var wd = wt.workerData;",
  "var runModule = require(wd.hostPath);",
  "var K = require(wd.kernelPath);",
  "var BLOCK_FS = runModule.BLOCK_FS;",
  "var client = new K.KernelClient(wd.kernelPage, function (m) { wt.parentPort.postMessage(m); });",
  "var fsFactory;",
  "if (wd.brokered) {",
  "  // The brokered filesystem: the kernel serves every fs syscall; the env",
  "  // is toWasmEnv REUSED over a RemoteFS (same method surface), with the",
  "  // two in-process-state entries overridden.",
  "  var rfs = new K.RemoteFS(client);",
  "  fsFactory = function (ctx) {",
  "    var env = BLOCK_FS.BlockFS.prototype.toWasmEnv.call(rfs, ctx);",
  "    env.__select_impl = rfs.selectImpl(ctx);",
  "    env.isatty = function (fd) { return rfs.isatty(fd); };",
  "    return Promise.resolve({ c: env });",
  "  };",
  "} else {",
  "  // Standalone arrangement (no shared fs): private in-memory BlockFS.",
  "  var store = new BLOCK_FS.MemoryByteStore(1 << 20);",
  "  var bfs = BLOCK_FS.createV4(store);",
  "  if (wd.cwd && wd.cwd !== '/') { try { bfs.chdir(wd.cwd); } catch (e) {} }",
  "  fsFactory = function (ctx) { return Promise.resolve({ c: bfs.toWasmEnv(ctx) }); };",
  "}",
  "function envObj(envp) { var o = {}; (envp || []).forEach(function (s) {",
  "  var i = s.indexOf('='); if (i > 0) o[s.slice(0, i)] = s.slice(i + 1); }); return o; }",
  "function ship(fd) { return function (b) {",
  "  var u = (b instanceof Uint8Array) ? b : new Uint8Array(b);",
  "  wt.parentPort.postMessage({ type: 'out', fd: fd, bytes: u.slice() }); }; }",
  "runModule({",
  "  bytes: wd.image,",
  "  args: wd.argv,",
  "  env: envObj(wd.envp),",
  "  stdinSab: wd.ttySab || undefined,",
  "  blockFsFactory: fsFactory,",
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
        ttySab: procSpec.ttySab || null,
        brokered: !!procSpec.brokered,
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
  Tty: Tty,
  RemoteFS: RemoteFS,
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
  KF_STOP: KF_STOP,
  KP_RPC_KIND: KP_RPC_KIND,
  RPCK_JSON: RPCK_JSON,
  RPCK_RAW: RPCK_RAW,
  writePayload: writePayload,
  writeRawPayload: writeRawPayload,
  readPayload: readPayload,
  W_EXITCODE: W_EXITCODE,
  W_TERMSIG: W_TERMSIG,
  W_STOPCODE: W_STOPCODE,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = KERNEL_EXPORTS;
} else if (typeof window !== 'undefined') {
  window.KERNEL = KERNEL_EXPORTS;
} else if (typeof self !== 'undefined') {
  self.KERNEL = KERNEL_EXPORTS;
}
