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
  // Ptys (todos/0020): PTY_CREATE makes a master/slave pair — the slave is
  // a full Tty (line discipline reused verbatim); TIOCSWINSZ is the master
  // side's resize (winsize words + SIGWINCH to the pty's fg pgroup).
  TIOCSWINSZ: 0x0105,
  PTY_CREATE: 0x0106,
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
  // 0x1xxx — WM surfaces (todos/WM.md). Control plane only: present rides
  // the surface SAB (flip+seq, mailbox) and gpu-transport frames ride
  // {type:'wm-frame'} messages — never RPCs. 0x1004 stays reserved for a
  // present RPC should damage tracking ever want one.
  // SURFACE_CONFIGURE (todos/0019) is the client's resize ACK: the kernel
  // asks via a WINDOW_RESIZED input-ring event; the client answers with a
  // NEW fb SAB (riding {type:'wm-sabs'}, the create handshake verbatim)
  // whose front buffer already holds the first frame at the new size — the
  // kernel swaps buffers atomically here, so the compositor never tears.
  // SURFACE_SET_FLAGS (todos/0018) updates the surface flag word (bit0
  // borderless, bit1 relative-mouse, bit2 resizable); the relative-mouse
  // bit round-trips to the UI bridge as a pointer-lock request
  // (onPointerLock). The resizable bit (todos/0021, SDL3 semantics: only
  // SDL_WINDOW_RESIZABLE windows may be resized) gates every resize path
  // — wmResize, WMP RESIZE. Frame drag zones exist on BOTH kinds since
  // todos/0024, but dispatch on the bit: resizable -> configure the client;
  // fixed-size -> scale its dst rect (wmSetDst; the app never knows).
  SURFACE_CREATE: 0x1001, SURFACE_DESTROY: 0x1002, SURFACE_SET_TITLE: 0x1003,
  SURFACE_CONFIGURE: 0x1005, SURFACE_SET_FLAGS: 0x1006,
  // 0x2xxx — the audio mixer (todos/0017; design: WM.md "Audio mixing").
  // Control plane only: PCM rides the per-process source ring SABs and the
  // one page-owned output ring — never RPCs.
  AUDIO_OPEN: 0x2001, AUDIO_CLOSE: 0x2002,
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

/* Ptys (todos/0020): the slave→master output direction. Sized so a whole
 * worst-case slave write always fits EVENTUALLY: RemoteFS caps writes at
 * 60000 bytes and OPOST/ONLCR at most doubles them (120000 < cap), so the
 * whole-or-block discipline (a \r\n must never split across a full buffer)
 * can always be satisfied by a draining master. */
var PTY_OUT_CAP = 256 * 1024;

/* AF_UNIX sockets (todos/0008): a connection is two pipe-shaped directions
 * (same fields, same waiter queues), so the entire blocking/EOF/EPIPE/
 * select machinery is the pipe machinery. */
function sockDir() {
  return { buf: [], cap: PIPE_CAP, rOpen: true, wOpen: true,
           readWaiters: [], writeWaiters: [] };
}
var S_IFSOCK_MODE = 0o140000;

/* ============================================================
 * WM surfaces (todos/WM.md; opcodes 0x1xxx as reserved in the design).
 *
 * Surface framebuffer SAB — allocated by the PROCESS (host.js), shared to
 * the kernel via a {type:'wm-sabs'} postMessage immediately before the
 * SURFACE_CREATE RPC (same-channel FIFO makes the pairing race-free; the
 * kernel can't hand a new SAB to a parked worker, so the process side is
 * the natural allocator). Layout — MUST MATCH host.js (SH_* there):
 *
 *   Int32 header, 64 bytes:
 *     [0] SH_MAGIC 0x574d5346   [1] SH_W   [2] SH_H
 *     [3] SH_FORMAT (0 = RGBA8) [4] SH_FLIP  front buffer index (Atomics)
 *     [5] SH_SEQ   frame counter (Atomics.add at present)
 *     [6..15] reserved (damage rect, v2)
 *   then fb[0], fb[1]: w*h*4 bytes each (double buffer, MAILBOX semantics:
 *   the producer writes the back buffer, flips SH_FLIP, never blocks; the
 *   compositor samples the front buffer at its own cadence).
 *
 * Present is pure SAB (flip + seq) — NO RPC on the frame path (WM.md's
 * data-plane rule; the ~10us RPC toll never lands per-frame).
 *
 * Input ring SAB — one per process, allocated with the first surface,
 * kernel -> process (the console-ring pattern; the kernel is the single
 * producer, the process's SDL pump the single consumer). Layout — MUST
 * MATCH host.js (IR_*):
 *
 *   Int32 header, 32 bytes:
 *     [0] IR_WPOS  [1] IR_RPOS   indices in [0, 2*cap) (full/empty disambig)
 *     [2] IR_CAP   capacity in records (power of two, set by the allocator)
 *     [3] IR_DROPPED  events dropped on overflow (drop-newest)
 *   then IR_CAP records x 32 bytes: 8 Int32 words
 *     [0] SDL event type          [1] windowId (sid)
 *     key:    [2] scancode [3] keysym [4] mod [5] repeat
 *     motion: [2] x(f32 bits) [3] y(f32 bits) [4] button state mask
 *             [5] relative flag (todos/0018): 1 = [2]/[3] are dx/dy deltas
 *             (pointer-lock motion / injected rel), not positions
 *     button: [2] x(f32 bits) [3] y(f32 bits) [4] button index
 *     wheel:  [2] x(f32 bits) [3] y(f32 bits) [4] direction
 *   The kernel rings the process doorbell after each write, so
 *   SDL_WaitEvent-style parks wake like every other blocking op.
 * ============================================================ */
var SH_MAGIC = 0, SH_W = 1, SH_H = 2, SH_FORMAT = 3, SH_FLIP = 4, SH_SEQ = 5;
var SH_MAGIC_VALUE = 0x574d5346;             // 'WMSF'
var SH_HDR_BYTES = 64;
var IR_WPOS = 0, IR_RPOS = 1, IR_CAP = 2, IR_DROPPED = 3;
var IR_HDR_BYTES = 32;
var IR_RECORD_WORDS = 8;                     // 32 bytes per event record

/* SDL event type numbers (MUST MATCH <SDL3/SDL_events.h> / host.js
 * sdlEvents): the ring carries them verbatim. WINDOW_RESIZED is the resize
 * request (todos/0019): record words [2]=w [3]=h; the client acks with the
 * SURFACE_CONFIGURE RPC once it has a frame at the new size. */
var WMEV = { QUIT: 0x100, WINDOW_RESIZED: 0x206, KEYDOWN: 0x300, KEYUP: 0x301,
             MOUSEMOTION: 0x400, MOUSEBUTTONDOWN: 0x401, MOUSEBUTTONUP: 0x402,
             MOUSEWHEEL: 0x403 };

/* ============================================================
 * Audio mixer (todos/0017; design: WM.md "Audio mixing — the kernel sound
 * server"). Ring layout — MUST MATCH host.js createSharedAudioBuffer
 * (16-byte Int32 header + PCM ring):
 *   [0] AU_WPOS    writePos, masked mod capacity (producer-only cursor)
 *   [1] AU_QUEUED  queuedBytes (producer Atomics.add, consumer Atomics.sub —
 *                  the single synchronization cell; readPos is derived:
 *                  (writePos - queuedBytes) double-mod capacity)
 *   [2] AU_PLAYING source rings: written by the PROCESS (SDL3 devices open
 *                  paused; resume sets 1) — the mixer skips paused rings.
 *                  Output ring: written by the page receiver on resume.
 *   [3] reserved
 * Source rings are process-allocated and registered via AUDIO_OPEN (the
 * SAB rides {type:'audio-sab'} immediately before the RPC — the wm-sabs
 * FIFO handshake). The output ring is kernel-allocated (audioInit) and
 * fixed f32 stereo AU_OUT_FREQ; the page plays it with host.js's existing
 * createAudioReceiver, verbatim.
 * SDL audio format words — MUST MATCH <SDL3/SDL_audio.h>. */
var AU_WPOS = 0, AU_QUEUED = 1, AU_PLAYING = 2;
var AU_HDR_BYTES = 16;
var AU_OUT_FREQ = 48000, AU_OUT_CHANNELS = 2;
var AU_FMT_F32 = 0x8120, AU_FMT_S32 = 0x8020, AU_FMT_S16 = 0x8010,
    AU_FMT_S8 = 0x8008, AU_FMT_U8 = 0x0008;
var AU_TARGET_MS = 80;                 // output queue depth the pump tops up to
var AU_OUT_RING_BYTES = 256 * 1024;   // default output ring capacity (~0.68s)

/* ============================================================
 * The WM protocol (todos/0014) — the kernel-owned AF_UNIX endpoint at
 * /run/wm.sock. ONE op set exposed twice (WM.md "Agent control channel"):
 * the kernel-JS wm* methods serve the outside (tests, Node agents); this
 * framed protocol serves the inside (/bin/wm policy client, /bin/wmctl).
 *
 * Framing (everything little-endian): u32 len (bytes that follow, i.e.
 * 4 + payload) | u32 type | payload. All payload fields are i32 unless
 * noted. Types >= 0x80 are events (subscriber-only); replies to commands
 * arrive strictly in request order on the same connection, so a client
 * that subscribes just skips event frames while awaiting a reply.
 *
 * Window record (fixed 80 bytes, WMP_REC_BYTES): sid, pid, x, y, w, h, z,
 * flags (bit0 focused, bit1 minimized, bit2 borderless, bit3 relative-
 * mouse, bit4 resizable), frameSeq, dstW, dstH (the on-screen viewport,
 * todos/0024 — equals w/h unless scaled), reserved, then 32 bytes
 * NUL-padded UTF-8 title.
 *
 * Commands -> replies:
 *   SUBSCRIBE {}                 -> R_OK { screenW, screenH }, then
 *                                   EV_CREATED per surface (z-order) +
 *                                   EV_FOCUS (the snapshot); the dims can
 *                                   change later -> EV_SCREEN (todos/0023)
 *   LIST {}                      -> R_LIST { count, count * record }
 *   MOVE { sid, x, y }           -> R_OK | R_ERR
 *   FOCUS { sid }                -> R_OK | R_ERR   (restores if minimized)
 *   MINIMIZE / RESTORE { sid }   -> R_OK | R_ERR
 *   RESTACK { sid, place }       -> R_OK | R_ERR   (place: 0 raise, 1 lower)
 *   CLOSE_REQ { sid }            -> R_OK | R_ERR   (SDL_EVENT_QUIT to owner)
 *   RESIZE { sid, w, h }         -> R_OK | R_ERR   (asks the client; geometry
 *                                   changes only at its SURFACE_CONFIGURE ack
 *                                   -> EV_CONFIGURED; R_ERR on a surface
 *                                   without flag bit4 resizable, todos/0021)
 *   SET_DST { sid, w, h }        -> R_OK | R_ERR   (viewport scaling, todos/
 *                                   0024: set the on-screen dst rect of a
 *                                   FIXED-SIZE surface — buffer untouched,
 *                                   app oblivious; R_ERR on a resizable
 *                                   surface, which configures instead)
 *   ACTIVATE { sid }             -> R_OK | R_ERR   (todos/0025: fire the
 *                                   title-activate gesture — the wmctl-max
 *                                   path into the SAME policy code the title
 *                                   double-click hits; R_ERR when no WM is
 *                                   subscribed, since maximize IS policy)
 *   INJECT_KEY { sid, down, scancode, keysym, mod }        -> R_OK | R_ERR
 *   INJECT_POINTER { sid, kind, xf32, yf32, a, b }         -> R_OK | R_ERR
 *     kind: 0 move (a=buttons) | 1 down | 2 up (a=button) | 3 wheel
 *     (xf32/yf32 = wheelX/wheelY, a=direction) | 4 rel (todos/0018:
 *     xf32/yf32 = dx/dy deltas, a=buttons); sid 0 = focused window
 *   SHOT { sid } / SHOT_SCREEN {} -> R_SHOT { sid, w, h, w*h*4 rgba } | R_ERR
 * R_ERR payload: one i32 (errno, always 22/EINVAL in v1).
 * Events: EV_CREATED record | EV_DESTROYED { sid } | EV_TITLE { sid,
 * title32 } | EV_FOCUS { sid (0 = none) } | EV_MOVED { sid, x, y } |
 * EV_MINIMIZED { sid, minimized 0|1 } (restore also implies focus) |
 * EV_CONFIGURED { sid, w, h } (the client's resize ack landed; geometry
 * is now the new size) | EV_SCREEN { w, h } (the screen changed resolution,
 * todos/0023 — RandR/wl_output shape: the display owner set a new mode via
 * wmSetScreen; the kernel one-shot-clamps window positions itself so the
 * no-WM fallback stays usable, and a subscribed WM re-lays its furniture) |
 * EV_SCALED { sid, dstW, dstH } (a SET_DST landed; the on-screen viewport
 * is now dstW x dstH, todos/0024) | EV_SCALE_REQ { sid, w, h } (the user
 * released a frame drag on a FIXED-SIZE surface at that box — the wp_
 * viewport shape: policy answers with an aspect-preserving SET_DST; only
 * emitted with a subscriber, else the kernel applies the raw box itself) |
 * EV_TITLE_ACTIVATE { sid } (todos/0025: title-bar double-click, or an
 * ACTIVATE command — the maximize gesture; the kernel keeps NO maximize
 * state, policy toggles configure-vs-scale on the resizable bit and holds
 * the saved geometry).
 *
 * MUST MATCH the C client header (os/wm_proto.h) and the scripted client
 * in tests/kernel/test_wm_policy.js. */
var WMP = {
  SUBSCRIBE: 0x01, LIST: 0x02,
  MOVE: 0x10, FOCUS: 0x11, MINIMIZE: 0x12, RESTORE: 0x13, RESTACK: 0x14,
  CLOSE_REQ: 0x15, RESIZE: 0x16, SET_DST: 0x17, ACTIVATE: 0x18,
  INJECT_KEY: 0x20, INJECT_POINTER: 0x21,
  SHOT: 0x30, SHOT_SCREEN: 0x31,
  R_OK: 0x40, R_ERR: 0x41, R_LIST: 0x42, R_SHOT: 0x43,
  EV_CREATED: 0x80, EV_DESTROYED: 0x81, EV_TITLE: 0x82, EV_FOCUS: 0x83,
  EV_MOVED: 0x84, EV_MINIMIZED: 0x85, EV_CONFIGURED: 0x86, EV_SCREEN: 0x87,
  EV_SCALED: 0x88, EV_SCALE_REQ: 0x89, EV_TITLE_ACTIVATE: 0x8A,
};
var WMP_REC_BYTES = 80;
var WM_SOCK_PATH = '/run/wm.sock';

/* Kernel-drawn chrome, v1 (WM.md "Decorations — staged"): fixed Win95-ish
 * metrics, deterministic — the same numbers drive hit-testing here, the
 * browser compositor's drawing, and the headless screenshot composite.
 * The client rect is (x, y, w, h); the title bar sits ABOVE it, and a
 * WM_BORDER frame surrounds title+client (todos/0019). Resize drag zones
 * on the frame: right edge -> E, bottom edge -> S, within WM_GRIP of the
 * bottom-right corner -> SE (left/top edges just focus — moving-edge
 * resizes are deliberately not in this version). */
var WM_TITLE_H = 24;
var WM_CLOSE_W = 16, WM_CLOSE_PAD = 4;       // close box, right-aligned in the bar
var WM_BORDER = 4;                           // resize frame around title+client
var WM_GRIP = 16;                            // SE-corner zone (resizes both axes)
var WM_MIN_SIZE = 32;                        // client floor for resize requests
var WM_DBLCLICK_MS = 400;                    // title double-click window (todos/0025)
var WM_DBLCLICK_SLOP = 4;                    // ...and max px drift between the downs
var WM_COLORS = {                            // RGBA byte tuples
  desktop: [0, 128, 128, 255],               // the teal
  titleFocused: [0, 0, 128, 255],            // navy
  titleBlurred: [128, 128, 128, 255],
  closeBox: [192, 192, 192, 255],
  border: [192, 192, 192, 255],              // the Win95 face gray
};

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
 * postToKernel(msg, transferList?) must deliver msg to the kernel's message
 * handler for this process (worker postMessage in both browser and Node;
 * the optional transfer list carries gpu-transport frame bitmaps).
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
    // Phase 3 tty control plane (line discipline lives kernel-side). The fd
    // rides along since 0020 (ptys): the kernel resolves it through the fd
    // table to THE tty it names (slave pty vs system tty), falling back to
    // the process's attached tty for old callers / ring mode.
    ttyGetattr: function (fd) { return self.call(OP.TCGETATTR, { fd: fd }); },
    ttySetattr: function (fd, actions, t) {
      return self.call(OP.TCSETATTR, {
        fd: fd, actions: actions, iflag: t.iflag, oflag: t.oflag,
        cflag: t.cflag, lflag: t.lflag, cc: t.cc,
      });
    },
    ttyGetpgrp: function (fd) { return self.call(OP.TCGETPGRP, { fd: fd }); },
    ttySetpgrp: function (fd, pgid) { return self.call(OP.TCSETPGRP, { fd: fd, pgid: pgid }); },
    // WM surfaces (todos/WM.md). The process allocates the SABs (the kernel
    // can't hand one to a parked worker) and posts them on the same FIFO
    // channel immediately before the RPC that names them.
    // flags bit0: borderless (no kernel chrome — taskbar-class surfaces).
    surfaceCreate: function (w, h, title, fbSab, ringSab, flags) {
      self._post({ type: 'wm-sabs', fb: fbSab, ring: ringSab || null });
      return self.call(OP.SURFACE_CREATE, { w: w, h: h, title: title || '', flags: flags | 0 });
    },
    surfaceDestroy: function (sid) { return self.call(OP.SURFACE_DESTROY, { sid: sid }); },
    surfaceSetTitle: function (sid, title) { return self.call(OP.SURFACE_SET_TITLE, { sid: sid, title: title || '' }); },
    // Flag-word update (todos/0018): bit0 borderless, bit1 relative-mouse.
    surfaceSetFlags: function (sid, flags) { return self.call(OP.SURFACE_SET_FLAGS, { sid: sid, flags: flags | 0 }); },
    // Resize ack (todos/0019): the NEW fb SAB (first new-size frame already
    // presented into it) rides the FIFO channel like at create.
    surfaceConfigure: function (sid, w, h, fbSab) {
      self._post({ type: 'wm-sabs', fb: fbSab, ring: null });
      return self.call(OP.SURFACE_CONFIGURE, { sid: sid, w: w, h: h });
    },
    // gpu transport (browser): per-present frame handoff; transfer the
    // bitmap so it never copies. Fire-and-forget by design (mailbox).
    surfaceFrame: function (sid, bmp) {
      self._post({ type: 'wm-frame', sid: sid, bmp: bmp }, [bmp]);
    },
    // Audio mixer (todos/0017): the process-allocated source ring rides the
    // FIFO channel immediately before the RPC that names it (wm-sabs shape).
    audioOpen: function (freq, format, channels, sab) {
      self._post({ type: 'audio-sab', sab: sab });
      return self.call(OP.AUDIO_OPEN, { freq: freq, format: format, channels: channels });
    },
    audioClose: function (aid) { return self.call(OP.AUDIO_CLOSE, { aid: aid }); },
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
  this.waiters = [];            // pids with a deferred FS_READ on THIS tty, FIFO
                                // (per-instance since 0020: ptys mean many ttys)
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
  // Pointer lock (todos/0018): the UI bridge is told when the WANTED state
  // changes (focused surface requests relative mouse); it owns the actual
  // Pointer Lock API dance and reports transitions via wmPointerLockChanged.
  this._onPointerLock = opts.onPointerLock || function () {};
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
  this._ofds = new Map();    // ofdId -> { id, kind:'file'|'tty'|'out'|'null'|'pipe'|'socket'|'ptm', refs, bfsFd?, ch?, pipe?, end?, st?, rx?, tx?, path?, backlog?, pending?, acceptWaiters?, tty?, pty? }
                             // 'tty' with pty set = a pty SLAVE (0020);
                             // 'ptm' = a pty master.
  this._nextOfd = 1;
  this._std = null;          // lazy singleton OFDs for default stdio
  this._sockBinds = new Map(); // resolved path -> listener/bound socket ofdId
  this._kernelSockServers = new Map(); // resolved path -> onConnect(peer, pcb)
                             // — KERNEL-owned AF_UNIX endpoints (sockServe;
                             // todos/0014). Checked before _sockBinds.
  // WM surfaces (todos/WM.md). The kernel owns the scene: registry, z-order,
  // focus, input routing, kernel-chrome policy (v1 — a WM client takes over
  // placement policy in v2). The compositor (browser) and the screenshot
  // composite (headless) both read this state.
  this._surfaces = new Map(); // sid -> { sid, pid, sab, i32, u8, w, h, dstW, dstH, title, x, y, bitmap, minimized, borderless, relativeMouse, pendingConfigure }
  this._nextSid = 1;
  this._zOrder = [];          // sids, bottom -> top
  this._focusSid = 0;
  this._wmDrag = null;        // { sid, dx, dy } during a title-bar drag
  this._wmTitleDown = null;   // { sid, x, y, t } — last title-bar mousedown,
                              // for double-click detection (todos/0025)
  this._wmResizeDrag = null;  // { sid, ex, ey, baseW, baseH, x0, y0, curW, curH }
                              // during a border resize drag (todos/0019);
                              // ex/ey: 1 = that axis tracks the pointer.
                              // On a fixed-size surface the same drag is a
                              // SCALE drag (todos/0024): base/cur are dst
                              // dims and release goes to wmSetDst/the WM
                              // instead of a configure.
  this._wmScreen = { w: (opts.screen && opts.screen.w) || 1024,
                     h: (opts.screen && opts.screen.h) || 768 };
  this._wmVersion = 0;        // bumped on any scene change (create/destroy/
                              // move/focus/title) — compositor idle-skip aid
  this._wmSubs = new Set();   // WM-protocol connections subscribed to events
  this._wmPtrLockWanted = false;  // last wanted state emitted to the bridge
  this._wmPtrLockActive = false;  // actual lock state (bridge-reported); while
                                  // true, pointer input routes RELATIVE to the
                                  // focused relative-mouse surface (no hit-test)
  // Audio mixer (todos/0017; WM.md "Audio mixing"). Streams register via
  // AUDIO_OPEN; the pump mixes them into the one output ring (audioInit).
  this._audioStreams = new Map(); // aid -> stream (see _audioRpc AUDIO_OPEN)
  this._nextAid = 1;
  this._audioOut = null;          // { sab, control, f32, cap, freq, channels }
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
  else if (o.kind === 'ptm') {
    // The terminal is gone (0020): SIGHUP to the pty's fg pgroup (POSIX —
    // this is how closing the terminal window ends the session), parked
    // slave writers get EIO, slave readers drain to EOF.
    var pt = o.pty;
    pt.out.rOpen = false;
    this._pipeNotify(pt.out);
    if (pt.tty.fgPgid > 0) this._killPgid(pt.tty.fgPgid, SIG.HUP);
    pt.tty.eof();
  } else if (o.kind === 'tty') {
    // A pty slave gone everywhere (0020) — the system tty's std OFDs keep
    // living in _std, so only pty slaves carry o.pty here: master reads
    // see EOF once the buffered output drains.
    if (o.pty) { o.pty.out.wOpen = false; this._pipeNotify(o.pty.out); }
  }
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

/* Spawn a kernel-owned service (todos/0014: the /bin/wm autostart): no
 * parent, own session, auto-reaped on exit (ppid 0 in _exitProcess — the
 * kernel never waits). Resolves to the pid, or 0 on failure (a missing
 * /bin/wm must not break boot: kernel-chrome is the fallback policy). */
Kernel.prototype.service = function (spec) {
  return this._spawn(null, {
    path: spec.path,
    argv: spec.argv || [spec.path],
    envp: spec.envp || [],
    cwd: spec.cwd || '/',
    actions: [],
    flags: 0,
    pgid: 0,
  }).then(function (r) { return r.errno ? 0 : r.pid; });
};

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
      surfaces: new Set(),           // sids owned by this process (WM.md)
      wmRing: null,                  // input ring: { i32, f32, cap }
      _wmPendingFb: null,            // SAB from 'wm-sabs' awaiting SURFACE_CREATE
      audios: new Set(),             // aids owned by this process (todos/0017)
      _audioPendingSab: null,        // SAB from 'audio-sab' awaiting AUDIO_OPEN
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
      // Attach the controlling-ish tty (0020): a child whose fd 0 is a pty
      // slave lives on THAT pty — termios/pgrp RPC fallback, control-char
      // signals, and the winsize SAB handed to the worker below all follow.
      // The first attach claims the foreground (the terminal app spawns its
      // shell as a pgroup leader; the shell then owns tcsetpgrp).
      var o0id = pcb.fds.get(0);
      var o0 = o0id === undefined ? null : self._ofds.get(o0id);
      if (o0 && o0.kind === 'tty' && o0.tty) {
        pcb.tty = o0.tty;
        if (!pcb.tty.fgPgid) pcb.tty.fgPgid = pcb.pgid;
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
    // WM (todos/WM.md): SABs precede their SURFACE_CREATE on the same FIFO
    // channel; gpu-transport frames arrive per-present (browser only).
    case 'wm-sabs':
      if (msg.fb) pcb._wmPendingFb = msg.fb;
      if (msg.ring && !pcb.wmRing) this._wmSetRing(pcb, msg.ring);
      break;
    // Audio (todos/0017): the source-ring SAB precedes its AUDIO_OPEN on the
    // same FIFO channel — the wm-sabs handshake, verbatim.
    case 'audio-sab':
      if (msg.sab) pcb._audioPendingSab = msg.sab;
      break;
    case 'wm-frame': this._wmFrame(pcb, msg.sid | 0, msg.bmp); break;
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
    // Termios/pgrp RPCs resolve the tty THROUGH the caller's fd (0020:
    // ptys mean many ttys); fd-less requests and ring mode fall back to
    // the process's attached tty (_ttyForFd).
    case OP.TCGETATTR: {
      var gAt = this._ttyForFd(pcb, req.fd);
      this._respond(pcb, gAt ? gAt.getattr() : { errno: 'ENOTTY' });
      break;
    }
    case OP.TCSETATTR: {
      var sAt = this._ttyForFd(pcb, req.fd);
      if (!sAt) { this._respond(pcb, { errno: 'ENOTTY' }); break; }
      sAt.setattr(req.actions | 0, req);
      this._respond(pcb, {});
      break;
    }
    case OP.TCGETPGRP: {
      var gPg = this._ttyForFd(pcb, req.fd);
      this._respond(pcb, gPg ? { pgid: gPg.fgPgid } : { errno: 'ENOTTY' });
      break;
    }
    case OP.TCSETPGRP: {
      var sPg = this._ttyForFd(pcb, req.fd);
      if (!sPg) { this._respond(pcb, { errno: 'ENOTTY' }); break; }
      if (!(req.pgid > 0)) { this._respond(pcb, { errno: 'EINVAL' }); break; }
      sPg.fgPgid = req.pgid | 0;
      this._respond(pcb, {});
      break;
    }
    // The master side's resize (0020): winsize words + SIGWINCH to the
    // pty's fg pgroup (Tty.resize, shared with the system tty's bridge).
    case OP.TIOCSWINSZ: {
      var wTty = this._ttyForFd(pcb, req.fd);
      if (!wTty) { this._respond(pcb, { errno: 'ENOTTY' }); break; }
      wTty.resize(req.cols | 0, req.rows | 0);
      this._respond(pcb, {});
      break;
    }
    case OP.PTY_CREATE: {
      // Ptys (todos/0020): the slave is a FULL Tty — line discipline,
      // termios, control-char signal routing, and the deferred-read
      // machinery are reused verbatim; only the byte endpoints differ
      // (the master fd stands where the UI bridge does for the system
      // tty). Echo and slave output land in `out` (pipe-shaped), so
      // master reads and select ride _streamRead/_pipeNotify unchanged.
      if (!this._brokered) { this._respond(pcb, { errno: 'ENOSYS' }); break; }
      var pOut = { buf: [], cap: PTY_OUT_CAP, rOpen: true, wOpen: true,
                   readWaiters: [], writeWaiters: [] };
      var pTty = new Tty(this, {
        output: function (bytes) {
          // Kernel-side echo producer: never blocks; a closed master drops.
          if (!pOut.rOpen || !pOut.wOpen) return;
          for (var eb = 0; eb < bytes.length; eb++) pOut.buf.push(bytes[eb]);
          self._pipeNotify(pOut);
        },
      });
      pTty._brokered = true;
      var pty = { out: pOut, tty: pTty };
      var mO = this._makeOfd('ptm', { pty: pty });
      var sO = this._makeOfd('tty', { tty: pTty, pty: pty });
      mO.refs++; sO.refs++;
      var pmfd = 0; while (pcb.fds.has(pmfd)) pmfd++;
      pcb.fds.set(pmfd, mO.id);
      var psfd = 0; while (pcb.fds.has(psfd)) psfd++;
      pcb.fds.set(psfd, sO.id);
      this._respond(pcb, { mfd: pmfd, sfd: psfd });
      break;
    }
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
      if ((op & 0xf000) === 0x1000) { this._wmRpc(pcb, op, req); break; }
      if ((op & 0xf000) === 0x2000) { this._audioRpc(pcb, op, req); break; }
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
      if (o1.kind === 'ptm') {
        // Master read: post-line-discipline output + echo, pipe-shaped.
        this._streamRead(pcb, o1.pty.out, count);
        return;
      }
      if (o1.kind === 'tty') {
        var tty = o1.tty || pcb.tty;
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
        pcb.waiter = { op: 'ttyread', tty: tty, count: count };   // served by _ttyNotify
        tty.waiters.push(pcb.pid);
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
      if (o2.kind === 'ptm') {
        // Master write = terminal keystrokes: feed the slave's line
        // discipline (echo/signals/canonical editing for free). Input
        // never blocks — an overfull cooked queue drops, like a real tty.
        o2.pty.tty.input(data);
        this._respond(pcb, { n: data.length });
        return;
      }
      if (o2.kind === 'tty') {
        if (o2.pty) { this._ptySlaveWrite(pcb, o2.pty, data); return; }
        this._onOutput(pcb.pid, o2.ch || 1, data.slice());
        this._respond(pcb, { n: data.length });
        return;
      }
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
      this._respond(pcb, { tty: oB && (oB.kind === 'tty' || oB.kind === 'ptm') ? 1 : 0 });
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
      // Kernel-owned endpoints (sockServe, todos/0014) rendezvous first: the
      // kernel holds the server half of the crossed pair natively — bytes
      // drain to the handler via the _pipeNotify drain hook, no PCB involved.
      var ksrv = this._kernelSockServers.get(cres);
      if (ksrv) {
        var ka = sockDir(), kb = sockDir();        // ka: client->kernel, kb: kernel->client
        oc.st = 'conn'; oc.rx = kb; oc.tx = ka;
        var kpeer = this._kernelPeer(ka, kb);
        this._respond(pcb, {});
        try { ksrv(kpeer, pcb); } catch (e) { this._log('sockServe handler: ' + (e && e.message)); kpeer.close(); }
        return;
      }
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

/* ---- kernel-owned AF_UNIX endpoints (todos/0014) ----
 * The kernel as a native socket peer: sockServe(path, onConnect) plants a
 * S_IFSOCK inode and registers the path; a process connect() then yields a
 * `peer` object on the kernel side instead of queueing on a listener.
 * The connection is the same crossed pipe-shaped pair as any socket, so
 * the client side blocks/selects/EOFs through the unchanged machinery; the
 * kernel side never parks — arriving bytes fire peer.onData via the
 * _pipeNotify drain hook, peer-gone fires peer.onClose once.
 *
 * peer.send() ignores the direction's cap: kernel replies (a screenshot is
 * megabytes) buffer in full and the client reads them out in chunks. The
 * peer is trusted system software (wm/wmctl) — a reader that never reads
 * costs kernel memory, not correctness. */

Kernel.prototype.sockServe = function (path, onConnect) {
  if (!this._brokered) throw new Error('sockServe: needs the kernel-owned fs');
  var fs = this._fs;
  // Parent dir + socket node, idempotent across reboots over one image
  // (the node persists in BlockFS; the registration doesn't).
  var slash = path.lastIndexOf('/');
  if (slash > 0) fs.mkdir(path.slice(0, slash), 0o755);      // EEXIST is fine
  if (fs.mknod(path, S_IFSOCK_MODE | 0o777, 0) !== 0) {
    if (fs._lastError !== 'EEXIST' ||
        (fs.unlink(path), fs.mknod(path, S_IFSOCK_MODE | 0o777, 0) !== 0)) {
      throw new Error('sockServe ' + path + ': ' + fs._lastError);
    }
  }
  var resolved;
  try { resolved = fs._resolvePath(path); } catch (e) { resolved = path; }
  this._kernelSockServers.set(resolved || path, onConnect);
};

Kernel.prototype._kernelPeer = function (recvDir, sendDir) {
  var self = this;
  var peer = {
    onData: null,               // (Uint8Array) — set by the endpoint handler
    onClose: null,              // () — client hung up (fires once)
    send: function (bytes) {
      if (!sendDir.rOpen || !sendDir.wOpen) return false;
      for (var i = 0; i < bytes.length; i++) sendDir.buf.push(bytes[i]);
      self._pipeNotify(sendDir);                  // serve the client's park
      return true;
    },
    close: function () {
      sendDir.wOpen = false; recvDir.rOpen = false;
      self._pipeNotify(sendDir); self._pipeNotify(recvDir);
    },
  };
  recvDir.drain = function (chunk) { if (peer.onData) peer.onData(chunk); };
  recvDir.onEof = function () { if (peer.onClose) peer.onClose(); };
  return peer;
};

/* Readiness for FS_SELECT: files and non-pipe write interest are always
 * ready; a tty read is ready when cooked bytes or EOF are waiting; a pipe
 * read is ready on data or writer-gone EOF, a pipe write on free space or
 * reader-gone (the write then surfaces EPIPE). */
/* ============================================================
 * WM surfaces (todos/WM.md; todos/0007 design, spikes todos/0012).
 *
 * The kernel owns the scene — registry, z-order, focus, input routing —
 * and, in v1, the window-management POLICY too (kernel-chrome: title-bar
 * drag-move, click-to-focus, close box; WM.md stages a /bin/wm client for
 * v2, at which point this default policy becomes the WM-crashed fallback).
 *
 * Pixel planes (never RPCs — WM.md's data-plane rule):
 *   shm  — the surface SAB (double-buffered, mailbox); works everywhere,
 *          bit-exact headless screenshots.
 *   gpu  — per-present ImageBitmaps via {type:'wm-frame'} (browser only);
 *          the compositor draws surf.bitmap instead of the SAB.
 * Input rides the per-process ring; every write rings the doorbell.
 * ============================================================ */

Kernel.prototype._wmSetRing = function (pcb, sab) {
  var i32 = new Int32Array(sab);
  var cap = Atomics.load(i32, IR_CAP);
  if (!(cap > 0) || (cap & (cap - 1))) { this._log('wm: bad input ring cap ' + cap); return; }
  pcb.wmRing = { i32: i32, f32: new Float32Array(sab), cap: cap };
};

Kernel.prototype._wmRpc = function (pcb, op, req) {
  switch (op) {
    case OP.SURFACE_CREATE: {
      var w = req.w | 0, h = req.h | 0;
      var fb = pcb._wmPendingFb;
      pcb._wmPendingFb = null;
      if (!(w > 0) || !(h > 0) || w > 8192 || h > 8192) { this._respond(pcb, { errno: 'EINVAL' }); break; }
      if (!fb || fb.byteLength < SH_HDR_BYTES + 2 * w * h * 4) { this._respond(pcb, { errno: 'EINVAL' }); break; }
      var i32 = new Int32Array(fb);
      if (Atomics.load(i32, SH_MAGIC) !== SH_MAGIC_VALUE ||
          Atomics.load(i32, SH_W) !== w || Atomics.load(i32, SH_H) !== h) {
        this._respond(pcb, { errno: 'EINVAL' }); break;
      }
      var sid = this._nextSid++;
      // Cascade placement (kernel default; a connected /bin/wm re-places on
      // EV_CREATED); the client rect is (x,y,w,h) with the title bar above
      // it, so y starts below the bar.
      var n = sid - 1;
      var surf = {
        sid: sid, pid: pcb.pid, sab: fb, i32: i32, u8: new Uint8Array(fb),
        w: w, h: h,
        dstW: w, dstH: h,         // on-screen viewport (todos/0024); wmSetDst
                                  // scales fixed-size surfaces, buffer untouched
        title: typeof req.title === 'string' ? req.title.slice(0, 128) : '',
        x: 8 + ((n * 24) % Math.max(64, this._wmScreen.w >> 2)),
        y: WM_TITLE_H + 8 + ((n * 24) % Math.max(64, this._wmScreen.h >> 2)),
        bitmap: null,             // gpu transport: latest ImageBitmap (browser)
        minimized: false,
        borderless: !!((req.flags | 0) & 1),      // bit0: no kernel chrome (taskbar-class)
        relativeMouse: !!((req.flags | 0) & 2),   // bit1: wants pointer lock (0018)
        resizable: !!((req.flags | 0) & 4),       // bit2: SDL_WINDOW_RESIZABLE (0021)
        pendingConfigure: null,   // { w, h } resize asked, ack not yet in (0019)
      };
      this._surfaces.set(sid, surf);
      this._zOrder.push(sid);
      pcb.surfaces.add(sid);
      this._focusSid = sid;       // new window takes focus (v1 policy)
      this._wmVersion++;
      this._respond(pcb, { sid: sid, x: surf.x, y: surf.y });
      this._wmEmit(WMP.EV_CREATED, this._wmpRecord(surf));
      this._wmEmit(WMP.EV_FOCUS, [sid]);
      this._wmSyncPointerLock();
      break;
    }
    // Update the surface flag word (todos/0018): bit0 borderless, bit1
    // relative-mouse, bit2 resizable (0021). The pointer-lock sync below
    // round-trips a wanted-state change to the UI bridge.
    case OP.SURFACE_SET_FLAGS: {
      var sf = this._surfaces.get(req.sid | 0);
      if (!sf || sf.pid !== pcb.pid) { this._respond(pcb, { errno: 'EINVAL' }); break; }
      var fl = req.flags | 0;
      sf.borderless = !!(fl & 1);
      sf.relativeMouse = !!(fl & 2);
      sf.resizable = !!(fl & 4);
      // Resizable and scaled are exclusive modes (todos/0024): granting
      // bit2 snaps the viewport back to the buffer (resizable => dst == w/h).
      if (sf.resizable && (sf.dstW !== sf.w || sf.dstH !== sf.h)) {
        sf.dstW = sf.w; sf.dstH = sf.h;
        this._wmEmit(WMP.EV_SCALED, [sf.sid, sf.dstW, sf.dstH]);
      }
      this._wmVersion++;
      this._respond(pcb, {});
      this._wmSyncPointerLock();
      break;
    }
    case OP.SURFACE_DESTROY: {
      var s = this._surfaces.get(req.sid | 0);
      if (!s || s.pid !== pcb.pid) { this._respond(pcb, { errno: 'EINVAL' }); break; }
      this._wmDestroySurface(s.sid);
      this._respond(pcb, {});
      break;
    }
    case OP.SURFACE_SET_TITLE: {
      var st = this._surfaces.get(req.sid | 0);
      if (!st || st.pid !== pcb.pid) { this._respond(pcb, { errno: 'EINVAL' }); break; }
      st.title = typeof req.title === 'string' ? req.title.slice(0, 128) : '';
      this._wmVersion++;
      this._respond(pcb, {});
      this._wmEmit(WMP.EV_TITLE, [st.sid], st.title);
      break;
    }
    // The resize ack (todos/0019). Only valid while a configure is pending
    // (resize is kernel-initiated; there is no client-initiated resize).
    // The new SAB's front buffer already holds a frame at the new size, so
    // the swap is the whole no-tearing story. In-flight frames on the OLD
    // SAB are simply never looked at again — legal and ignored (mailbox).
    case OP.SURFACE_CONFIGURE: {
      var sc = this._surfaces.get(req.sid | 0);
      var fb2 = pcb._wmPendingFb;
      pcb._wmPendingFb = null;
      var cw = req.w | 0, ch = req.h | 0;
      if (!sc || sc.pid !== pcb.pid || !sc.pendingConfigure ||
          !(cw > 0) || !(ch > 0) || cw > 8192 || ch > 8192 ||
          !fb2 || fb2.byteLength < SH_HDR_BYTES + 2 * cw * ch * 4) {
        this._respond(pcb, { errno: 'EINVAL' }); break;
      }
      var ci32 = new Int32Array(fb2);
      if (Atomics.load(ci32, SH_MAGIC) !== SH_MAGIC_VALUE ||
          Atomics.load(ci32, SH_W) !== cw || Atomics.load(ci32, SH_H) !== ch) {
        this._respond(pcb, { errno: 'EINVAL' }); break;
      }
      sc.sab = fb2; sc.i32 = ci32; sc.u8 = new Uint8Array(fb2);
      sc.w = cw; sc.h = ch;
      sc.dstW = cw; sc.dstH = ch;   // configure implies resizable: dst tracks
                                    // the buffer (never scaled, todos/0024)
      if (sc.pendingConfigure.w !== cw || sc.pendingConfigure.h !== ch) {
        // Superseded while the client was renegotiating: latest wins — keep
        // the (valid, newer-than-old) buffer and re-issue the configure.
        this._wmEventTo(sc.sid, [WMEV.WINDOW_RESIZED, 0,
          sc.pendingConfigure.w, sc.pendingConfigure.h, 0, 0, 0, 0]);
      } else {
        sc.pendingConfigure = null;
      }
      this._wmVersion++;
      this._respond(pcb, { sid: sc.sid, w: cw, h: ch });
      this._wmEmit(WMP.EV_CONFIGURED, [sc.sid, cw, ch]);
      break;
    }
    default: this._respond(pcb, { errno: 'ENOSYS' });
  }
};

Kernel.prototype._wmDestroySurface = function (sid) {
  var s = this._surfaces.get(sid);
  if (!s) return;
  this._surfaces.delete(sid);
  var zi = this._zOrder.indexOf(sid);
  if (zi >= 0) this._zOrder.splice(zi, 1);
  var owner = this._procs.get(s.pid);
  if (owner) owner.surfaces.delete(sid);
  if (s.bitmap && s.bitmap.close) { try { s.bitmap.close(); } catch (e) {} }
  if (this._wmDrag && this._wmDrag.sid === sid) this._wmDrag = null;
  if (this._wmResizeDrag && this._wmResizeDrag.sid === sid) this._wmResizeDrag = null;
  if (this._focusSid === sid) {
    this._focusSid = 0;
    for (var i = this._zOrder.length - 1; i >= 0; i--) {
      var t = this._surfaces.get(this._zOrder[i]);
      if (t && !t.minimized) { this._focusSid = t.sid; break; }
    }
    this._wmEmit(WMP.EV_FOCUS, [this._focusSid]);
  }
  this._wmVersion++;
  this._wmEmit(WMP.EV_DESTROYED, [sid]);
  this._wmSyncPointerLock();
};

/* ---- pointer lock (todos/0018) ----
 * WANTED = the focused surface requested relative mouse (and is on screen).
 * The kernel tells the UI bridge on every wanted-state CHANGE (onPointerLock);
 * the bridge does the Pointer Lock API dance (the lock needs a user gesture,
 * so it arms click-to-lock; ESC drops it browser-side) and reports actual
 * transitions back via wmPointerLockChanged. While the lock is ACTIVE,
 * wmPointer routes everything to the focused surface with relative motion
 * records — no hit-testing (there is no cursor). Unlocked, routing is the
 * normal absolute path, so the window stays draggable/closable. */
Kernel.prototype._wmSyncPointerLock = function () {
  var s = this._surfaces.get(this._focusSid);
  var wanted = !!(s && s.relativeMouse && !s.minimized);
  if (wanted !== this._wmPtrLockWanted) {
    this._wmPtrLockWanted = wanted;
    if (!wanted) this._wmPtrLockActive = false;   // routing reverts immediately;
                                                  // the bridge exit is async
    this._wmVersion++;
    this._onPointerLock(wanted);
  }
};

Kernel.prototype.wmPointerLockChanged = function (active) {
  this._wmPtrLockActive = !!active && this._wmPtrLockWanted;
};

/* ============================================================
 * Audio mixer (todos/0017; design: WM.md "Audio mixing — the kernel sound
 * server"). Control plane: AUDIO_OPEN/AUDIO_CLOSE below. Data plane: the
 * pump — pure math over SABs, no timers here (the embedder schedules it;
 * tests call it with an explicit frame budget).
 * ============================================================ */

/* Bytes per sample + float decoder per SDL format word. The decode is
 * CORRECT per format (unlike the page receiver's legacy S8 quirk — the
 * mixer owns both ends of the source rings, so there is no compatibility
 * to preserve). */
function audioFormatInfo(format) {
  switch (format | 0) {
    case AU_FMT_F32: return { bytes: 4, decode: function (dv, off) { return dv.getFloat32(off, true); } };
    case AU_FMT_S32: return { bytes: 4, decode: function (dv, off) { return dv.getInt32(off, true) / 2147483648; } };
    case AU_FMT_S16: return { bytes: 2, decode: function (dv, off) { return dv.getInt16(off, true) / 32768; } };
    case AU_FMT_S8:  return { bytes: 1, decode: function (dv, off) { return dv.getInt8(off) / 128; } };
    case AU_FMT_U8:  return { bytes: 1, decode: function (dv, off) { return (dv.getUint8(off) - 128) / 128; } };
    default: return null;
  }
}

Kernel.prototype._audioRpc = function (pcb, op, req) {
  switch (op) {
    case OP.AUDIO_OPEN: {
      var sab = pcb._audioPendingSab;
      pcb._audioPendingSab = null;
      var freq = req.freq | 0, channels = req.channels | 0;
      var fmt = audioFormatInfo(req.format);
      if (!sab || sab.byteLength <= AU_HDR_BYTES || !fmt ||
          freq < 4000 || freq > 192000 || (channels !== 1 && channels !== 2)) {
        this._respond(pcb, { errno: 'EINVAL' }); break;
      }
      var cap = sab.byteLength - AU_HDR_BYTES;
      var frameBytes = fmt.bytes * channels;
      // A frame must never straddle the ring wrap (samples are read with a
      // DataView at a linear offset) — require frame-aligned capacity.
      if (cap % frameBytes !== 0) { this._respond(pcb, { errno: 'EINVAL' }); break; }
      var aid = this._nextAid++;
      this._audioStreams.set(aid, {
        aid: aid, pid: pcb.pid,
        control: new Int32Array(sab, 0, 4),
        dv: new DataView(sab, AU_HDR_BYTES, cap),
        cap: cap, freq: freq, channels: channels,
        sampleBytes: fmt.bytes, frameBytes: frameBytes, decode: fmt.decode,
        frac: 0,        // fractional resample cursor, in source frames [0, 1)
        dying: false,   // close/exit marked; drains dry, then reclaimed
      });
      pcb.audios.add(aid);
      this._respond(pcb, { aid: aid });
      break;
    }
    case OP.AUDIO_CLOSE: {
      var s = this._audioStreams.get(req.aid | 0);
      if (!s || s.pid !== pcb.pid) { this._respond(pcb, { errno: 'EINVAL' }); break; }
      pcb.audios.delete(s.aid);
      this._audioMarkDying(s);
      this._respond(pcb, {});
      break;
    }
    default: this._respond(pcb, { errno: 'ENOSYS' });
  }
};

/* Close/exit path: drain what's queued (sfx tails finish), drop what can't
 * drain — a paused ring will never be consumed, and with no output ring the
 * pump never runs. Never wedge the mixer on a dead process. */
Kernel.prototype._audioMarkDying = function (s) {
  s.dying = true;
  if (!this._audioOut || !Atomics.load(s.control, AU_PLAYING) ||
      Atomics.load(s.control, AU_QUEUED) <= 0) {
    this._audioStreams.delete(s.aid);
  }
};

/* Allocate + install the output ring (browser kernel-worker calls this at
 * boot and hands the SAB to the page; tests call it directly). Fixed f32
 * stereo AU_OUT_FREQ — the receiver end is host.js createAudioReceiver. */
Kernel.prototype.audioInit = function (opts) {
  opts = opts || {};
  var cap = (opts.bufferSize | 0) || AU_OUT_RING_BYTES;
  var sab = new SharedArrayBuffer(AU_HDR_BYTES + cap);
  this._audioOut = {
    sab: sab, control: new Int32Array(sab, 0, 4),
    f32: null, u8: new Uint8Array(sab, AU_HDR_BYTES, cap),
    cap: cap, freq: AU_OUT_FREQ, channels: AU_OUT_CHANNELS,
  };
  return { sab: sab, bufferSize: cap, freq: AU_OUT_FREQ,
           channels: AU_OUT_CHANNELS, format: AU_FMT_F32 };
};

/* Test/debug view of the stream table. */
Kernel.prototype.audioList = function () {
  var out = [];
  this._audioStreams.forEach(function (s) {
    out.push({ aid: s.aid, pid: s.pid, freq: s.freq, channels: s.channels,
               dying: s.dying, queued: Atomics.load(s.control, AU_QUEUED) });
  });
  return out;
};

/* The mix. Tops the output ring up to AU_TARGET_MS (or maxFrames when the
 * caller bounds it — tests), producing only as many frames as the MOST-
 * available active stream can fill: a starved app pads with silence next
 * to a healthy one, but a lone app never has silence manufactured ahead
 * of data that is about to arrive. Per stream: linear-interp resample on
 * a persistent fractional cursor, mono duplicated, float sum, clamp.
 * Everything here is deterministic math over the SABs. */
Kernel.prototype.audioPump = function (maxFrames) {
  var out = this._audioOut;
  if (!out) return 0;

  // Reclaim dying streams that went dry or paused since the last pump.
  var self = this;
  var dead = null;
  this._audioStreams.forEach(function (s) {
    if (s.dying && (!Atomics.load(s.control, AU_PLAYING) ||
                    Atomics.load(s.control, AU_QUEUED) <= 0)) {
      (dead = dead || []).push(s.aid);
    }
  });
  if (dead) dead.forEach(function (aid) { self._audioStreams.delete(aid); });

  var outFrameBytes = 4 * out.channels;              // f32 interleaved
  var queued = Atomics.load(out.control, AU_QUEUED);
  if (queued < 0) { Atomics.store(out.control, AU_QUEUED, 0); queued = 0; }
  var targetBytes = Math.min(out.cap,
    Math.floor(AU_TARGET_MS * out.freq / 1000) * outFrameBytes);
  var wantFrames = Math.floor(Math.min(out.cap - queued, targetBytes - queued) / outFrameBytes);
  if (maxFrames !== undefined) wantFrames = Math.min(wantFrames, maxFrames | 0);
  if (wantFrames <= 0) return 0;

  // Snapshot each active stream: how many output frames can it back?
  var active = [];
  var mostAvail = 0;
  this._audioStreams.forEach(function (s) {
    if (!Atomics.load(s.control, AU_PLAYING)) return;   // paused: skip, keep queued
    var qb = Atomics.load(s.control, AU_QUEUED);
    if (qb < 0) { Atomics.store(s.control, AU_QUEUED, 0); qb = 0; }  // clear() race heal
    var srcFrames = Math.floor(qb / s.frameBytes);
    if (srcFrames <= 0) return;
    var ratio = s.freq / out.freq;
    var avail = Math.floor((srcFrames - s.frac) / ratio);
    if (avail <= 0) return;
    // readPos = writePos - queuedBytes (the standalone receiver's derivation).
    // Frame-aligned by construction: the surface-flavor producer only pushes
    // whole frames (host.js), consumption subtracts whole frames, and clear
    // resets to wpos itself. The wpos/queued loads are two cells, so a
    // concurrent push can skew one pump by a frame's worth — transient and
    // self-healing (next pump re-derives), same class as the standalone
    // receiver's race.
    var wpos = Atomics.load(s.control, AU_WPOS) % s.cap;
    var readBase = ((wpos - qb) % s.cap + s.cap) % s.cap;
    active.push({ s: s, srcFrames: srcFrames, ratio: ratio, readBase: readBase, avail: avail });
    if (avail > mostAvail) mostAvail = avail;
  });
  if (mostAvail === 0) return 0;

  var frames = Math.min(wantFrames, mostAvail);
  var mixL = new Float32Array(frames);
  var mixR = new Float32Array(frames);

  for (var ai = 0; ai < active.length; ai++) {
    var a = active[ai], s = a.s;
    var n = Math.min(frames, a.avail);
    var pos = s.frac;
    for (var i = 0; i < n; i++) {
      var i0 = Math.floor(pos);
      var t = pos - i0;
      var i1 = i0 + 1 < a.srcFrames ? i0 + 1 : i0;   // clamp lookahead at the edge
      var off0 = (a.readBase + i0 * s.frameBytes) % s.cap;
      var off1 = (a.readBase + i1 * s.frameBytes) % s.cap;
      var l0 = s.decode(s.dv, off0), l1 = s.decode(s.dv, off1);
      var L = l0 + (l1 - l0) * t, R;
      if (s.channels === 2) {
        var r0 = s.decode(s.dv, off0 + s.sampleBytes);
        var r1 = s.decode(s.dv, off1 + s.sampleBytes);
        R = r0 + (r1 - r0) * t;
      } else {
        R = L;
      }
      mixL[i] += L;
      mixR[i] += R;
      pos += a.ratio;
    }
    // Consume whole source frames; the fractional remainder carries over.
    var consumed = Math.min(Math.floor(pos), a.srcFrames);
    s.frac = pos - consumed;
    if (consumed > 0) Atomics.sub(s.control, AU_QUEUED, consumed * s.frameBytes);
  }

  // Write f32 interleaved into the output ring (the __sdl_queue_audio
  // producer discipline: fill, then advance writePos masked mod cap, then
  // publish via queuedBytes).
  var bytes = frames * outFrameBytes;
  var chunk = new Uint8Array(bytes);
  var cdv = new DataView(chunk.buffer);
  for (var f = 0; f < frames; f++) {
    cdv.setFloat32(f * outFrameBytes, Math.max(-1, Math.min(1, mixL[f])), true);
    cdv.setFloat32(f * outFrameBytes + 4, Math.max(-1, Math.min(1, mixR[f])), true);
  }
  var owpos = Atomics.load(out.control, AU_WPOS) % out.cap;
  var first = Math.min(bytes, out.cap - owpos);
  out.u8.set(chunk.subarray(0, first), owpos);
  if (first < bytes) out.u8.set(chunk.subarray(first), 0);
  Atomics.store(out.control, AU_WPOS, (owpos + bytes) % out.cap);
  Atomics.add(out.control, AU_QUEUED, bytes);
  return frames;
};

/* gpu transport (browser): latest-frame-wins; superseded bitmaps are closed
 * immediately so GPU memory can't balloon behind a slow compositor (WM.md
 * "lifetime discipline"). */
Kernel.prototype._wmFrame = function (pcb, sid, bmp) {
  var s = this._surfaces.get(sid);
  if (!s || s.pid !== pcb.pid || !bmp) {
    if (bmp && bmp.close) { try { bmp.close(); } catch (e) {} }
    return;
  }
  if (s.bitmap && s.bitmap.close) { try { s.bitmap.close(); } catch (e) {} }
  s.bitmap = bmp;
  Atomics.add(s.i32, SH_SEQ, 1);   // frameSeq accounting rides the header either way
};

/* ---- input ring (kernel = single producer) ---- */

Kernel.prototype._wmPushEvent = function (pcb, words) {
  var ring = pcb.wmRing;
  if (!ring) return false;
  var cap2 = ring.cap * 2;
  var wpos = Atomics.load(ring.i32, IR_WPOS);
  var rpos = Atomics.load(ring.i32, IR_RPOS);
  if (((wpos - rpos + cap2) % cap2) >= ring.cap) {         // full: drop-newest
    Atomics.add(ring.i32, IR_DROPPED, 1);
    return false;
  }
  var base = (IR_HDR_BYTES >> 2) + (wpos % ring.cap) * IR_RECORD_WORDS;
  for (var k = 0; k < IR_RECORD_WORDS; k++) ring.i32[base + k] = words[k] | 0;
  Atomics.store(ring.i32, IR_WPOS, (wpos + 1) % cap2);
  this._ring(pcb);                                          // wake SDL_WaitEvent parks
  return true;
};

var _wmF32Scratch = new Float32Array(1);
var _wmI32Scratch = new Int32Array(_wmF32Scratch.buffer);
function f32bits(v) { _wmF32Scratch[0] = v; return _wmI32Scratch[0]; }

Kernel.prototype._wmEventTo = function (sid, words) {
  var s = this._surfaces.get(sid);
  if (!s) return false;
  var pcb = this._procs.get(s.pid);
  if (!pcb || pcb.state !== STATE_RUNNING) return false;
  words[1] = sid;
  return this._wmPushEvent(pcb, words);
};

/* ---- raw input from the UI bridge (SCREEN coordinates) ----
 * The kernel hit-tests against the scene and routes: client-area events go
 * to the owning process (window-local coords); chrome events run the v1
 * policy right here. The agent inject API below shares these code paths. */

Kernel.prototype.wmKey = function (down, scancode, keysym, mod, repeat) {
  if (!this._focusSid) return false;
  return this._wmEventTo(this._focusSid,
    [down ? WMEV.KEYDOWN : WMEV.KEYUP, 0, scancode | 0, keysym | 0, mod | 0, repeat ? 1 : 0, 0, 0]);
};

/* kind: 'move' | 'down' | 'up' | 'wheel'; opts: { button, buttons, wheelX,
 * wheelY, direction, dx, dy }. Returns what happened (for tests/bridge
 * cursors). While the pointer lock is active (todos/0018) the bridge sends
 * moves with dx/dy deltas instead of coordinates. */
Kernel.prototype.wmPointer = function (kind, x, y, opts) {
  opts = opts || {};
  // Pointer lock active: everything goes to the focused relative-mouse
  // surface — motion as relative records, buttons/wheel at the client
  // center (SDL freezes the position in relative mode; apps read deltas).
  // No hit-test, no chrome: there is no cursor while locked.
  if (this._wmPtrLockActive) {
    var lockSurf = this._surfaces.get(this._focusSid);
    if (lockSurf && lockSurf.relativeMouse && !lockSurf.minimized) {
      if (kind === 'move') {
        this._wmEventTo(lockSurf.sid, [WMEV.MOUSEMOTION, 0,
          f32bits(opts.dx || 0), f32bits(opts.dy || 0), opts.buttons | 0, 1, 0, 0]);
      } else if (kind === 'down' || kind === 'up') {
        this._wmEventTo(lockSurf.sid, [kind === 'down' ? WMEV.MOUSEBUTTONDOWN : WMEV.MOUSEBUTTONUP,
          0, f32bits(lockSurf.w / 2), f32bits(lockSurf.h / 2), (opts.button | 0) || 1, 0, 0, 0]);
      } else if (kind === 'wheel') {
        this._wmEventTo(lockSurf.sid, [WMEV.MOUSEWHEEL, 0, f32bits(opts.wheelX || 0),
          f32bits(opts.wheelY || 0), opts.direction | 0, 0, 0, 0]);
      }
      return 'locked';
    }
  }
  // An in-flight title drag captures the pointer (kernel-enforced capture).
  if (this._wmDrag) {
    var d = this._wmDrag, ds = this._surfaces.get(d.sid);
    if (!ds) { this._wmDrag = null; }
    else if (kind === 'move') {
      ds.x = Math.round(x - d.dx);
      ds.y = Math.round(y - d.dy);
      // Keep the title bar reachable: clamp to the screen (on-screen size
      // is the dst rect, todos/0024).
      ds.x = Math.max(40 - ds.dstW, Math.min(ds.x, this._wmScreen.w - 40));
      ds.y = Math.max(WM_TITLE_H, Math.min(ds.y, this._wmScreen.h - 8));
      this._wmVersion++;
      return 'drag';
    } else if (kind === 'up') {
      var dend = this._wmDrag;
      this._wmDrag = null;
      var dsurf = this._surfaces.get(dend.sid);
      if (dsurf) this._wmEmit(WMP.EV_MOVED, [dsurf.sid, dsurf.x, dsurf.y]);
      return 'drag-end';
    }
  }
  // An in-flight border resize drag captures the pointer too (todos/0019).
  // Win95 outline semantics: the drag only tracks a preview rectangle (the
  // compositor draws it from wmScene().resizeDrag); ONE configure goes to
  // the client at release — no per-motion SAB renegotiation.
  if (this._wmResizeDrag) {
    var rd = this._wmResizeDrag, rs = this._surfaces.get(rd.sid);
    if (!rs) { this._wmResizeDrag = null; }
    else if (kind === 'move') {
      if (rd.ex) rd.curW = Math.max(WM_MIN_SIZE, Math.min(8192, rd.baseW + Math.round(x - rd.x0)));
      if (rd.ey) rd.curH = Math.max(WM_MIN_SIZE, Math.min(8192, rd.baseH + Math.round(y - rd.y0)));
      this._wmVersion++;
      return 'resize';
    } else if (kind === 'up') {
      var rdend = this._wmResizeDrag;
      this._wmResizeDrag = null;
      this._wmVersion++;
      if (rdend.curW !== rdend.baseW || rdend.curH !== rdend.baseH) {
        if (rs.resizable) {
          this.wmResize(rdend.sid, rdend.curW, rdend.curH);
        } else if (this._wmSubs.size) {
          // Scale drag on a fixed-size surface (todos/0024): policy decides
          // the dst — /bin/wm answers with an aspect-preserving SET_DST.
          this._wmEmit(WMP.EV_SCALE_REQ, [rdend.sid, rdend.curW, rdend.curH]);
        } else {
          // No-WM fallback: apply the raw dragged box.
          this.wmSetDst(rdend.sid, rdend.curW, rdend.curH);
        }
      }
      return 'resize-end';
    }
  }
  // Hit test, topmost first, against the ON-SCREEN rect — the dst viewport
  // (todos/0024; equals the buffer unless scaled): what you click is what
  // you see. Minimized surfaces aren't on screen; borderless ones (taskbar-
  // class) have no title-bar band and no frame.
  for (var i = this._zOrder.length - 1; i >= 0; i--) {
    var s = this._surfaces.get(this._zOrder[i]);
    if (!s || s.minimized) continue;
    var dw = s.dstW, dh = s.dstH;
    var inTitle = !s.borderless &&
      x >= s.x && x < s.x + dw && y >= s.y - WM_TITLE_H && y < s.y;
    var inClient = x >= s.x && x < s.x + dw && y >= s.y && y < s.y + dh;
    // The resize frame: a WM_BORDER band around title+client (todos/0019).
    var inFrame = !s.borderless && !inTitle && !inClient &&
      x >= s.x - WM_BORDER && x < s.x + dw + WM_BORDER &&
      y >= s.y - WM_TITLE_H - WM_BORDER && y < s.y + dh + WM_BORDER;
    if (inFrame) {
      if (kind === 'down') {
        this.wmFocus(s.sid);
        // Drag zones on E/S/SE edges. Both kinds get them since todos/0024;
        // the release dispatches on the resizable bit — configure (0019) vs
        // scale the dst rect (fixed-res apps like doom stay oblivious).
        var ex = x >= s.x + dw ? 1 : 0;                // right edge -> E
        var ey = y >= s.y + dh ? 1 : 0;                // bottom edge -> S
        // A WM_GRIP corner zone widens E/S into SE near the corner.
        if (ex && y >= s.y + dh - WM_GRIP) ey = 1;
        if (ey && x >= s.x + dw - WM_GRIP) ex = 1;
        if (!ex && !ey) return 'border';               // left/top: focus only
        this._wmResizeDrag = { sid: s.sid, ex: ex, ey: ey, x0: x, y0: y,
                               baseW: dw, baseH: dh, curW: dw, curH: dh };
        return 'resize-start';
      }
      return 'border';
    }
    if (inTitle) {
      if (kind === 'down') {
        var cx0 = s.x + dw - WM_CLOSE_W - WM_CLOSE_PAD;
        var cy0 = s.y - WM_TITLE_H + WM_CLOSE_PAD;
        if (x >= cx0 && x < cx0 + WM_CLOSE_W && y >= cy0 && y < cy0 + WM_CLOSE_W) {
          // Close = request-close: SDL_EVENT_QUIT to the owner (graceful;
          // agents/wmctl can still kill). v1: no per-window close event.
          this._wmEventTo(s.sid, [WMEV.QUIT, 0, 0, 0, 0, 0, 0, 0]);
          return 'close';
        }
        this.wmFocus(s.sid);
        // Title double-click (todos/0025): a second down on the SAME title
        // within WM_DBLCLICK_MS and WM_DBLCLICK_SLOP px is the maximize
        // gesture — EV_TITLE_ACTIVATE to the WM, and NO drag starts (so the
        // gesture never also moves the window). Mechanism only: policy
        // (/bin/wm) toggles maximize; with no subscriber the event goes
        // nowhere (the kernel-chrome fallback has no maximize, by design).
        // Two slow clicks just focus-and-drag twice; a title drag that
        // MOVED the window breaks the slop check, so drag-drop-drag never
        // misfires. opts.t (ms, any consistent origin — the bridge sends
        // event timestamps) overrides the clock for deterministic tests.
        var t = opts.t !== undefined ? opts.t : Date.now();
        var lastDown = this._wmTitleDown;
        this._wmTitleDown = { sid: s.sid, x: x, y: y, t: t };
        if (lastDown && lastDown.sid === s.sid &&
            t - lastDown.t >= 0 && t - lastDown.t <= WM_DBLCLICK_MS &&
            Math.abs(x - lastDown.x) <= WM_DBLCLICK_SLOP &&
            Math.abs(y - lastDown.y) <= WM_DBLCLICK_SLOP) {
          this._wmTitleDown = null;            // a third click starts over
          this._wmEmit(WMP.EV_TITLE_ACTIVATE, [s.sid]);
          return 'title-activate';
        }
        this._wmDrag = { sid: s.sid, dx: x - s.x, dy: y - s.y };
        return 'drag-start';
      }
      return 'title';
    }
    if (inClient) {
      // Click-to-focus — except borderless (taskbar-class) surfaces, which
      // receive the click but never steal focus: a taskbar click must see
      // the focus state it's acting ON (minimize-toggle), and Win95 agrees.
      // A borderless surface gets focus only via the WM protocol.
      if (kind === 'down' && !s.borderless) this.wmFocus(s.sid);
      // A client click on the focused relative-mouse surface IS the lock
      // gesture (todos/0018): re-offer the wanted state so the UI bridge
      // requests the pointer lock inside the click's transient activation.
      // Chrome/title/desktop clicks never re-offer — dragging stays intact.
      if (kind === 'down' && s.relativeMouse && s.sid === this._focusSid &&
          this._wmPtrLockWanted && !this._wmPtrLockActive) {
        this._onPointerLock(true);
      }
      // Inverse-map through the scale (todos/0024): the client thinks in
      // BUFFER coordinates; screen offsets shrink/grow by w/dstW. Exact
      // identity when unscaled (dst == buffer).
      var lx = (x - s.x) * s.w / dw, ly = (y - s.y) * s.h / dh;
      if (kind === 'move') {
        this._wmEventTo(s.sid, [WMEV.MOUSEMOTION, 0, f32bits(lx), f32bits(ly), opts.buttons | 0, 0, 0, 0]);
      } else if (kind === 'down' || kind === 'up') {
        this._wmEventTo(s.sid, [kind === 'down' ? WMEV.MOUSEBUTTONDOWN : WMEV.MOUSEBUTTONUP,
          0, f32bits(lx), f32bits(ly), (opts.button | 0) || 1, 0, 0, 0]);
      } else if (kind === 'wheel') {
        this._wmEventTo(s.sid, [WMEV.MOUSEWHEEL, 0, f32bits(opts.wheelX || 0),
          f32bits(opts.wheelY || 0), opts.direction | 0, 0, 0, 0]);
      }
      return 'client';
    }
  }
  return 'desktop';
};

/* ---- the agent control channel (WM.md hard requirement) ----
 * One op set, defined once: these kernel-JS methods serve the outside
 * (test harness, Node agents); wmctl RPCs can wrap the same methods later. */

Kernel.prototype.wmList = function () {
  var out = [];
  for (var i = 0; i < this._zOrder.length; i++) {
    var s = this._surfaces.get(this._zOrder[i]);
    if (!s) continue;
    out.push({ sid: s.sid, pid: s.pid, x: s.x, y: s.y, w: s.w, h: s.h,
               dstW: s.dstW, dstH: s.dstH,
               title: s.title, z: i, focused: s.sid === this._focusSid,
               minimized: s.minimized, borderless: s.borderless,
               relativeMouse: !!s.relativeMouse, resizable: !!s.resizable,
               configurePending: !!s.pendingConfigure,
               frameSeq: Atomics.load(s.i32, SH_SEQ) });
  }
  return out;
};

Kernel.prototype.wmFocus = function (sid) {
  var s = this._surfaces.get(sid | 0);
  if (!s) return false;
  if (s.minimized) {                                            // focus restores
    s.minimized = false;
    this._wmVersion++;
    this._wmEmit(WMP.EV_MINIMIZED, [s.sid, 0]);
  }
  var zi = this._zOrder.indexOf(s.sid);
  if (zi >= 0 && zi !== this._zOrder.length - 1) {
    this._zOrder.splice(zi, 1);
    this._zOrder.push(s.sid);
  }
  if (this._focusSid !== s.sid) {
    this._focusSid = s.sid;
    this._wmVersion++;
    this._wmEmit(WMP.EV_FOCUS, [s.sid]);
  }
  this._wmSyncPointerLock();
  return true;
};

Kernel.prototype.wmMove = function (sid, x, y) {
  var s = this._surfaces.get(sid | 0);
  if (!s) return false;
  s.x = x | 0; s.y = y | 0;
  this._wmVersion++;
  this._wmEmit(WMP.EV_MOVED, [s.sid, s.x, s.y]);
  return true;
};

/* Ask the client to resize (todos/0019). Geometry does NOT change here —
 * the surface keeps its old buffer and size until the SURFACE_CONFIGURE
 * ack lands (so a slow client shows its last frame, never a torn one).
 * Latest wins: a new request while one is pending replaces it, and the ack
 * path re-issues the configure if the client acked a stale size. Returns
 * false when the request can't reach the client (dead process, full ring):
 * nothing would ever ack, so no pending state is left behind. Non-resizable
 * surfaces (no SDL_WINDOW_RESIZABLE, todos/0021) refuse outright — same
 * no-pending-state rule: the app would never renegotiate. */
Kernel.prototype.wmResize = function (sid, w, h) {
  var s = this._surfaces.get(sid | 0);
  if (!s || !s.resizable) return false;
  w = w | 0; h = h | 0;
  if (w < WM_MIN_SIZE || h < WM_MIN_SIZE || w > 8192 || h > 8192) return false;
  if (w === s.w && h === s.h && !s.pendingConfigure) return true;   // no-op
  var prev = s.pendingConfigure;
  s.pendingConfigure = { w: w, h: h };
  if (!this._wmEventTo(s.sid, [WMEV.WINDOW_RESIZED, 0, w, h, 0, 0, 0, 0])) {
    s.pendingConfigure = prev;
    return false;
  }
  return true;
};

/* Set the on-screen dst viewport of a FIXED-SIZE surface (todos/0024 —
 * the wp_viewport / DWM-DPI-virtualization shape): the buffer keeps its
 * size, the compositor maps it to dstW x dstH (nearest-neighbor), input
 * inverse-maps, and the app never knows. Resizable surfaces refuse — they
 * configure (todos/0019/0021); the two modes are exclusive by design, and
 * maximize (todos/0025) dispatches on the same bit. Echoes EV_SCALED. */
Kernel.prototype.wmSetDst = function (sid, w, h) {
  var s = this._surfaces.get(sid | 0);
  if (!s || s.resizable) return false;
  w = w | 0; h = h | 0;
  if (w < WM_MIN_SIZE || h < WM_MIN_SIZE || w > 8192 || h > 8192) return false;
  if (w === s.dstW && h === s.dstH) return true;    // no-op
  s.dstW = w; s.dstH = h;
  this._wmVersion++;
  this._wmEmit(WMP.EV_SCALED, [s.sid, w, h]);
  return true;
};

/* Fire the title-activate (maximize) gesture for a surface — the same
 * EV_TITLE_ACTIVATE the title-bar double-click emits, so wmctl max and the
 * mouse share ONE policy path in /bin/wm (todos/0025). Mechanism only: the
 * kernel keeps no maximize state; policy dispatches configure-vs-scale on
 * the resizable bit and holds the saved geometry. Refuses without a
 * subscriber (maximize IS policy — nothing would ever answer) and on
 * borderless surfaces (no title bar, no gesture). */
Kernel.prototype.wmTitleActivate = function (sid) {
  var s = this._surfaces.get(sid | 0);
  if (!s || s.borderless) return false;
  if (!this._wmSubs.size) return false;
  this._wmEmit(WMP.EV_TITLE_ACTIVATE, [s.sid]);
  return true;
};

/* Minimize: off screen + out of hit-testing, still listed. Focus falls to
 * the top non-minimized surface. Restore = wmFocus (which un-minimizes). */
Kernel.prototype.wmMinimize = function (sid) {
  var s = this._surfaces.get(sid | 0);
  if (!s) return false;
  if (s.minimized) return true;
  s.minimized = true;
  this._wmEmit(WMP.EV_MINIMIZED, [s.sid, 1]);
  if (this._wmDrag && this._wmDrag.sid === s.sid) this._wmDrag = null;
  if (this._wmResizeDrag && this._wmResizeDrag.sid === s.sid) this._wmResizeDrag = null;
  if (this._focusSid === s.sid) {
    this._focusSid = 0;
    for (var i = this._zOrder.length - 1; i >= 0; i--) {
      var t = this._surfaces.get(this._zOrder[i]);
      if (t && !t.minimized) { this._focusSid = t.sid; break; }
    }
    this._wmEmit(WMP.EV_FOCUS, [this._focusSid]);
  }
  this._wmVersion++;
  this._wmSyncPointerLock();
  return true;
};

/* place: 0 = raise to top (without stealing focus), 1 = lower to bottom. */
Kernel.prototype.wmRestack = function (sid, place) {
  var s = this._surfaces.get(sid | 0);
  if (!s) return false;
  var zi = this._zOrder.indexOf(s.sid);
  if (zi < 0) return false;
  this._zOrder.splice(zi, 1);
  if ((place | 0) === 1) this._zOrder.unshift(s.sid);
  else this._zOrder.push(s.sid);
  this._wmVersion++;
  return true;
};

/* Synthetic input TARGETED at a window id (post-hit-test injection into the
 * same rings as real input — xdotool-as-a-syscall). Pointer coords are
 * window-local. sid 0 = the focused window. */
Kernel.prototype.wmInjectKey = function (sid, down, scancode, keysym, mod) {
  var target = (sid | 0) || this._focusSid;
  return this._wmEventTo(target,
    [down ? WMEV.KEYDOWN : WMEV.KEYUP, 0, scancode | 0, keysym | 0, mod | 0, 0, 0, 0]);
};

Kernel.prototype.wmInjectPointer = function (sid, kind, lx, ly, opts) {
  var target = (sid | 0) || this._focusSid;
  opts = opts || {};
  if (kind === 'move') {
    return this._wmEventTo(target, [WMEV.MOUSEMOTION, 0, f32bits(lx), f32bits(ly), opts.buttons | 0, 0, 0, 0]);
  }
  // Relative motion (todos/0018): lx/ly are dx/dy deltas. Injection is
  // post-hit-test by design, so no pointer-lock state is required.
  if (kind === 'rel') {
    return this._wmEventTo(target, [WMEV.MOUSEMOTION, 0, f32bits(lx), f32bits(ly), opts.buttons | 0, 1, 0, 0]);
  }
  if (kind === 'down' || kind === 'up') {
    return this._wmEventTo(target, [kind === 'down' ? WMEV.MOUSEBUTTONDOWN : WMEV.MOUSEBUTTONUP,
      0, f32bits(lx), f32bits(ly), (opts.button | 0) || 1, 0, 0, 0]);
  }
  if (kind === 'wheel') {
    return this._wmEventTo(target, [WMEV.MOUSEWHEEL, 0, f32bits(opts.wheelX || 0),
      f32bits(opts.wheelY || 0), opts.direction | 0, 0, 0, 0]);
  }
  return false;
};

/* Screenshot one surface: a copy of its front (shm) framebuffer, at BUFFER
 * resolution — scaling (todos/0024) is a composite affordance; the app's
 * own pixels are what an agent wants here. gpu-kind surfaces have no CPU
 * pixels — the browser compositor owns readback for those (headless they
 * run shm, so tests are covered). */
Kernel.prototype.wmScreenshot = function (sid) {
  var s = this._surfaces.get(sid | 0);
  if (!s) return null;
  var front = Atomics.load(s.i32, SH_FLIP) & 1;
  var bytes = s.w * s.h * 4;
  var rgba = new Uint8Array(bytes);
  rgba.set(s.u8.subarray(SH_HDR_BYTES + front * bytes, SH_HDR_BYTES + (front + 1) * bytes));
  return { w: s.w, h: s.h, rgba: rgba };
};

/* Screenshot the screen: CPU composite of the scene in z-order — desktop
 * fill, then each surface's front buffer + its kernel chrome (solid fills;
 * text is a browser-compositor affordance, not part of the deterministic
 * composite). Row blits when unscaled; a nearest-neighbor loop maps the
 * buffer into the dst viewport when scaled (todos/0024). */
Kernel.prototype.wmScreenshotScreen = function () {
  var W = this._wmScreen.w, H = this._wmScreen.h;
  var out = new Uint8Array(W * H * 4);
  var fill = function (x0, y0, w, h, c) {
    var x1 = Math.max(0, x0), y1 = Math.max(0, y0);
    var x2 = Math.min(W, x0 + w), y2 = Math.min(H, y0 + h);
    for (var y = y1; y < y2; y++) {
      var row = (y * W + x1) * 4;
      for (var x = x1; x < x2; x++) {
        out[row] = c[0]; out[row + 1] = c[1]; out[row + 2] = c[2]; out[row + 3] = c[3];
        row += 4;
      }
    }
  };
  fill(0, 0, W, H, WM_COLORS.desktop);
  for (var i = 0; i < this._zOrder.length; i++) {
    var s = this._surfaces.get(this._zOrder[i]);
    if (!s || s.minimized) continue;
    var dw = s.dstW, dh = s.dstH;      // on-screen rect (todos/0024)
    // Chrome: resize frame under title bar + close box (borderless surfaces
    // draw bare). The frame is one outer fill; title + client cover its
    // middle — cheap, and exactly the hit-test geometry.
    if (!s.borderless) {
      fill(s.x - WM_BORDER, s.y - WM_TITLE_H - WM_BORDER,
        dw + 2 * WM_BORDER, WM_TITLE_H + dh + 2 * WM_BORDER, WM_COLORS.border);
      fill(s.x, s.y - WM_TITLE_H, dw, WM_TITLE_H,
        s.sid === this._focusSid ? WM_COLORS.titleFocused : WM_COLORS.titleBlurred);
      fill(s.x + dw - WM_CLOSE_W - WM_CLOSE_PAD, s.y - WM_TITLE_H + WM_CLOSE_PAD,
        WM_CLOSE_W, WM_CLOSE_W, WM_COLORS.closeBox);
    }
    // Client pixels: front buffer rows, clipped to the screen.
    var front = Atomics.load(s.i32, SH_FLIP) & 1;
    var base = SH_HDR_BYTES + front * s.w * s.h * 4;
    var sx0 = Math.max(0, -s.x), sy0 = Math.max(0, -s.y);
    var sx1 = Math.min(dw, W - s.x), sy1 = Math.min(dh, H - s.y);
    if (dw === s.w && dh === s.h) {
      // Unscaled: straight row blits.
      for (var sy = sy0; sy < sy1; sy++) {
        var src = base + (sy * s.w + sx0) * 4;
        var dst = ((s.y + sy) * W + (s.x + sx0)) * 4;
        out.set(s.u8.subarray(src, src + (sx1 - sx0) * 4), dst);
      }
    } else {
      // Scaled (todos/0024): nearest-neighbor — src = floor(dst * buf/dst),
      // which at an integer scale k is exact pixel replication (what pixel-
      // art wants, and what the goldens assert).
      for (var dy = sy0; dy < sy1; dy++) {
        var srow = base + Math.floor(dy * s.h / dh) * s.w * 4;
        var drow = ((s.y + dy) * W + s.x) * 4;
        for (var dx = sx0; dx < sx1; dx++) {
          var si = srow + Math.floor(dx * s.w / dw) * 4;
          var di = drow + dx * 4;
          out[di] = s.u8[si]; out[di + 1] = s.u8[si + 1];
          out[di + 2] = s.u8[si + 2]; out[di + 3] = s.u8[si + 3];
        }
      }
    }
  }
  return { w: W, h: H, rgba: out };
};

/* Set the screen resolution (re-callable — dynamic resolution, todos/0023;
 * RandR / wl_output shape: the display owner sets the mode, everyone else
 * gets an event). Subscribers get EV_SCREEN, then a one-shot position clamp
 * (the drag-clamp bounds) keeps every title bar reachable after a shrink —
 * kernel-side so the NO-WM fallback stays usable; /bin/wm re-clamps on
 * EV_SCREEN with its own (taskbar-aware) policy. Borderless surfaces are
 * skipped: no title bar to keep reachable, placement is WM policy. */
Kernel.prototype.wmSetScreen = function (w, h) {
  w = w | 0; h = h | 0;
  if (w <= 0 || h <= 0) return;
  if (w === this._wmScreen.w && h === this._wmScreen.h) return;
  this._wmScreen.w = w; this._wmScreen.h = h;
  this._wmVersion++;
  this._wmEmit(WMP.EV_SCREEN, [w, h]);
  for (var i = 0; i < this._zOrder.length; i++) {
    var s = this._surfaces.get(this._zOrder[i]);
    if (!s || s.borderless) continue;
    var nx = Math.max(40 - s.dstW, Math.min(s.x, w - 40));
    var ny = Math.max(WM_TITLE_H, Math.min(s.y, h - 8));
    if (nx === s.x && ny === s.y) continue;
    s.x = nx; s.y = ny;
    this._wmEmit(WMP.EV_MOVED, [s.sid, s.x, s.y]);
  }
};

/* Scene accessors for the browser compositor (same worker; it may hold the
 * returned surface objects and read their SABs/bitmaps directly). */
Kernel.prototype.wmScene = function () {
  var self = this;
  return {
    version: this._wmVersion,
    screen: { w: this._wmScreen.w, h: this._wmScreen.h },
    focusSid: this._focusSid,
    pointerLockWanted: this._wmPtrLockWanted,   // relative mouse (todos/0018)
    resizeDrag: this._wmResizeDrag,   // rubber-band preview (todos/0019)
    surfaces: this._zOrder.map(function (sid) { return self._surfaces.get(sid); }).filter(Boolean),
  };
};

/* ---- the WM protocol server (todos/0014; framing spec at WMP above) ----
 * wmServe() plants the kernel-owned endpoint; /bin/wm subscribes and gets
 * events + a snapshot, /bin/wmctl connects per-invocation for one command.
 * Policy stays OUT of the kernel: this server only translates frames onto
 * the same wm* methods the outside agents call — the kernel-chrome default
 * policy above keeps working with no WM connected (the crashed-WM
 * fallback), and the WM is respawnable at any time. */

function wmpTitle32(title) {
  var out = new Uint8Array(32);
  var enc = textEncoder.encode(String(title || ''));
  out.set(enc.subarray(0, Math.min(31, enc.length)));   // always NUL-terminated
  return out;
}

Kernel.prototype._wmpFrame = function (type, i32s, tail) {
  var ilen = (i32s ? i32s.length : 0) * 4;
  var tlen = tail ? tail.length : 0;
  var buf = new Uint8Array(8 + ilen + tlen);
  var dv = new DataView(buf.buffer);
  dv.setUint32(0, 4 + ilen + tlen, true);
  dv.setUint32(4, type >>> 0, true);
  for (var i = 0; i < (i32s ? i32s.length : 0); i++) dv.setInt32(8 + i * 4, i32s[i] | 0, true);
  if (tail) buf.set(tail, 8 + ilen);
  return buf;
};

/* The fixed 80-byte window record (see the WMP block comment). */
Kernel.prototype._wmpRecord = function (s) {
  var rec = new Uint8Array(WMP_REC_BYTES);
  var dv = new DataView(rec.buffer);
  var flags = (s.sid === this._focusSid ? 1 : 0) | (s.minimized ? 2 : 0) |
              (s.borderless ? 4 : 0) | (s.relativeMouse ? 8 : 0) |
              (s.resizable ? 16 : 0);
  var fields = [s.sid, s.pid, s.x, s.y, s.w, s.h,
                this._zOrder.indexOf(s.sid), flags, Atomics.load(s.i32, SH_SEQ),
                s.dstW, s.dstH, 0];
  for (var i = 0; i < fields.length; i++) dv.setInt32(i * 4, fields[i] | 0, true);
  rec.set(wmpTitle32(s.title), 48);
  return rec;
};

/* Emit an event to every subscriber. `payload` is either an i32 array or a
 * raw Uint8Array (a window record); `title` appends a 32-byte title field. */
Kernel.prototype._wmEmit = function (type, payload, title) {
  if (!this._wmSubs.size) return;
  var frame = (payload instanceof Uint8Array)
    ? this._wmpFrame(type, null, payload)
    : this._wmpFrame(type, payload, title !== undefined ? wmpTitle32(title) : null);
  this._wmSubs.forEach(function (conn) { conn.peer.send(frame); });
};

Kernel.prototype.wmServe = function (path) {
  var self = this;
  this.sockServe(path || WM_SOCK_PATH, function (peer) {
    var conn = { peer: peer, acc: [] };
    peer.onData = function (chunk) {
      for (var i = 0; i < chunk.length; i++) conn.acc.push(chunk[i]);
      for (;;) {
        if (conn.acc.length < 4) return;
        var len = (conn.acc[0] | (conn.acc[1] << 8) | (conn.acc[2] << 16) |
                   (conn.acc[3] << 24)) >>> 0;
        if (len < 4 || len > (1 << 20)) {       // corrupt stream: hang up
          self._wmSubs.delete(conn);
          peer.close();
          return;
        }
        if (conn.acc.length < 4 + len) return;
        var frame = Uint8Array.from(conn.acc.splice(0, 4 + len));
        self._wmpDispatch(conn, new DataView(frame.buffer).getUint32(4, true),
                          new DataView(frame.buffer), len - 4);
      }
    };
    peer.onClose = function () { self._wmSubs.delete(conn); };
  });
};

Kernel.prototype._wmpDispatch = function (conn, type, dv, plen) {
  var self = this;
  var g = function (i) { return (i + 1) * 4 <= plen ? dv.getInt32(8 + i * 4, true) : 0; };
  var gf = function (i) { return (i + 1) * 4 <= plen ? dv.getFloat32(8 + i * 4, true) : 0; };
  var ok = function (r) {
    conn.peer.send(r ? self._wmpFrame(WMP.R_OK, []) : self._wmpFrame(WMP.R_ERR, [22]));
  };
  switch (type) {
    case WMP.SUBSCRIBE: {
      this._wmSubs.add(conn);
      conn.peer.send(this._wmpFrame(WMP.R_OK, [this._wmScreen.w, this._wmScreen.h]));
      // The snapshot: current scene as EV_CREATED per surface (z-order,
      // bottom -> top; each record carries geometry/flags) + the focus.
      for (var i = 0; i < this._zOrder.length; i++) {
        var s = this._surfaces.get(this._zOrder[i]);
        if (s) conn.peer.send(this._wmpFrame(WMP.EV_CREATED, null, this._wmpRecord(s)));
      }
      conn.peer.send(this._wmpFrame(WMP.EV_FOCUS, [this._focusSid]));
      break;
    }
    case WMP.LIST: {
      var recs = [];
      for (var li = 0; li < this._zOrder.length; li++) {
        var ls = this._surfaces.get(this._zOrder[li]);
        if (ls) recs.push(this._wmpRecord(ls));
      }
      var payload = new Uint8Array(4 + recs.length * WMP_REC_BYTES);
      new DataView(payload.buffer).setInt32(0, recs.length, true);
      for (var ri = 0; ri < recs.length; ri++) payload.set(recs[ri], 4 + ri * WMP_REC_BYTES);
      conn.peer.send(this._wmpFrame(WMP.R_LIST, null, payload));
      break;
    }
    case WMP.MOVE: ok(this.wmMove(g(0), g(1), g(2))); break;
    case WMP.RESIZE: ok(this.wmResize(g(0), g(1), g(2))); break;
    case WMP.SET_DST: ok(this.wmSetDst(g(0), g(1), g(2))); break;
    case WMP.ACTIVATE: ok(this.wmTitleActivate(g(0))); break;
    case WMP.FOCUS: ok(this.wmFocus(g(0))); break;
    case WMP.MINIMIZE: ok(this.wmMinimize(g(0))); break;
    case WMP.RESTORE: ok(this.wmFocus(g(0))); break;    // focus restores
    case WMP.RESTACK: ok(this.wmRestack(g(0), g(1))); break;
    case WMP.CLOSE_REQ:
      ok(this._wmEventTo(g(0), [WMEV.QUIT, 0, 0, 0, 0, 0, 0, 0]));
      break;
    case WMP.INJECT_KEY:
      ok(this.wmInjectKey(g(0), g(1) !== 0, g(2), g(3), g(4)));
      break;
    case WMP.INJECT_POINTER: {
      var kind = ['move', 'down', 'up', 'wheel', 'rel'][g(1)] || '';
      var opts = kind === 'move' || kind === 'rel' ? { buttons: g(4) }
        : kind === 'wheel' ? { wheelX: gf(2), wheelY: gf(3), direction: g(4) }
        : { button: g(4) };
      ok(this.wmInjectPointer(g(0), kind, gf(2), gf(3), opts));
      break;
    }
    case WMP.SHOT: case WMP.SHOT_SCREEN: {
      var shot = type === WMP.SHOT ? this.wmScreenshot(g(0)) : this.wmScreenshotScreen();
      if (!shot) { ok(false); break; }
      var head = new Uint8Array(12 + shot.rgba.length);
      var hdv = new DataView(head.buffer);
      hdv.setInt32(0, type === WMP.SHOT ? g(0) : 0, true);
      hdv.setInt32(4, shot.w, true);
      hdv.setInt32(8, shot.h, true);
      head.set(shot.rgba, 12);
      conn.peer.send(this._wmpFrame(WMP.R_SHOT, null, head));
      break;
    }
    default: conn.peer.send(this._wmpFrame(WMP.R_ERR, [38]));   // ENOSYS
  }
};

Kernel.prototype._selectScan = function (pcb, rfds, wfds) {
  var self = this;
  var r = [], w = [];
  rfds.forEach(function (fd) {
    var id = pcb.fds.get(fd | 0);
    var o = id === undefined ? null : self._ofds.get(id);
    if (!o) { r.push(fd); return; }                     // EBADF surfaces on use
    if (o.kind === 'tty') {
      var sTty = o.tty || pcb.tty;
      if (sTty && sTty.readable()) r.push(fd);
    }
    else if (o.kind === 'ptm') {
      // Master read-ready: buffered slave output/echo, or slave-gone EOF.
      if (o.pty.out.buf.length > 0 || !o.pty.out.wOpen) r.push(fd);
    }
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
 * deferred selects with tty interest.
 *
 * Serve-time eligibility (job control): a STOPPED process's parked read
 * stays parked and consumes nothing — otherwise a Ctrl-Z'd `cat` steals
 * the shell's next typed line (found by test_jobctl_tty_e2e). And a read
 * whose pgroup lost the tty since it parked (`bg` on a stopped reader)
 * gets the same SIGTTIN/EIO treatment as the FS_READ dispatch-time check:
 * the input belongs to the foreground pgroup, not to whoever parked
 * first. */
Kernel.prototype._ttyNotify = function (tty) {
  var i = 0;
  while (i < tty.waiters.length) {
    var pid = tty.waiters[i];
    var pcb = this._procs.get(pid);
    if (!pcb || !pcb.waiter || pcb.waiter.op !== 'ttyread' ||
        pcb.waiter.tty !== tty) { tty.waiters.splice(i, 1); continue; }
    if (pcb.state === STATE_STOPPED) { i++; continue; }  // parked, not a consumer
    if (tty.fgPgid > 0 && pcb.pgid !== tty.fgPgid) {
      // Backgrounded since it parked. _cancelWaiter drops it from this
      // queue, so the loop continues at the same index.
      this._cancelWaiter(pcb);
      if (pcb.sigdisp[SIG.TTIN] === DISP_IGN ||
          (Atomics.load(pcb.i32, KP_SIGBLOCK) & (1 << (SIG.TTIN - 1)))) {
        this._respond(pcb, { errno: 'EIO' });
      } else {
        this._killPgid(pcb.pgid, SIG.TTIN);
        this._respond(pcb, { errno: 'EINTR' });
      }
      continue;
    }
    if (tty._cooked.length > 0) {
      var count = pcb.waiter.count;
      this._cancelWaiter(pcb);                           // splices index i out
      this._respondRaw(pcb, tty.take(count));
    } else if (tty._eofFlag) {
      this._cancelWaiter(pcb);
      this._respondRaw(pcb, new Uint8Array(0));
    } else {
      break;                                             // no data for anyone eligible
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

/* Resolve the tty an fd names (0020): pty slave OFDs carry their Tty,
 * masters resolve to the same Tty (termios on either end reaches the
 * pair's line discipline, like Linux); the system tty's std OFDs fall
 * through o.tty to the attached tty. Ring mode (no fd table) and fd-less
 * requests (older callers, tests) fall back to the attached tty; an fd
 * that names a non-tty resolves null (the caller answers ENOTTY). */
Kernel.prototype._ttyForFd = function (pcb, fd) {
  if (this._brokered && fd !== undefined && fd !== null) {
    var id = pcb.fds.get(fd | 0);
    var o = id === undefined ? null : this._ofds.get(id);
    if (o) {
      if (o.kind === 'ptm') return o.pty.tty;
      if (o.kind === 'tty') return o.tty || pcb.tty;
      return null;
    }
  }
  return pcb.tty;
};

/* Pty slave write (0020) — process output to the terminal. OPOST output
 * processing per the slave's termios (ONLCR: \n -> \r\n), then whole-or-
 * block into the master direction: a partial landing could split the
 * expansion, and the byte count reported to the writer must be in PRE-
 * processed bytes (PTY_OUT_CAP guarantees a whole write always fits once
 * the master drains). Master gone -> EIO, no SIGPIPE (pty semantics; the
 * fg pgroup already got SIGHUP at master close). */
Kernel.prototype._ptySlaveWrite = function (pcb, pty, data) {
  var dir = pty.out;
  if (!dir.rOpen) { this._respond(pcb, { errno: 'EIO' }); return; }
  var t = pty.tty.termios;
  var processed;
  if ((t.oflag & T_OPOST) && (t.oflag & T_ONLCR)) {
    var out = [];
    for (var i = 0; i < data.length; i++) {
      if (data[i] === 10) out.push(13);
      out.push(data[i]);
    }
    processed = Uint8Array.from(out);
  } else {
    processed = data.slice();          // copy out of the reused SAB payload
  }
  if (dir.buf.length + processed.length <= dir.cap) {
    for (var k = 0; k < processed.length; k++) dir.buf.push(processed[k]);
    this._respond(pcb, { n: data.length });
    this._pipeNotify(dir);
    return;
  }
  pcb.waiter = { op: 'pipewrite', pipe: dir, data: processed,
                 whole: true, n: data.length, ptyw: true };
  dir.writeWaiters.push(pcb.pid);
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
    // Kernel-held read end (sockServe): no PCB ever parks a read here — the
    // arriving bytes drain to the endpoint's handler instead. Draining frees
    // space, so the writeWaiters pass below still serves a blocked client.
    if (pipe.drain && pipe.buf.length) {
      pipe.drain(Uint8Array.from(pipe.buf.splice(0, pipe.buf.length)));
      progress = true;
    }
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
      var ww = wpcb.waiter;
      if (!pipe.rOpen || !pipe.wOpen) {   // !wOpen: shutdown(SHUT_WR) raced a parked write
        this._cancelWaiter(wpcb);
        if (ww.ptyw) {
          // Pty slave writer, master gone: EIO, no SIGPIPE (_ptySlaveWrite).
          this._respond(wpcb, { errno: 'EIO' });
        } else {
          this._respond(wpcb, { errno: 'EPIPE' });
          this._deliver(wpcb, SIG.PIPE);
        }
        progress = true;
        continue;
      }
      var data = ww.data;
      var free = pipe.cap - pipe.buf.length;
      if (free === 0 || (data.length <= PIPE_ATOMIC && data.length > free) ||
          (ww.whole && data.length > free)) break;
      this._cancelWaiter(wpcb);
      var n = ww.whole ? data.length : Math.min(free, data.length);
      for (var i = 0; i < n; i++) pipe.buf.push(data[i]);
      this._respond(wpcb, { n: ww.n !== undefined ? ww.n : n });
      progress = true;
    }
  }
  // Kernel-held read end: surface peer-gone EOF to the handler exactly once.
  if (pipe.drain && !pipe.wOpen && !pipe._eofSeen) {
    pipe._eofSeen = true;
    if (pipe.onEof) pipe.onEof();
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
    var i = w.tty.waiters.indexOf(pcb.pid);
    if (i >= 0) w.tty.waiters.splice(i, 1);
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
  // Reclaim WM surfaces (same discipline as fds: the kernel, not the dead
  // worker, owns the scene — SIGKILL leaves no ghost windows).
  if (pcb.surfaces.size) {
    Array.from(pcb.surfaces).forEach(function (sid) { self0._wmDestroySurface(sid); });
  }
  pcb.wmRing = null;
  pcb._wmPendingFb = null;
  // Audio streams (todos/0017): same discipline — mark dying; the pump
  // drains queued tails then reclaims (paused/no-output drop immediately).
  if (pcb.audios.size) {
    Array.from(pcb.audios).forEach(function (aid) {
      var s = self0._audioStreams.get(aid);
      if (s) self0._audioMarkDying(s);
    });
  }
  pcb.audios.clear();
  pcb._audioPendingSab = null;

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
    // reap us, or we ride out as a zombie under it. Kernel-owned services
    // (ppid 0, Kernel.service) have no parent to ever wait: auto-reap.
    if (!this._procs.get(1) || pcb.ppid === 0) this._reap(pcb);
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
/* Ptys (todos/0020): kernel pty pair -> [masterFd, slaveFd]; the terminal
 * app resizes the pair through the master (TIOCSWINSZ -> SIGWINCH). */
RemoteFS.prototype.openpty = function () {
  var r = this._ok(this._c.call(OP.PTY_CREATE, {}));
  if (r === null) return null;
  this._fdTable[r.mfd] = { type: 'remote' };
  this._fdTable[r.sfd] = { type: 'remote' };
  return [r.mfd, r.sfd];
};
RemoteFS.prototype.setWinsize = function (fd, rows, cols) {
  return this._ok(this._c.call(OP.TIOCSWINSZ, { fd: fd, rows: rows, cols: cols })) && 0;
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
  "var client = new K.KernelClient(wd.kernelPage, function (m, t) { wt.parentPort.postMessage(m, t); });",
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
  // WM surfaces (todos/WM.md) — layout constants MUST MATCH host.js.
  SH_MAGIC: SH_MAGIC, SH_W: SH_W, SH_H: SH_H, SH_FORMAT: SH_FORMAT,
  SH_FLIP: SH_FLIP, SH_SEQ: SH_SEQ,
  SH_MAGIC_VALUE: SH_MAGIC_VALUE, SH_HDR_BYTES: SH_HDR_BYTES,
  IR_WPOS: IR_WPOS, IR_RPOS: IR_RPOS, IR_CAP: IR_CAP, IR_DROPPED: IR_DROPPED,
  IR_HDR_BYTES: IR_HDR_BYTES, IR_RECORD_WORDS: IR_RECORD_WORDS,
  WMEV: WMEV,
  WM_TITLE_H: WM_TITLE_H, WM_CLOSE_W: WM_CLOSE_W, WM_CLOSE_PAD: WM_CLOSE_PAD,
  WM_BORDER: WM_BORDER, WM_GRIP: WM_GRIP, WM_MIN_SIZE: WM_MIN_SIZE,
  WM_COLORS: WM_COLORS,
  // The WM protocol (todos/0014) — MUST MATCH os/wm_proto.h.
  WMP: WMP, WMP_REC_BYTES: WMP_REC_BYTES, WM_SOCK_PATH: WM_SOCK_PATH,
  // Audio mixer (todos/0017) — ring layout MUST MATCH host.js
  // createSharedAudioBuffer; format words MUST MATCH <SDL3/SDL_audio.h>.
  AU_WPOS: AU_WPOS, AU_QUEUED: AU_QUEUED, AU_PLAYING: AU_PLAYING,
  AU_HDR_BYTES: AU_HDR_BYTES,
  AU_OUT_FREQ: AU_OUT_FREQ, AU_OUT_CHANNELS: AU_OUT_CHANNELS,
  AU_FMT_F32: AU_FMT_F32, AU_FMT_S32: AU_FMT_S32, AU_FMT_S16: AU_FMT_S16,
  AU_FMT_S8: AU_FMT_S8, AU_FMT_U8: AU_FMT_U8,
  AU_TARGET_MS: AU_TARGET_MS,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = KERNEL_EXPORTS;
} else if (typeof window !== 'undefined') {
  window.KERNEL = KERNEL_EXPORTS;
} else if (typeof self !== 'undefined') {
  self.KERNEL = KERNEL_EXPORTS;
}
