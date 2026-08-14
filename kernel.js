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
 *   [7] KP_RPC_KIND   payload encoding: RPCK_JSON | RPCK_RAW.
 *   [8..] payload     UTF-8 JSON (request, then response, in place),
 *                     up to KP_PAYLOAD_CAP — the page tail past it holds:
 *   [N-16..N-5] the vDSO block (todos/0179) — kernel-written, process-read
 *                      state PUBLISHED instead of served (KERNEL.md "What
 *                      may leave the kernel"). One seqlock word guards the
 *                      rest: the kernel (the single writer, one thread by
 *                      construction) bumps KP_VD_SEQ odd, stores the
 *                      fields, bumps it even; readers retry on odd or
 *                      changed seq (KernelClient._vdsoRead) and fall back
 *                      to the RPC — still the source of truth — after a
 *                      bounded spin. Republished at spawn, SETPGID, SETSID,
 *                      reparent-to-init, and wmSetScreen (fan-out).
 *     [N-16] KP_VD_SEQ        seqlock version (even = stable)
 *     [N-15] KP_VD_PID        own pid
 *     [N-14] KP_VD_PPID       parent pid (tracks reparenting, unlike the
 *                             spawn-time static)
 *     [N-13] KP_VD_PGID       process-group id
 *     [N-12] KP_VD_SID        session id
 *     [N-11] KP_VD_BOOT_LO    boot instant (kernel _bootMs, ms since epoch,
 *     [N-10] KP_VD_BOOT_HI    unsigned lo/hi halves) — uptime with no RPC
 *     [N-9]  KP_VD_SCREEN_W   screen dims (ctor default, then wmSetScreen)
 *     [N-8]  KP_VD_SCREEN_H
 *     [N-7..N-5] reserved (published zero)
 *   [N-4] KP_VSYNC_ARMED  vsync-waiter count (todos/0169): the process side
 *                      Atomics.add's it BEFORE parking on KP_VSYNC_SEQ and
 *                      subtracts on resolve; the compositor's park decision
 *                      re-reads it AFTER publishing KP_COMP_PARKED — the
 *                      Dekker pair that makes a lost waiter impossible.
 *   [N-3] KP_COMP_PARKED  1 = the compositor's rAF is parked, no ticks are
 *                      coming (todos/0169). The process side re-reads it
 *                      after publishing ARMED / a present's seq bump and
 *                      posts {type:'want-frame'} when set — the doorbell
 *                      that wakes the on-demand compositor.
 *   [N-2] KP_VSYNC_EN  1 = the embedder broadcasts vsync ticks (set once
 *                      at spawn from Kernel({vsync}); todos/0100).
 *   [N-1] KP_VSYNC_SEQ tick counter — vsyncTick() bumps + notifies it per
 *                      compositor frame; host.js's surface backend paces
 *                      SDL frame loops off it. No ticks (hidden tab) =
 *                      SDL apps park at their next frame boundary.
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
var KP_VSYNC_ARMED = (KP_SIZE >> 2) - 4;   // tail words (todos/0169): vsync
var KP_COMP_PARKED = (KP_SIZE >> 2) - 3;   // waiter count + compositor-parked flag
var KP_VSYNC_EN = (KP_SIZE >> 2) - 2;   // tail words (todos/0100): vsync
var KP_VSYNC_SEQ = (KP_SIZE >> 2) - 1;  // advertise flag + tick counter
// vDSO block (todos/0179): seqlock-published kernel state, see layout above.
var KP_VD_SEQ      = (KP_SIZE >> 2) - 16;
var KP_VD_PID      = (KP_SIZE >> 2) - 15;
var KP_VD_PPID     = (KP_SIZE >> 2) - 14;
var KP_VD_PGID     = (KP_SIZE >> 2) - 13;
var KP_VD_SID      = (KP_SIZE >> 2) - 12;
var KP_VD_BOOT_LO  = (KP_SIZE >> 2) - 11;
var KP_VD_BOOT_HI  = (KP_SIZE >> 2) - 10;
var KP_VD_SCREEN_W = (KP_SIZE >> 2) - 9;
var KP_VD_SCREEN_H = (KP_SIZE >> 2) - 8;
var KP_PAYLOAD_CAP = KP_SIZE - KP_PAYLOAD_OFF - 64;   // payload stops short of the
                                   // 16 tail words (vDSO block + vsync words)
/* Bulk-lane chunk sizes — DERIVED from KP_PAYLOAD_CAP, never restated
 * (todos/0235). Byte-stream RPCs move at most one payload per round trip;
 * each lane reserves framing headroom under the cap and rounds down to its
 * historical granule, so a future page-size change reaches every chunking
 * site from this one line:
 *  - KP_FS_CHUNK — RemoteFS read/write (FS_WRITE frames a 4-byte fd;
 *    granule 10000 → 60000 today). The pty ONLCR whole-or-block proof
 *    asserts against it at PTY_OUT_CAP below.
 *  - KP_HOOK_CHUNK — the host.js-owned clipboard/http staging lanes
 *    (frame headers ≤ 12 bytes; granule 16K → 49152 today). Published
 *    across the process boundary as spawnHooks().payloadChunk, so host.js
 *    never restates the kernel-page layout.
 *  - KP_DIR_PAGE — FS_OPENDIR/FS_READDIR entry pages (todos/0241). A JSON
 *    lane, so the budget bounds the MEASURED per-entry bytes (UTF-8 of
 *    each entry's JSON, +1 for the array comma); 64 bytes reserves the
 *    {"entries":[…],"more":N} reply envelope. Kernel-internal — the
 *    client just drains `more` cursors, it never needs the number. */
var KP_FS_CHUNK = Math.floor((KP_PAYLOAD_CAP - 4) / 10000) * 10000;
var KP_HOOK_CHUNK = Math.floor((KP_PAYLOAD_CAP - 16) / 16384) * 16384;
var KP_DIR_PAGE = KP_PAYLOAD_CAP - 64;
if (KP_FS_CHUNK < 4096 || KP_HOOK_CHUNK < 4096) {
  throw new Error('kernel page too small for the bulk-lane chunk derivations');
}

var RPC_IDLE = 0, RPC_REQUEST = 1, RPC_DONE = 2;
var KF_STOP = 1;                   // KP_FLAGS bit0: park at the next safe point
var RPCK_JSON = 0, RPCK_RAW = 1;   // RAW: fs read/write bulk bytes — no JSON,
                                   // no structured clone, one memcpy each way

/* Opcode space (todos/KERNEL.md): 0x00xx process, 0x01xx tty, 0x02xx pipes,
 * 0x03xx misc, 0x04xx brokered fs, 0x05xx AF_UNIX sockets, 0x06xx HTTP
 * transport (todos/0172, fetch-backed), 0x1xxx reserved for WM surfaces.
 * Only the ops the current phase implements are dispatched; the rest
 * respond ENOSYS. */
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
  GETSID: 0x000A,    // libc getsid() (todos/0043 — pgrep -s 0 wants it)
  // Interval timers (todos/0044): ONE real-time timer per process (POSIX
  // ITIMER_REAL); expiry posts SIGALRM through the ordinary SIGPEND path.
  // ms resolution over the wire; VIRTUAL/PROF answer EINVAL (no CPU
  // accounting — fail loud, documented).
  SETITIMER: 0x000B,
  GETITIMER: 0x000C,
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
  // SPSC fast-path doorbell (todos/0181): a fast end that committed a ring
  // op while the peer's PR_RWAIT/PR_WWAIT flag was up rings the kernel so
  // the parked peer (FS_WAIT / a brokered stream op) is re-served. With
  // {epipe:1} the caller hit PRF_RGONE locally and asks for its own
  // SIGPIPE (write-to-closed-pipe semantics, one RPC on the error path).
  PIPE_KICK: 0x0202,
  COMPILE: 0x0301,
  // System clipboard (todos/0090): ONE kernel-held slot {fmt, bytes} so
  // copy/paste crosses processes and survives the writer exiting (Win95
  // semantics — one slot, no history). fmt 1 = UTF-8 text; the tag exists
  // so CF_BITMAP / file lists (todos/0092) can ride the same slot later.
  // Payloads chunk through the 64KB kernel page: SET is a RAW request
  // [u32 fmt][u32 last][u32 off][bytes...] staged per-pcb and committed
  // only on last (a dying writer never leaves a torn slot); GET is JSON
  // {fmt, off, peek} -> RAW [i32 total][chunk], total -1 when empty or the
  // stored format differs. Cross-chunk reads are not snapshot-atomic by
  // design (single slot, last-write-wins; the C side retries on growth).
  // peek 1 = availability probe (__clip_has), always the cached slot; a
  // DATA read at off 0 may park on the embedder's host-clipboard refresh
  // (opts.onClipRead — the clipboard seam, see the OP.CLIP_GET dispatch).
  CLIP_SET: 0x0302,
  CLIP_GET: 0x0303,
  // Egress (todos/0398): gucOS -> host file transfer. RAW request, textual —
  // a "download\n" | "saveas\n" disposition header line ("clipboard\n" is
  // RESERVED for a future file-flavored host clipboard write), then one
  // absolute path per '\n'-terminated line (the FO_CLIP_FMT=2 list shape).
  // The wire carries PATHS; the kernel — the fs owner — materializes bytes
  // exactly once, synchronously in this dispatch (lone file -> its bytes;
  // directory or multi-selection -> ONE store-only zip, symlinks preserved
  // as symlink entries; a LONE symlink follows to its target), and hands
  // exactly one artifact {name, bytes} to opts.onEgress. Reply {} or a
  // pre-acceptance errno: EINVAL (bad header / relative path / empty list),
  // E2BIG (list over EG_REQ_MAX), ENOENT/EACCES (walk), EFBIG (lstat-summed
  // size over EGRESS_MAX, decided BEFORE any byte is read), ENOSYS (no
  // embedder hook — egress without a host is meaningless, fail loud).
  EGRESS: 0x0304,
  // 0x04xx — the brokered filesystem (KERNEL.md "fd/data-plane amendment").
  FS_OPEN: 0x0401, FS_CLOSE: 0x0402, FS_READ: 0x0403, FS_WRITE: 0x0404,
  FS_LSEEK: 0x0405, FS_STAT: 0x0406, FS_LSTAT: 0x0407, FS_FSTAT: 0x0408,
  FS_ACCESS: 0x0409, FS_UNLINK: 0x040A, FS_RENAME: 0x040B, FS_MKDIR: 0x040C,
  FS_RMDIR: 0x040D, FS_LINK: 0x040E, FS_SYMLINK: 0x040F, FS_READLINK: 0x0410,
  FS_FTRUNCATE: 0x0411, FS_CHMOD: 0x0412, FS_FCHMOD: 0x0413, FS_CHDIR: 0x0414,
  FS_GETCWD: 0x0415, FS_DUP: 0x0416, FS_DUP2: 0x0417, FS_OPENDIR: 0x0418,
  FS_REALPATH: 0x0419, FS_UTIME: 0x041A, FS_FUTIME: 0x041B, FS_ISATTY: 0x041C,
  FS_SELECT: 0x041D, FS_FCNTL_DUPFD: 0x041E, FS_FSYNC: 0x041F,
  // FS_READDIR (todos/0241): the big-directory page fetch. FS_OPENDIR
  // returns the first page of entries under KP_DIR_PAGE; when more remain
  // it parks the open backend handle behind a per-process cursor id
  // (reply `more`), and FS_READDIR {dir} drains it page by page — the
  // final page carries no `more` and closes the handle. 0x0421 because
  // FS_WAIT below predates it at 0x0420.
  FS_READDIR: 0x0421,
  // FS_WATCH (file watching): create a PATH-KEYED watch fd — one watch per
  // fd, close is removal. { path, mask, flags } -> { fd }. The fd reads
  // packed fsw_event records (os/fswatch.h MUST MATCH the FSW table below),
  // is readable in FS_SELECT/FS_WAIT like any other OFD kind, and answers
  // EAGAIN when the queue is dry (WAIT-first contract — watch fds never
  // block). Watches key on the LEXICALLY-canonical absolute path, so an
  // editor's tmp+rename-over save lands on the watched path as one
  // settled-write event and the watch SURVIVES — the inotify per-inode
  // rename-over-save trap is structurally absent. flags is reserved
  // (FSWF_RECURSIVE spec'd as a prefix compare; wired on first consumer).
  FS_WATCH_OPEN: 0x0422,
  // Unified wait (todos/0178): ONE deferred park over fds ⊕ the input ring
  // ⊕ a timeout, interruptible by signals (krpc-intr → EINTR) — the only
  // sanctioned way to sleep on multiple sources (KERNEL.md single-writer
  // rule). Readiness-check and park are atomic kernel-side, so the
  // check→park lost-wakeup class (the 0168 kick + pre-park select era)
  // is structurally impossible.
  FS_WAIT: 0x0420,
  // 0x05xx — AF_UNIX sockets (todos/0008). Stream-only; data flows through
  // FS_READ/FS_WRITE/FS_CLOSE/FS_SELECT like every other OFD kind.
  SOCK_SOCKET: 0x0501, SOCK_BIND: 0x0502, SOCK_LISTEN: 0x0503,
  SOCK_ACCEPT: 0x0504, SOCK_CONNECT: 0x0505, SOCK_PAIR: 0x0506,
  SOCK_SHUTDOWN: 0x0507,
  // 0x06xx — HTTP transport (todos/0172; fd-shaped since todos/0417).
  // Fetch-shaped, one transfer per OFD: HTTP_BODY stages an optional request
  // body (RAW [u32 off][bytes], contiguous like CLIP_SET), HTTP_OPEN (JSON
  // {method,url,headers[],headersMs,idleMs}) consumes it, kicks off the
  // embedder's fetch, and returns {fd} at once — an ORDINARY fd whose OFD
  // (kind 'http') owns the transfer, so it joins FS_SELECT/FS_WAIT, drains
  // via FS_READ (EAGAIN when dry — never parks), and dies via FS_CLOSE
  // (last release aborts the fetch). HTTP_STATUS is NON-blocking: EAGAIN
  // before headers, {status,headers} after (and it consumes the status —
  // the readability leg it satisfies re-arms only on body progress). Two
  // kernel deadlines bound every transfer (headers + idle; expiry =
  // ETIMEDOUT on the error leg). Not a socket layer (the browser can't
  // do raw TCP); TLS is the fetch stack's. Semantics: todos/0172 +
  // todos/0417 + the "HTTP transport" section in KERNEL.md.
  // 0x0604 (HTTP_READ) and 0x0605 (HTTP_CLOSE) are RETIRED by 0417 —
  // FS_READ/FS_CLOSE serve their roles; the opcodes are never reused.
  // HTTP_ERROR (#392) is the error-TEXT peek: {fd} -> {error, errno} — the
  // transfer's recorded failure text ('' while healthy), never consuming,
  // callable in any state while the fd lives. The C surface only saw errno
  // before this; the precise transport diagnostic (a CORS denial, a dead
  // bridge, a bad URL) died in a host-side console.error.
  HTTP_BODY: 0x0601, HTTP_OPEN: 0x0602, HTTP_STATUS: 0x0603,
  HTTP_ERROR: 0x0606,
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
  // borderless, bit1 relative-mouse, bit2 resizable, bit3 has-alpha —
  // todos/0063: per-pixel alpha, composited src-over in both composites; bit4
  // transient/owned — todos/0281, create-only, not settable here);
  // the relative-mouse bit round-trips to the UI bridge as a pointer-lock
  // request
  // (onPointerLock). The resizable bit (todos/0021, SDL3 semantics: only
  // SDL_WINDOW_RESIZABLE windows may be resized) gates every resize path
  // — wmResize, WMP RESIZE. Frame drag zones exist on BOTH kinds since
  // todos/0024, but dispatch on the bit: resizable -> configure the client;
  // fixed-size -> scale its dst rect (wmSetDst; the app never knows).
  // SURFACE_RESIZE (todos/0068) is the OWNER-initiated resize (Win32 apps
  // size their window to content — winmine per difficulty): same
  // pendingConfigure + WINDOW_RESIZED flow as wmResize, but NOT gated on
  // the resizable bit — that bit protects fixed-size apps from the WM
  // shearing them, not from their own geometry choices. The ack is the
  // same SURFACE_CONFIGURE; a scaled (SET_DST) surface that self-resizes
  // snaps back to dst == buffer there, like any configure.
  SURFACE_CREATE: 0x1001, SURFACE_DESTROY: 0x1002, SURFACE_SET_TITLE: 0x1003,
  SURFACE_CONFIGURE: 0x1005, SURFACE_SET_FLAGS: 0x1006, SURFACE_RESIZE: 0x1007,
  // SURFACE_SET_CURSOR (todos/0105): the per-surface client cursor shape (an
  // SDL_SystemCursor value; -1 = hidden). The kernel overlays chrome cursors
  // (resize edges) over it on hit test and posts the effective cursor to the
  // UI bridge on every change (onCursor) — the pointer-lock wanted-state
  // pattern, but for the native CSS cursor.
  SURFACE_SET_CURSOR: 0x1008,
  // 0x2xxx — the audio mixer (todos/0017; design: WM.md "Audio mixing").
  // Control plane only: PCM rides the per-process source ring SABs and the
  // one page-owned output ring — never RPCs. AUDIO_GAIN (todos/0048, the
  // control panel's volume): master output gain in percent, 0..200;
  // gain < 0 queries. Applied in audioPump before the clamp.
  AUDIO_OPEN: 0x2001, AUDIO_CLOSE: 0x2002, AUDIO_GAIN: 0x2003,
};

/* strace (todos/0046): the decode table IS the OP table — opcode names come
 * from the constants above, so a new opcode traces by construction. */
var OP_NAMES = {};
for (var opName in OP) OP_NAMES[OP[opName]] = opName;

/* FS_WATCH event vocabulary — MUST MATCH os/fswatch.h. The record stream a
 * watch fd reads is packed little-endian:
 *   [u16 len][u8 type][u8 flags][name... NUL, padded so len % 4 == 0]
 * `name` is the watch-relative child name for dir-watch events (RENAME:
 * "old\0new\0" — ONE record, both names, no inotify cookie protocol),
 * empty for self events. FSW_MODIFY (every write/ftruncate — mid-write
 * chatter) is OPT-IN: the default mask is the settled set, inverting
 * inotify's trap where IN_MODIFY is the obvious-looking wrong choice.
 * FSW_CLOSE_WRITE is the settled write: a dirty open-file-description's
 * LAST release, or a rename landing complete content at the path. */
var FSW_CLOSE_WRITE = 1;   // content at the path is complete — safe to react
var FSW_CREATE = 2;        // entry appeared (create/mkdir/symlink/link/move-in of a dir)
var FSW_DELETE = 3;        // entry disappeared (unlink/rmdir/move-out)
var FSW_RENAME = 4;        // same-dir rename under a dir watch (both names)
var FSW_SELF_GONE = 5;     // the watched path itself unlinked/renamed away (watch stays armed)
var FSW_MODIFY = 6;        // each write/ftruncate — opt-in
var FSW_OVERFLOW = 7;      // queue overflowed: the consumer must rescan
var FSWF_ISDIR = 1;        // record flag: the subject is a directory
var FSW_MASK_DEFAULT =     // everything except MODIFY (the settled set)
  (1 << FSW_CLOSE_WRITE) | (1 << FSW_CREATE) | (1 << FSW_DELETE) |
  (1 << FSW_RENAME) | (1 << FSW_SELF_GONE) | (1 << FSW_OVERFLOW);
var FSW_QUEUE_CAP = 128;   // per-watch-fd bound; overflow = clear + latch

/* Wait options / status packing — must match <sys/wait.h>. */
var WNOHANG = 0x01, WUNTRACED = 0x02, WCONTINUED = 0x08;

/* Interval timers (todos/0044) — must match <sys/time.h>. Only the
 * real-time flavor exists (workers run on their own OS threads, so there
 * is no per-process CPU accounting to back VIRTUAL/PROF). */
var ITIMER_REAL = 0;
function W_EXITCODE(code) { return (code & 0xff) << 8; }
function W_TERMSIG(sig) { return sig & 0x7f; }
function W_STOPCODE(sig) { return ((sig & 0xff) << 8) | 0x7f; }
var W_CONTINUED_STATUS = 0xffff;

/* Pipes (todos/0003): kernel-side buffers — rendezvous, not bulk data.
 * PIPE_ATOMIC mirrors POSIX PIPE_BUF (writes that small never interleave:
 * they defer whole rather than land partially). */
var PIPE_CAP = 64 * 1024;
var PIPE_ATOMIC = 512;

/* ---- SPSC pipe rings (todos/0181; KERNEL.md "single-writer rule") ----
 * A pipe whose creator posted a ring SAB ({type:'pipe-sab'}, the audio-sab
 * handshake) keeps its bytes in that ring IN EVERY MODE — the kernel's own
 * stream ops read/write the ring through the _pipeAvail/_pipeTake/_pipePut
 * accessors, so promotion and demotion move no data and need no locks (a
 * demotion-time ring→buf drain would race a mid-flight fast reader).
 *
 * Header words (32-byte header, data area after; every word has ONE writer):
 *   PR_MODE   kernel-owned   the one-way ladder LATENT → FAST → DEMOTED.
 *                            FAST = both ends single-holder: the holders
 *                            memcpy + Atomics locally, zero data RPCs.
 *   PR_HEAD   consumer-owned free-running u32 byte index (reader end).
 *   PR_TAIL   producer-owned free-running u32 byte index (writer end).
 *   PR_FLAGS  kernel-owned   PRF_RGONE/PRF_WGONE — close/exit are always
 *                            brokered, so the kernel latches peer-gone here
 *                            and the fast peer discovers EOF/EPIPE locally.
 *   PR_RWAIT/ kernel-owned   "a waiter is parked interested in this end"
 *   PR_WWAIT                 (any mode; set BEFORE the park's readiness
 *                            rescan, cleared by _cancelWaiter). A fast peer
 *                            that commits while the flag is up sends
 *                            PIPE_KICK — the suppressed-doorbell protocol:
 *                            flag-then-rescan vs commit-then-check-flag
 *                            cross under SC atomics, so a wake can be
 *                            redundant but never lost (the 0168 lesson).
 *
 * Mode moves only while every process that could fast-op the flipped role
 * is parked in the very RPC doing the flip: promotion fires on a holder
 * REMOVAL (the closer/exiter is parked; not at create — the creator's
 * spawns would demote a promoted pipe and burn the one-way ladder, so
 * same-process self-pipes deliberately stay brokered), demotion fires on
 * spawn inheritance (the only event that adds a holder; the spawner is
 * parked). A straggler fast op that loaded FAST just before a demotion
 * commits harmlessly: its role's end stayed single-holder, so the kernel
 * only exercises that role while the same process is parked in an RPC —
 * at most one producer and one consumer touch the ring at any instant. */
var PIPE_RING_HDR = 32;
var PR_MODE = 0, PR_HEAD = 1, PR_TAIL = 2, PR_FLAGS = 3, PR_RWAIT = 4, PR_WWAIT = 5;
var PR_LATENT = 0, PR_FAST = 1, PR_DEMOTED = 2;
var PRF_RGONE = 1, PRF_WGONE = 2;
// A ringed pipe's capacity IS its ring (pipe.cap follows the SAB the
// creator allocated): 256K, 4× the brokered PIPE_CAP — every park/kick
// cycle moves a whole ring, so a bigger elastic buffer means fewer wake
// RPCs per MB. POSIX only mandates PIPE_BUF (512) atomicity, not a size.
var PIPE_RING_BYTES = PIPE_RING_HDR + 256 * 1024;

function pipeRingViews(sab) {
  return { sab: sab, i32: new Int32Array(sab, 0, PIPE_RING_HDR >> 2),
           u8: new Uint8Array(sab, PIPE_RING_HDR),
           cap: sab.byteLength - PIPE_RING_HDR };
}
function pipeRingAvail(ring) {
  return (Atomics.load(ring.i32, PR_TAIL) - Atomics.load(ring.i32, PR_HEAD)) >>> 0;
}
/* Producer side: copy `bytes` in at TAIL (caller checked the space) and
 * commit. Free-running indices; the data area wraps. */
function pipeRingPut(ring, bytes) {
  var tail = Atomics.load(ring.i32, PR_TAIL) >>> 0;
  var off = tail % ring.cap;
  var first = Math.min(bytes.length, ring.cap - off);
  ring.u8.set(bytes.subarray(0, first), off);
  if (first < bytes.length) ring.u8.set(bytes.subarray(first), 0);
  Atomics.store(ring.i32, PR_TAIL, (tail + bytes.length) | 0);
}
/* Consumer side: copy `n` bytes out from HEAD into `dst` (caller checked
 * avail; dst.length >= n) and commit. */
function pipeRingTakeInto(ring, dst, n) {
  var head = Atomics.load(ring.i32, PR_HEAD) >>> 0;
  var off = head % ring.cap;
  var first = Math.min(n, ring.cap - off);
  dst.set(ring.u8.subarray(off, off + first), 0);
  if (first < n) dst.set(ring.u8.subarray(0, n - first), first);
  Atomics.store(ring.i32, PR_HEAD, (head + n) | 0);
}
function pipeRingTake(ring, n) {
  var out = new Uint8Array(n);
  pipeRingTakeInto(ring, out, n);
  return out;
}

/* HTTP transport (todos/0172): per-transfer body backpressure threshold.
 * The async fetch reader pauses once this many bytes are queued and resumes
 * when an FS_READ drains below it — bounded kernel memory regardless of how
 * fast the network delivers vs how slowly the C consumer reads. */
var HTTP_BUF_CAP = 256 * 1024;

/* HTTP deadlines (todos/0417): kernel DEFAULTS, so a caller that sets
 * nothing is still bounded. HTTP_OPEN overrides per transfer: headersMs > 0
 * replaces the headers deadline (the response headers must arrive within
 * it); idleMs > 0 replaces the idle deadline (the body must deliver at
 * least one byte within it, measured only while the kernel is actually
 * waiting on the network — a backpressure pause stops the clock), and
 * idleMs < 0 DISABLES it (a server-sent-event stream is legitimately
 * silent for long stretches). The headers deadline is never disableable.
 * Expiry aborts the fetch and fails the transfer with ETIMEDOUT — a
 * distinguishable error, and a consumable: the fd reports readable and
 * the reader collects it. */
var HTTP_HEADERS_MS = 30 * 1000;
var HTTP_IDLE_MS = 120 * 1000;

/* ---- strace formatting (todos/0046) ----
 * Pure text: one strace-flavored line per RPC — NAME(k=v, ...) = result.
 * Strings/arrays/previews are capped so a traced `cat` of a big file stays
 * readable and the trace pipe stays small; the caps are presentation only
 * (nothing round-trips through these). */
var TRACE_STR_MAX = 64;    // per-string cap in request args
var TRACE_DATA_MAX = 32;   // read/write data preview cap (strace's -s default)
var TRACE_ARR_MAX = 8;     // per-array element cap (argv/envp)

function traceQuoteByte(c) {
  if (c === 34) return '\\"';
  if (c === 92) return '\\\\';
  if (c === 10) return '\\n';
  if (c === 9) return '\\t';
  if (c === 13) return '\\r';
  if (c < 32 || c > 126) return '\\x' + (c | 256).toString(16).slice(-2);
  return String.fromCharCode(c);
}

function traceStr(s, max) {
  var body = '';
  var n = Math.min(s.length, max);
  // ASCII-only fallback by design: non-ASCII units render as \xNN escapes
  // (strace output is a diagnostic byte dump, not a text surface).
  for (var i = 0; i < n; i++) body += traceQuoteByte(s.charCodeAt(i) & 0xff);
  return '"' + body + '"' + (s.length > max ? '...' : '');
}

function traceBytes(u8, max) {
  var body = '';
  var n = Math.min(u8.length, max);
  for (var i = 0; i < n; i++) body += traceQuoteByte(u8[i]);
  return '"' + body + '"' + (u8.length > max ? '...' : '');
}

function traceVal(v, depth) {
  if (v === null || v === undefined) return 'NULL';
  var t = typeof v;
  if (t === 'number' || t === 'boolean') return '' + v;
  if (t === 'string') return traceStr(v, TRACE_STR_MAX);
  if (v instanceof Uint8Array) return '<' + v.length + ' bytes>';
  if (Array.isArray(v)) {
    if (depth <= 0) return '[...]';
    var parts = [];
    for (var i = 0; i < v.length && i < TRACE_ARR_MAX; i++) parts.push(traceVal(v[i], depth - 1));
    if (v.length > TRACE_ARR_MAX) parts.push('...+' + (v.length - TRACE_ARR_MAX));
    return '[' + parts.join(', ') + ']';
  }
  if (t === 'object') {
    if (depth <= 0) return '{...}';
    var ps = [];
    for (var k in v) ps.push(k + '=' + traceVal(v[k], depth - 1));
    return '{' + ps.join(', ') + '}';
  }
  return '?';
}

/* Request args, formatted EAGERLY at dispatch (a RAW payload is a view into
 * the kernel page — the response reuses that region, so nothing may hold it
 * past the dispatch turn). */
function traceArgs(op, req) {
  if (req && req.raw) {
    // RAW-request ops: FS_WRITE [u32 fd][bytes...], CLIP_SET (todos/0090)
    // [u32 fmt][u32 last][u32 off][bytes...].
    var raw = req.raw;
    if (op === OP.CLIP_SET && raw.length >= 12) {
      var cdv = new DataView(raw.buffer, raw.byteOffset, raw.length);
      return 'fmt=' + cdv.getUint32(0, true) + ', last=' + cdv.getUint32(4, true) +
        ', off=' + cdv.getUint32(8, true) +
        ', data=' + traceBytes(raw.subarray(12), TRACE_DATA_MAX) +
        ', count=' + (raw.length - 12);
    }
    if (op === OP.FS_WRITE && raw.length >= 4) {
      var fd = raw[0] | (raw[1] << 8) | (raw[2] << 16) | (raw[3] << 24);
      var data = raw.subarray(4);
      return 'fd=' + fd + ', data=' + traceBytes(data, TRACE_DATA_MAX) +
        ', count=' + data.length;
    }
    return 'raw=<' + raw.length + ' bytes>';
  }
  if (!req || typeof req !== 'object') return '';
  var parts = [];
  for (var k in req) parts.push(k + '=' + traceVal(req[k], 2));
  return parts.join(', ');
}

function traceResult(resp, rawBytes) {
  if (rawBytes) {
    return '' + rawBytes.length +
      (rawBytes.length ? ' ' + traceBytes(rawBytes, TRACE_DATA_MAX) : '');
  }
  if (resp && resp.errno) return '-1 ' + resp.errno;
  if (!resp) return '0';
  var keys = Object.keys(resp);
  if (keys.length === 0) return '0';
  if (keys.length === 1 && typeof resp[keys[0]] === 'number') return '' + resp[keys[0]];
  return traceVal(resp, 2);
}

/* Ptys (todos/0020): the slave→master output direction. Sized so a whole
 * worst-case slave write always fits EVENTUALLY: RemoteFS caps writes at
 * KP_FS_CHUNK bytes and OPOST/ONLCR at most doubles them, so the
 * whole-or-block discipline (a \r\n must never split across a full buffer)
 * can always be satisfied by a draining master. The proof is enforced, not
 * prose (todos/0235): a page-layout change that grows KP_FS_CHUNK past the
 * margin fails loud at load instead of silently rotting the discipline. */
var PTY_OUT_CAP = 256 * 1024;
if (KP_FS_CHUNK * 2 > PTY_OUT_CAP) {
  throw new Error('PTY_OUT_CAP must hold one ONLCR-doubled RemoteFS write chunk (2*KP_FS_CHUNK)');
}

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
 *     type 0 = kernel kick (all-zero record): socket-data wake pushed by
 *     _wmKick so the WPOS futex word changes (a bare notify can be lost);
 *     host.js drainInput counts-and-skips it, no SDL event surfaces.
 *     key:    [2] scancode [3] keysym [4] mod [5] repeat
 *     motion: [2] x(f32 bits) [3] y(f32 bits) [4] button state mask
 *             [5] relative flag (todos/0018): 1 = [2]/[3] are dx/dy deltas
 *             (pointer-lock motion / injected rel), not positions
 *     button: [2] x(f32 bits) [3] y(f32 bits) [4] button index
 *     wheel:  [2] x(f32 bits) [3] y(f32 bits) [4] direction
 *   The kernel rings the process doorbell after each write, so
 *   SDL_WaitEvent-style parks wake like every other blocking op; it also
 *   Atomics.notifies IR_WPOS itself so a host parked on the ring (host.js
 *   __sdl_pump_wait — user32's blocking GetMessage, todos/0058) wakes
 *   without polling.
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
 * SURFACE_CONFIGURE RPC once it has a frame at the new size.
 * FOCUS_GAINED/FOCUS_LOST are the owner focus pair (todos/0256, menu arch
 * A9): every kernel focus TRANSITION emits LOST to the old owner and GAINED
 * to the new one — by construction, since all _focusSid writes flow through
 * the ONE _wmSetFocus choke point. */
var WMEV = { QUIT: 0x100, WINDOW_RESIZED: 0x206,
             FOCUS_GAINED: 0x20E, FOCUS_LOST: 0x20F,
             KEYDOWN: 0x300, KEYUP: 0x301,
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

/* ONE published copy of the shared-SAB layout contract (the CD26 tripwire,
 * todos/0235's payloadChunk shape): host.js declares these same offsets
 * independently (WMSH_* / WMIR_* / WMEV_* / WMAU_* — it is a standalone
 * module that CANNOT import kernel.js), and drift between the two copies
 * corrupts presents/screenshots/input/audio SILENTLY — no error, just
 * wrong pixels. So the kernel publishes its declaration on the spawnHooks
 * seam (wmSabLayout) and host.js cross-checks EVERY field — both key sets,
 * exact values — at surface-backend setup (assertWmSabLayout there), which
 * runs for every kernel-attached process from pid 1 on: a one-sided edit
 * fails the boot loud. Adding a header field on one side only trips the
 * check until the other side matches — extend BOTH declarations AND this
 * table together. */
var WM_SAB_LAYOUT = {
  shMagic: SH_MAGIC, shW: SH_W, shH: SH_H, shFormat: SH_FORMAT,
  shFlip: SH_FLIP, shSeq: SH_SEQ,
  shMagicValue: SH_MAGIC_VALUE, shHdrBytes: SH_HDR_BYTES,
  irWpos: IR_WPOS, irRpos: IR_RPOS, irCap: IR_CAP, irDropped: IR_DROPPED,
  irHdrBytes: IR_HDR_BYTES, irRecordWords: IR_RECORD_WORDS,
  auWpos: AU_WPOS, auQueued: AU_QUEUED, auPlaying: AU_PLAYING,
  auHdrBytes: AU_HDR_BYTES,
  ev: WMEV,
};

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
 * todos/0024 — equals w/h unless scaled), layer (todos/0038: -1 bottom /
 * 0 normal / +1 top; was reserved), then 32 bytes NUL-padded UTF-8 title.
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
 *   CLOSE_REQ { sid }            -> R_OK | R_ERR   (SDL_EVENT_QUIT to owner;
 *                                   arms the #486 hung-app watchdog — an
 *                                   owner that never consumes the request
 *                                   is force-quit after the grace period)
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
 *   CYCLE { direction }          -> R_OK | R_ERR   (todos/0032: fire the
 *                                   window-cycling gesture — the wmctl-cycle
 *                                   path into the SAME EV_CYCLE the Alt+Tab
 *                                   chord emits; R_ERR with no subscriber,
 *                                   since cycling IS policy)
 *   MENU { }                     -> R_OK | R_ERR   (todos/0078: fire the
 *                                   Start-menu gesture — the wmctl-menu
 *                                   path into the SAME EV_MENU the Ctrl+Esc
 *                                   chord emits; R_ERR with no subscriber,
 *                                   since the menu IS policy)
 *   SNAP { direction }           -> R_OK | R_ERR   (todos/0095: fire the
 *                                   Aero Snap gesture — the wmctl-snap path
 *                                   into the SAME EV_SNAP_KEY the Win+arrow
 *                                   chord emits; direction 0 left / 1 right
 *                                   / 2 up / 3 down; R_ERR with no
 *                                   subscriber, since snap IS policy)
 *   GET_IDLE { }                 -> R_IDLE { ms }  (todos/0096: ms since
 *                                   the last real input — wmKey/wmPointer,
 *                                   INJECT_SCREEN/INJECT_WMKEY included,
 *                                   per-window injection excluded. Its own reply type
 *                                   so a subscriber's fire-and-forget drain
 *                                   can route it, the R_SHOT precedent; the
 *                                   screensaver policy in /bin/wm polls it)
 *   SAVER { }                    -> R_OK | R_ERR   (todos/0096: fire the
 *                                   screensaver gesture — wmctl saver / the
 *                                   Control Panel Preview — as EV_SAVER;
 *                                   R_ERR with no subscriber, since the
 *                                   saver IS policy)
 *   SET_LAYER { sid, layer }     -> R_OK | R_ERR   (todos/0038: pin the
 *                                   surface to a z LAYER — -1 below normal
 *                                   windows (the desktop layer), 0 normal,
 *                                   +1 above (the taskbar). Every z-order op
 *                                   keeps layers separated, so create/raise/
 *                                   focus/lower can never cross a boundary;
 *                                   no event — the record carries the layer)
 *   INJECT_KEY { sid, down, scancode, keysym, mod }        -> R_OK | R_ERR
 *   INJECT_POINTER { sid, kind, xf32, yf32, a, b }         -> R_OK | R_ERR
 *     kind: 0 move (a=buttons) | 1 down | 2 up (a=button) | 3 wheel
 *     (xf32/yf32 = wheelX/wheelY, a=direction) | 4 rel (todos/0018:
 *     xf32/yf32 = dx/dy deltas, a=buttons); sid 0 = focused window
 *   INJECT_SCREEN { kind, xf32, yf32, a }                  -> R_OK | R_ERR
 *     (todos/0095) SCREEN-coordinate injection into wmPointer — the full
 *     hit-test/chrome path a real mouse takes, so headless tests can drive
 *     title drags, edge snap, border resizes; kind: 0 move (a=buttons) |
 *     1 down | 2 up (a=button)
 *   INJECT_WMKEY { down, scancode, keysym, mod, repeat }   -> R_OK
 *     (#423) keyboard injection into wmKey — the grab-table/overview/focus
 *     routing a real keyboard takes (the INJECT_SCREEN keyboard analogue),
 *     so headless tests can drive chords (Alt+Tab, Ctrl+Esc, Win+arrow,
 *     user grabs) that per-window INJECT_KEY bypasses by design. wmKey
 *     always reports what happened via events/delivery, so this never
 *     fails; R_OK doubles as the sequencing barrier (the 0x22 rule)
 *   SHOT { sid } / SHOT_SCREEN {} -> R_SHOT { sid, w, h, w*h*4 rgba } | R_ERR
 *   THUMB { sid, maxW, maxH }    -> R_SHOT { sid, w, h, rgba } | R_ERR
 *                                   (todos/0063 Aero Peek: the front buffer
 *                                   box-filtered down to fit maxW x maxH,
 *                                   aspect preserved, never upscaled —
 *                                   deterministic, CPU pixels only)
 *   GLASS { on }                 -> R_OK   (todos/0063: toggle the Aero
 *                                   glass tier — browser-compositor-only
 *                                   chrome backdrop blur; headless
 *                                   composite ignores it by design)
 * R_ERR payload: one i32 errno naming the REAL cause (arch CS7, todos/0242;
 * v1 sent 22 for everything). The values come from WMP_ERRNO below —
 * EINVAL 22 bad/unknown sid or out-of-range args; EPERM 1 the surface's
 * declared mode forbids the op (RESIZE on a non-resizable surface, SET_DST
 * on a resizable one, ACTIVATE on borderless); ENODEV 19 the op needs a
 * subscribed WM and none is; ESRCH 3 the target surface's process is gone;
 * EAGAIN 11 the target's event ring is full (delivery would drop);
 * ENOSYS 38 unknown op. Additive: legacy callers that treat any R_ERR as
 * failure keep working; wm_proto.h's wmp_cmd surfaces the value in errno.
 *
 * Map-on-placement (todos/0069): while a subscriber exists, a new surface
 * is composited and hit-tested only after the WM's first geometry/stacking
 * op on it (MOVE/RESIZE/SET_DST/SET_LAYER/RESTACK — wm.c answers every
 * EV_CREATED with a MOVE, which doubles as the map ack), so windows never
 * flash at the kernel cascade default. Borderless surfaces NOT owned by a
 * subscriber process map at create (wm.c ignores them — owner-positioned
 * taskbar-class); a WM_MAP_TIMEOUT_MS backstop and last-subscriber-gone
 * both map everything pending, so a wedged or dead WM can't hide windows.
 * No subscriber -> mapped at create (the pre-0069 no-WM behavior, exactly).
 *
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
 * the saved geometry) | EV_CYCLE { direction } (todos/0032: the cycling
 * chord — Tab with Alt held, Shift reversing — or a CYCLE command; only
 * emitted with a subscriber, else the chord is not recognized and the key
 * passes through to the focused app; policy walks focus and sends FOCUS) |
 * EV_MENU { } (todos/0078: the Start chord — Esc with Ctrl held — or a
 * MENU command; the same no-subscriber pass-through rule; policy toggles
 * the Start menu) | EV_SNAP_EDGE { sid, edge } (todos/0095: mid-title-drag
 * the pointer entered (edge > 0) or left (edge 0) a screen-edge snap zone
 * — policy shows/hides the translucent preview; edges: 1 left, 2 right,
 * 3 top, 4 TL, 5 TR, 6 BL, 7 BR; only emitted with a subscriber) |
 * EV_SNAP_DROP { sid, edge, x0, y0 } (todos/0095: a title drag that MOVED
 * — past WM_SNAP_SLOP; a motionless click emits nothing — was released;
 * edge is the zone it dropped in, 0 for a plain drop; x0/y0 is the PRE-drag
 * position so policy can save the true floating rect on a snap commit;
 * policy commits the snap geometry, or restores a snapped window's floating
 * size on a drag-off; emitted after the drag-end EV_MOVED, only with a
 * subscriber) |
 * EV_SNAP_KEY { direction } (todos/0095: the Win+arrow chord — arrows with
 * GUI held — or a SNAP command; 0 left / 1 right / 2 up / 3 down; the same
 * no-subscriber pass-through rule as EV_CYCLE; policy snaps the focused
 * window to halves, maximizes, restores/minimizes) |
 * EV_SAVER { } (todos/0096: a SAVER command — wmctl saver or the Control
 * Panel Preview button; policy raises the configured screensaver at once;
 * only emitted with a subscriber. Idle-triggered raising needs no event:
 * policy polls GET_IDLE and acts on its own timeout).
 *
 * MUST MATCH the C client header (os/wm_proto.h) and the scripted client
 * in tests/kernel/test_wm_policy.js. */
var WMP = {
  SUBSCRIBE: 0x01, LIST: 0x02,
  MOVE: 0x10, FOCUS: 0x11, MINIMIZE: 0x12, RESTORE: 0x13, RESTACK: 0x14,
  CLOSE_REQ: 0x15, RESIZE: 0x16, SET_DST: 0x17, ACTIVATE: 0x18,
  CYCLE: 0x19,                       /* { direction }: fire the window-cycling
                                        gesture (todos/0032) — the wmctl-cycle
                                        path into the same EV_CYCLE the kernel
                                        chord emits. R_ERR with no subscribed
                                        WM (cycling IS policy) */
  SET_LAYER: 0x1A,                   /* { sid, layer }: pin a surface to a z
                                        layer (todos/0038) — -1 bottom (the
                                        desktop layer), 0 normal, +1 top (the
                                        taskbar); z ops never cross layers */
  GLASS: 0x1B,                       /* { on }: toggle the Aero glass tier
                                        (todos/0063) — browser-compositor-only
                                        backdrop blur behind window chrome.
                                        The headless composite NEVER reads it
                                        (deterministic goldens); default off */
  MENU: 0x1C,                        /* { }: fire the Start-menu gesture
                                        (todos/0078) — the wmctl-menu path
                                        into the same EV_MENU the Ctrl+Esc
                                        chord emits. R_ERR with no subscribed
                                        WM (the menu IS policy) */
  SNAP: 0x1D,                        /* { direction }: fire the Aero Snap
                                        gesture (todos/0095) — the wmctl-snap
                                        path into the same EV_SNAP_KEY the
                                        Win+arrow chord emits. R_ERR with no
                                        subscribed WM (snap IS policy) */
  GET_IDLE: 0x1E,                    /* { }: ms since the last real input
                                        (todos/0096) -> R_IDLE { ms }. The
                                        kernel is the only one who sees ALL
                                        input; the screensaver policy in
                                        /bin/wm polls this */
  SAVER: 0x1F,                       /* { }: fire the screensaver gesture
                                        (todos/0096) — the wmctl-saver /
                                        ctlpanel-Preview path into EV_SAVER;
                                        policy raises the saver at once.
                                        R_ERR with no subscribed WM (the
                                        saver IS policy) */
  INJECT_KEY: 0x20, INJECT_POINTER: 0x21,
  INJECT_SCREEN: 0x22,               /* { kind, xf32, yf32, a }: screen-coord
                                        pointer injection through the full
                                        wmPointer hit-test/chrome path
                                        (todos/0095) — headless title drags,
                                        edge snap, border resizes */
  INJECT_WMKEY: 0x23,                /* { down, scancode, keysym, mod,
                                        repeat }: keyboard injection through
                                        the raw wmKey entry — grab table
                                        (chords), overview swallow, focus
                                        routing (#423, the INJECT_SCREEN
                                        keyboard analogue) */
  SHOT: 0x30, SHOT_SCREEN: 0x31,
  THUMB: 0x32,                       /* { sid, maxW, maxH }: downscaled
                                        front-buffer thumbnail (todos/0063,
                                        Aero Peek) -> R_SHOT { sid, w, h,
                                        rgba } aspect-fit inside maxW x maxH
                                        (never upscaled). Deterministic box
                                        filter — CPU pixels, so gpu-transport
                                        surfaces thumb black like wmScreenshot */
  SYSMENU: 0x33,                     /* { }: fire the window system-menu
                                        gesture (todos/0102) — the wmctl-sysmenu
                                        path into the same EV_SYSMENU the
                                        Alt+Space chord emits (carries the
                                        focused sid). R_ERR with no subscribed
                                        WM (the menu IS policy) */
  CURSOR_AT: 0x34,                   /* { xf32, yf32 }: the effective cursor
                                        shape at a SCREEN point (todos/0105) ->
                                        R_CURSOR { shape } (SDL_SystemCursor;
                                        -1 hidden). Pure query — the chrome
                                        overlay + per-surface client cursor,
                                        side-effect-free (mechanism, assertable
                                        headless; browser draws it) */
  GRAB_SET: 0x35,                    /* { n, n x (scancode, km, token) }:
                                        REPLACE the whole kernel key-grab table
                                        (todos/KEYBINDING-OVERRIDE-SYSTEM.md §3,
                                        the X11-passive-grab shape). Idempotent;
                                        n = 0 installs an EMPTY table (a WM that
                                        wants NO chord interception — a policy
                                        choice the mechanism must allow); n
                                        capped at WM_GRAB_MAX (R_ERR beyond).
                                        Subscriber-only (R_ERR otherwise). Until
                                        a WM sends this, the kernel uses a
                                        built-in default table reproducing the
                                        legacy cycle/menu/snap/sysmenu chords;
                                        last-subscriber-gone resets to it. km is
                                        the canonical KM_* mask (Shift excluded
                                        unless the entry names it) */
  // Window overview / Exposé (todos/EXPOSE-MISSION-CONTROL.md). The design doc
  // drafted these at 0x35/0x92 as the then-next-free slots; the keybind grab
  // chunk took 0x35 (GRAB_SET) / 0x92 (EV_HOTKEY) first, so these use the
  // ACTUAL next-free slots. MUST MATCH wm_proto.h.
  OVERVIEW_SET: 0x36,                /* { n, n x (sid, x, y, w, h) }: enter/
                                        relayout the overview with these
                                        miniature rects; subscriber-only,
                                        validates sids, stores, bumps */
  OVERVIEW_END: 0x37,                /* { }: leave the overview; subscriber-only.
                                        Pure presentation clear */
  OVERVIEW: 0x38,                    /* { }: command gesture (the CYCLE/MENU
                                        pattern) — fire EV_OVERVIEW; R_ERR with
                                        no WM. Serves `wmctl overview` */
  R_OK: 0x40, R_ERR: 0x41, R_LIST: 0x42, R_SHOT: 0x43,
  R_IDLE: 0x44,                      /* { ms }: the GET_IDLE reply (todos/
                                        0096) — its own type so /bin/wm's
                                        fire-and-forget drain can route it
                                        (the R_SHOT precedent) */
  R_CURSOR: 0x45,                    /* { shape }: the CURSOR_AT reply
                                        (todos/0105; the R_IDLE precedent) */
  EV_CREATED: 0x80, EV_DESTROYED: 0x81, EV_TITLE: 0x82, EV_FOCUS: 0x83,
  EV_MOVED: 0x84, EV_MINIMIZED: 0x85, EV_CONFIGURED: 0x86, EV_SCREEN: 0x87,
  EV_SCALED: 0x88, EV_SCALE_REQ: 0x89, EV_TITLE_ACTIVATE: 0x8A,
  EV_CYCLE: 0x8B,                    /* { direction }: the cycling chord
                                        (Alt/Ctrl+Alt+Tab; Shift reverses) or
                                        a CYCLE command — policy walks focus
                                        (todos/0032); only emitted with a
                                        subscriber, else the chord is NOT
                                        recognized and the key passes through
                                        (the kernel never eats keystrokes) */
  EV_MENU: 0x8C,                     /* { }: the Start chord (Esc with Ctrl
                                        held) or a MENU command (todos/0078)
                                        — policy toggles the Start menu; the
                                        same no-subscriber pass-through rule
                                        as EV_CYCLE */
  EV_SNAP_EDGE: 0x8D,                /* { sid, edge }: mid-title-drag zone
                                        change (todos/0095) — the pointer
                                        entered (edge 1-7) or left (0) a
                                        screen-edge snap zone; policy raises
                                        or drops the translucent preview */
  EV_SNAP_DROP: 0x8E,                /* { sid, edge, x0, y0 }: title drag
                                        released (todos/0095) — after the
                                        EV_MOVED, and only if it MOVED past
                                        WM_SNAP_SLOP (a click is not a
                                        drag); edge > 0 commits a snap
                                        (x0/y0 = the pre-drag position, the
                                        floating rect to save), edge 0 on a
                                        snapped window is the drag-off
                                        restore; only with a subscriber */
  EV_SNAP_KEY: 0x8F,                 /* { direction }: the Win+arrow chord
                                        or a SNAP command (todos/0095) —
                                        0 L / 1 R / 2 U / 3 D; the EV_CYCLE
                                        pass-through rule; policy acts on
                                        the focused window */
  EV_SAVER: 0x90,                    /* { }: a SAVER command (todos/0096) —
                                        wmctl saver / the Control Panel
                                        Preview button; policy raises the
                                        configured screensaver immediately;
                                        only emitted with a subscriber */
  EV_SYSMENU: 0x91,                  /* { sid }: the Alt+Space chord or a
                                        SYSMENU command (todos/0102) — policy
                                        raises the window system menu on that
                                        (the focused) window; the EV_CYCLE
                                        pass-through rule (no subscriber, the
                                        chord reaches the app unchanged) */
  EV_HOTKEY: 0x92,                    /* { token, flags, focusSid }: a
                                        NON-reserved key-grab table entry
                                        matched (todos/KEYBINDING-OVERRIDE-
                                        SYSTEM.md §3) — the ONE event for every
                                        user-installed chord. flags bit0 = Shift
                                        held, bit1 = key repeat. The default
                                        table's RESERVED tokens (high bit) emit
                                        the legacy EV_CYCLE/MENU/SNAP_KEY/SYSMENU
                                        instead, so pre-grab-table clients are
                                        byte-identical; the EV_CYCLE
                                        pass-through rule (no subscriber, the
                                        chord reaches the app unchanged) */
  EV_OVERVIEW: 0x93,                  /* { }: toggle the window overview (todos/
                                        EXPOSE-MISSION-CONTROL.md) — an OVERVIEW
                                        command (wmctl overview). The Ctrl+Alt+E
                                        chord reaches wm.c via EV_HOTKEY
                                        { KTOK_OVERVIEW } instead; this is the
                                        command-side twin (the EV_MENU pattern).
                                        Only emitted with a subscriber */
  EV_OVERVIEW_PICK: 0x94,             /* { sid }: overview pick — a pointer-down
                                        landed in cell `sid`, or dismissed
                                        (sid = 0: background click or Esc).
                                        Policy exits and restores/focuses/raises
                                        the picked window */
};

/* R_ERR errno values (arch CS7, todos/0242). The wm* command methods below
 * return 0 on success or one of these NAMES on failure; _wmpDispatch maps
 * the name to its libc <errno.h> number for the R_ERR payload (numbers MUST
 * MATCH host.js's errnoMap / the libc errno.h). Semantics are documented at
 * the "R_ERR payload" line of the protocol comment above. */
var WMP_ERRNO = { EPERM: 1, ESRCH: 3, EAGAIN: 11, ENODEV: 19, EINVAL: 22, ENOSYS: 38 };
var WMP_REC_BYTES = 80;
var WM_SOCK_PATH = '/run/wm.sock';

/* ---- kernel key-grab table (todos/KEYBINDING-OVERRIDE-SYSTEM.md §3) ----
 * Canonical modifier mask — the TWIN of os/keys.h KM_* + km_from_sdl(). The
 * two folds are kept in lockstep by hand (kernel is per-SYSTEM, keys.h is
 * app-side); test_keybind.js asserts they agree on a table of raw SDL words.
 * The kernel is scheme- and config-blind: it stores (scancode, km, token)
 * rows and routes matches; it never reads /etc/keys and never learns what a
 * token means. */
var KM_SHIFT = 0x1, KM_CTRL = 0x2, KM_ALT = 0x4, KM_GUI = 0x8;

/* Fold the raw SDL modifier word (SDL_KMOD_*: SHIFT 0x0003, CTRL 0x00C0,
 * ALT 0x0300, GUI 0x0C00) to the canonical KM_* bits — twin of keys.h. */
function wmKmFromSdl(sdlmod) {
  return ((sdlmod & 0x0003) ? KM_SHIFT : 0) |
         ((sdlmod & 0x00C0) ? KM_CTRL : 0) |
         ((sdlmod & 0x0300) ? KM_ALT : 0) |
         ((sdlmod & 0x0C00) ? KM_GUI : 0);
}

/* GRAB_SET's n cap (a runaway backstop far above the registry's size). */
var WM_GRAB_MAX = 64;

/* Reserved grab tokens (high bit set): the built-in DEFAULT TABLE carries
 * these, and a match on one emits the LEGACY WMP event with its historical
 * payload (and returns wmKey's historical action string) instead of
 * EV_HOTKEY. That is the whole back-compat story — every pre-grab-table WM
 * client and every scripted-WM test keeps working byte-identically; wm.c
 * opting in via GRAB_SET is what upgrades it to the token world. A
 * non-reserved token (any wm.c-installed chord) rides EV_HOTKEY. */
var WM_TOK_RESERVED = 0x80000000 | 0;      // high bit = reserved (legacy emit)
var WM_TOK_CYCLE   = 0x80000001 | 0;
var WM_TOK_MENU    = 0x80000002 | 0;
var WM_TOK_SNAP    = 0x80000003 | 0;
var WM_TOK_SYSMENU = 0x80000004 | 0;

/* The built-in default table — reproduces the four historical hardcoded chord
 * blocks VERBATIM under exact-modifier matching. Cycle keeps its dual default
 * (bare Alt+Tab where the browser delivers it, and Ctrl+Alt+Tab) as TWO rows,
 * so both fold-exactly and stay recognized; the old looser family masks
 * (mod & 0xC0 etc.) TIGHTEN to exact match here — an intended change (e.g.
 * Ctrl+Alt+Esc no longer opens Start), and no existing test injects an
 * extra-modifier chord that relied on the loose match (grep-verified). The
 * Shift bit is never named in a default row, so the amendment's non-Shift
 * branch always applies — today's Shift-reverses-cycle and Shift-extends
 * behavior are byte-identical. Scancodes: 43 Tab, 41 Esc, 44 Space,
 * 79 Right / 80 Left / 81 Down / 82 Up. */
var WM_DEFAULT_GRABS = [
  { scancode: 43, km: KM_ALT,           token: WM_TOK_CYCLE },    // Alt+Tab
  { scancode: 43, km: KM_CTRL | KM_ALT, token: WM_TOK_CYCLE },    // Ctrl+Alt+Tab
  { scancode: 41, km: KM_CTRL,          token: WM_TOK_MENU },     // Ctrl+Esc
  { scancode: 79, km: KM_GUI,           token: WM_TOK_SNAP },     // GUI+Right
  { scancode: 80, km: KM_GUI,           token: WM_TOK_SNAP },     // GUI+Left
  { scancode: 81, km: KM_GUI,           token: WM_TOK_SNAP },     // GUI+Down
  { scancode: 82, km: KM_GUI,           token: WM_TOK_SNAP },     // GUI+Up
  { scancode: 44, km: KM_ALT,           token: WM_TOK_SYSMENU },  // Alt+Space
];

/* Kernel-drawn chrome, v1 (WM.md "Decorations — staged"): fixed Win95-ish
 * metrics, deterministic — the same numbers drive hit-testing here, the
 * browser compositor's drawing, and the headless screenshot composite.
 * The client rect is (x, y, w, h); the title bar sits ABOVE it, and a
 * WM_BORDER frame surrounds title+client (todos/0019). Resize drag zones
 * on the frame: right edge -> E, bottom edge -> S, near the bottom-right
 * corner -> SE (left/top edges just focus — moving-edge resizes are
 * deliberately not in this version).
 * Hit zones are FATTER than the drawn frame (#388), but ONLY on the edges
 * that resize: the band accepts presses out to WM_BORDER_HIT past the
 * RIGHT and BOTTOM edges (invisible slop outward, steals nothing from the
 * client), the SE corner widens E/S into SE within WM_GRIP_HIT of the
 * corner, and on a RESIZABLE surface the SE grip also reaches WM_GRIP_IN
 * INWARD into the client — the one inward steal, sized to the classic
 * scrollbar-corner size box, so a maximized/snapped window (no outward
 * left) stays resizable. Only 'down' is intercepted in that inward
 * square; moves, ups and wheels still reach the app. The TOP and LEFT
 * edges keep the thin WM_BORDER band: they are focus-only, and invisible
 * slop there steals the window-behind's chrome in a cascade (a 12px top
 * band swallows the close box of the title bar it overlaps — the
 * os-shell applet-close regression). WM_BORDER stays the DRAWN width —
 * raising it would move every screenshot golden. */
var WM_TITLE_H = 30;                         // font-20 retune (v133-qa): the
                                             // caption must read >= the 30px
                                             // MENU_BAR_H, not under it (was 28,
                                             // undersized) — 30px holds the 20px
                                             // bold label (WM_LABEL_PX — the
                                             // shared-chrome rule)
var WM_LABEL_PX = 20;                        // label text pixel size (todos/0275):
                                             // BOTH composites — the browser
                                             // compositor's labelFor and the
                                             // headless _blitLabel — render
                                             // chrome text via the ksvc blob at
                                             // this ONE size; strip height comes
                                             // from the render header (~28 at
                                             // 20px, the v133 rhythm)
var WM_CLOSE_W = 20, WM_CLOSE_PAD = 4;       // close box, right-aligned in the bar
var WM_HUNG_GRACE_MS = 5000;                 // #486: close request unconsumed this
                                             // long -> owner force-quit (the
                                             // Windows HungAppTimeout analog)
// The 5 s value is ACCEPTED PARTIALLY VALIDATED (#489, 2026-08-06). What was
// measured: seven close-issuing kernel e2es spanning every app family behind
// the watchdog (term/pty, the win32 veneer x3, NetSurf, wm.c) ran under the
// load harness at #486 (--under-load, term_e2e inflated to 266 s) and pumped
// their QUITs well inside the grace — no false fire (~29 files issue closes;
// the coverage is by family, not by file); and test_wm.js pins BOTH sides of
// the boundary
// deterministically (a wedged ring force-quits at the deadline; a SLOW
// consumer that first drains mid-grace, after several poll ticks, survives).
// What CANNOT be validated here: a real >5 s worker starvation. The estate's
// load harness busy-loops cores, but the OS still timeslices them, so a
// worker provably descheduled past the grace is unproducible by construction
// — and the watchdog's ONLY observable is ring-rpos advance, so a starved-
// but-healthy app and a wedged one are indistinguishable BY DESIGN (the
// Windows rule: pumping = responding; a >5 s in-worker block — long GC, a
// 6 s pure-compute stretch, sleep(6) — force-quits on close, accepted). A
// real-world fire is observable, not silent: _wmForceQuit logs the titled
// reason through _log (boot.js stderr / browser boot console). 🔴 If a false
// force-quit ever fires in CI, that is a REAL FINDING (#489): diagnose the
// starvation — do NOT raise this grace, add a retry, or widen a timeout to
// go green.
var WM_HUNG_POLL_MS = 250;                   // #486: consumption poll cadence
var WM_BOX_GAP = 2;                          // between the [min][max][close] boxes
                                             // (todos/0030; same 20px metrics)
var WM_BORDER = 4;                           // DRAWN frame width around
                                             // title+client (both composites)
var WM_GRIP = 16;                            // pre-#388 SE-corner hit metric —
                                             // superseded by WM_GRIP_HIT /
                                             // WM_GRIP_IN below; kept exported
var WM_BORDER_HIT = 12;                      // hit-only band width past the E/S
                                             // edges (#388): outward slop,
                                             // never drawn; N/W stay WM_BORDER
var WM_GRIP_HIT = 32;                        // hit-only SE widening along the
                                             // band's E/S edges (#388)
var WM_GRIP_IN = 16;                         // hit-only SE inward reach into a
                                             // RESIZABLE client (#388)
var WM_MIN_SIZE = 32;                        // client floor for resize requests
var WM_DBLCLICK_MS = 400;                    // title double-click window (todos/0025)
var WM_DBLCLICK_SLOP = 4;                    // ...and max px drift between the downs
var WM_MAP_TIMEOUT_MS = 200;                 // map-on-placement backstop (todos/0069):
                                             // a WM-managed surface the WM never
                                             // places maps anyway after this
var WM_ANIM_MS = 200;                        // minimize/restore compositor animation
                                             // length (todos/0063) — records older
                                             // than this are pruned from wmScene()
var WM_SNAP_MARGIN = 8;                      // Aero Snap edge-zone width (todos/0095):
                                             // a mid-drag pointer within this many px
                                             // of a screen edge is "in the zone";
                                             // corners are within it on both axes
var WM_SNAP_SLOP = 4;                        // ...and none of it arms until the
                                             // pointer travels this far from the
                                             // title mousedown — a CLICK (or its
                                             // jitter) is not a drag: no zone
                                             // events, no EV_SNAP_DROP (a drop on
                                             // a maximized window would restore it)
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
var SIG_NAMES = {};
for (var sigName in SIG) SIG_NAMES[SIG[sigName]] = 'SIG' + sigName;
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

/* Vsync broadcast (todos/0100). vsyncEnabled: the kernel advertised a real
 * frame clock at spawn (and this engine can await a SAB word). vsyncWait:
 * resolves on the next compositor tick. Tracks the last-delivered seq so a
 * tick that landed while the frame callback ran resolves immediately (rAF
 * catch-up semantics) instead of costing a whole extra frame. */
KernelClient.prototype.vsyncEnabled = function () {
  return typeof Atomics.waitAsync === 'function' &&
         Atomics.load(this._i32, KP_VSYNC_EN) === 1;
};

KernelClient.prototype.vsyncWait = function () {
  var i32 = this._i32;
  var cur = Atomics.load(i32, KP_VSYNC_SEQ);
  if (this._vsyncSeen === undefined) this._vsyncSeen = cur;
  if (cur !== this._vsyncSeen) {           // missed tick(s): fire now
    this._vsyncSeen = cur;
    return Promise.resolve();
  }
  var self = this;
  // On-demand compositor (todos/0169): publish the waiter FIRST, then
  // re-read the parked flag and ring the doorbell if set. This is one half
  // of the Dekker pair — the compositor stores PARKED before re-reading
  // ARMED — so either it sees our count and stays armed, or we see its
  // flag and post the wake; a silent strand (waitAsync registration is
  // passive, the kernel can't see it) is impossible either way.
  Atomics.add(i32, KP_VSYNC_ARMED, 1);
  if (Atomics.load(i32, KP_COMP_PARKED) === 1) this._post({ type: 'want-frame' });
  var r = Atomics.waitAsync(i32, KP_VSYNC_SEQ, cur);
  if (!r.async) {                          // 'not-equal': tick raced the wait
    Atomics.sub(i32, KP_VSYNC_ARMED, 1);
    self._vsyncSeen = Atomics.load(i32, KP_VSYNC_SEQ);
    return Promise.resolve();
  }
  return r.value.then(function () {
    Atomics.sub(i32, KP_VSYNC_ARMED, 1);
    self._vsyncSeen = Atomics.load(i32, KP_VSYNC_SEQ);
  });
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

/* ---- vDSO block (todos/0179): seqlock reader ---- */

/* Read the kernel-page words `indices` as ONE consistent snapshot: retry
 * while the seq word is odd (write in progress) or moved across the reads.
 * Returns the values array, or null when the page is unpublished (seq 0 —
 * a KernelClient over a page no kernel ever stamped) or after a bounded
 * spin — callers fall back to the RPC, which stays the source of truth. */
KernelClient.prototype._vdsoRead = function (indices) {
  var i32 = this._i32;
  for (var tries = 0; tries < 64; tries++) {
    var s1 = Atomics.load(i32, KP_VD_SEQ);
    if (s1 === 0) return null;
    if (s1 & 1) continue;
    var out = [];
    for (var k = 0; k < indices.length; k++) out.push(Atomics.load(i32, indices[k]));
    if (Atomics.load(i32, KP_VD_SEQ) === s1) return out;
  }
  return null;
};

/* Live parent pid — tracks orphan reparenting to init, unlike the static
 * ppid minted at spawn. null on an unpublished page (caller keeps its
 * static). */
KernelClient.prototype.getppid = function () {
  var r = this._vdsoRead([KP_VD_PPID]);
  return r ? r[0] : null;
};

/* Milliseconds since the kernel booted, computed against the published
 * boot instant — no RPC. null on an unpublished page. */
KernelClient.prototype.uptimeMs = function () {
  var r = this._vdsoRead([KP_VD_BOOT_LO, KP_VD_BOOT_HI]);
  if (!r) return null;
  return Date.now() - ((r[1] >>> 0) * 4294967296 + (r[0] >>> 0));
};

/* The real screen dims (ctor default, then wmSetScreen) — what the WM sees
 * via EV_SCREEN, readable by any process. null on an unpublished page. */
KernelClient.prototype.screen = function () {
  var r = this._vdsoRead([KP_VD_SCREEN_W, KP_VD_SCREEN_H]);
  return r ? { w: r[0], h: r[1] } : null;
};

/* Park on the doorbell until a signal is deliverable ('signal') or the
 * timeout elapses ('timeout'). ms undefined/null → wait forever.
 *
 * Timed parks compensate the OS timed-wait leeway (#492): Atomics.wait
 * timeouts wake late by a timer-coalescing leeway — measured on macOS as a
 * deterministic min(request/2, 10ms), which made usleep(16000) really sleep
 * 24ms. Requesting 2/3 of the remainder against a monotonic deadline makes a
 * full-leeway wake land ON the deadline while an on-time wake shrinks the
 * remainder by 1/3 (log-bounded wakes, ~1.2 per park measured); the final
 * sub-ms request bounds residual overshoot at ~0.5ms. 'timed-out' from a
 * shortened wait no longer means the deadline passed — only the monotonic
 * re-check decides. The thread stays parked throughout; never a spin. */
KernelClient.prototype.park = function (ms) {
  var i32 = this._i32;
  var deadline = (ms === undefined || ms === null) ? null : performance.now() + ms;
  for (;;) {
    var seq = Atomics.load(i32, KP_DOORBELL);
    if (this.pending()) return 'signal';
    if (deadline === null) {
      Atomics.wait(i32, KP_DOORBELL, seq);
    } else {
      var left = deadline - performance.now();
      if (left <= 0) return 'timeout';
      Atomics.wait(i32, KP_DOORBELL, seq, left > 1 ? left * (2 / 3) : left);
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
    setsid: function () { return self.call(OP.SETSID, {}); },
    // vDSO fast path (todos/0179): the caller's OWN pgid/sid are published
    // on the kernel page, so getpgrp()/getpgid(0)/getsid(0) make zero RPCs.
    // Foreign pids — and a failed seqlock read — still ask the kernel, the
    // source of truth. The self-pid check rides the same snapshot as the
    // value, so a mid-read setpgid can't pair one field with the other's
    // past.
    getpgid: function (pid) {
      var v = self._vdsoRead([KP_VD_PID, KP_VD_PGID]);
      if (v && ((pid | 0) === 0 || (pid | 0) === v[0])) return { pgid: v[1] };
      return self.call(OP.GETPGID, { pid: pid });
    },
    getsid: function (pid) {
      var v = self._vdsoRead([KP_VD_PID, KP_VD_SID]);
      if (v && ((pid | 0) === 0 || (pid | 0) === v[0])) return { sid: v[1] };
      return self.call(OP.GETSID, { pid: pid });
    },
    // Interval timers (todos/0044): ms over the wire; the libc converts
    // timeval <-> ms and owns the sub-ms round-up.
    setitimer: function (which, valueMs, intervalMs) {
      return self.call(OP.SETITIMER, { which: which, valueMs: valueMs, intervalMs: intervalMs });
    },
    getitimer: function (which) { return self.call(OP.GETITIMER, { which: which }); },
    sigdisp: function (sig, kind) { self.call(OP.SIGDISP, { sig: sig, kind: kind }); },
    compile: function (argv, cwd) { return self.call(OP.COMPILE, { argv: argv, cwd: cwd }); },
    // System clipboard (todos/0090): one kernel slot; host.js owns the
    // chunking (payloads pre-framed per the OP table's RAW layouts).
    // payloadChunk is the max chunk for those staging lanes (clipboard +
    // http body) — derived kernel-side from KP_PAYLOAD_CAP (todos/0235)
    // so host.js never restates the kernel-page layout.
    payloadChunk: KP_HOOK_CHUNK,
    // Shared-SAB layout tripwire (CD26, the same 0235 shape): host.js
    // re-declares the shm-surface / input-ring / audio-ring layouts and
    // cross-checks every field of this table at surface-backend setup —
    // see WM_SAB_LAYOUT.
    wmSabLayout: WM_SAB_LAYOUT,
    clipSet: function (bytes) { return self.callRaw(OP.CLIP_SET, bytes); },
    // peek 1 = availability probe (__clip_has): always served from the
    // cached slot — a data read (peek 0, off 0) may park on the embedder's
    // host-clipboard refresh (the clipboard seam; see OP.CLIP_GET).
    clipGet: function (fmt, off, peek) {
      return self.call(OP.CLIP_GET, { fmt: fmt, off: off, peek: peek ? 1 : 0 });
    },
    // Egress (todos/0398): the pre-framed textual disposition+path list
    // (host.js createEgress composes it; layout in the OP table). One RPC,
    // one artifact; the kernel materializes and hands it to the embedder.
    egress: function (bytes) { return self.callRaw(OP.EGRESS, bytes); },
    // HTTP transport (todos/0172; fd-shaped since todos/0417): host.js's
    // createHttp drives these; the libcurl veneer (0173) sits on top.
    // httpBody stages request-body chunks (RAW [u32 off][bytes]); httpOpen
    // returns {fd} — body drain and close ride the ordinary fs hooks
    // (FS_READ/FS_CLOSE); httpStatus is non-blocking (EAGAIN before
    // headers), so neither op parks and neither needs the interruptible
    // flag.
    httpBody: function (bytes) { return self.callRaw(OP.HTTP_BODY, bytes); },
    httpOpen: function (spec) { return self.call(OP.HTTP_OPEN, spec); },
    httpStatus: function (fd) { return self.call(OP.HTTP_STATUS, { fd: fd }); },
    httpError: function (fd) { return self.call(OP.HTTP_ERROR, { fd: fd }); },
    sigpoll: function () { return self.sigpoll(); },
    sigmask: function (mask) { self.sigmask(mask); },
    park: function (ms) { return self.park(ms); },
    // Unified wait (todos/0178): { r: [fds], ring: 0/1, timeoutMs } →
    // { why: 0 timeout / 1 fd / 2 ring } or { errno: 'EINTR' } on a posted
    // signal (interruptible like FS_SELECT). host.js's __wait import and
    // the surface backend own the ring drain around it.
    waitMulti: function (req) { return self.call(OP.FS_WAIT, req, true); },
    exit: function (status) { return self.call(OP.EXIT, { code: status }); },
    // Vsync broadcast (todos/0100): host.js's surface backend paces SDL
    // frame loops off the kernel's compositor clock when advertised.
    vsyncEnabled: function () { return self.vsyncEnabled(); },
    vsyncWait: function () { return self.vsyncWait(); },
    // Synchronous tick-counter read (ticket #484): host.js's gpu-transport
    // present clamp asks "which vsync interval is this?" per present — a
    // plain load, never a park (vsyncWait is the parking flavor).
    vsyncSeq: function () { return Atomics.load(self._i32, KP_VSYNC_SEQ); },
    // On-demand compositor doorbells (todos/0169): shm presents are
    // SAB-only, so host.js re-reads the parked flag after every seq bump
    // and rings want-frame when set; frame-idle is pumpWait's entry saying
    // the app went back to waiting on events (host.js gates it on a
    // present since the last idle so quiet pollers post nothing).
    compParked: function () { return Atomics.load(self._i32, KP_COMP_PARKED) === 1; },
    wantFrame: function () { self._post({ type: 'want-frame' }); },
    frameIdle: function () { self._post({ type: 'frame-idle' }); },
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
    // flags bit6: anchored child (todos/0256) — parentSid names the parent
    // surface, dx/dy the anchor offset in parent buffer coords; bit7 adds
    // the press-outside-dismisses grab (menu arch A2). Old callers omit the
    // trailing args (|0 -> 0 = a plain top-level).
    surfaceCreate: function (w, h, title, fbSab, ringSab, flags, parentSid, dx, dy) {
      self._post({ type: 'wm-sabs', fb: fbSab, ring: ringSab || null });
      return self.call(OP.SURFACE_CREATE, { w: w, h: h, title: title || '', flags: flags | 0,
        parentSid: parentSid | 0, dx: dx | 0, dy: dy | 0 });
    },
    // The published screen dims (vDSO read, zero RPCs) — SDL_GetDisplayBounds.
    screen: function () { return self.screen(); },
    surfaceDestroy: function (sid) { return self.call(OP.SURFACE_DESTROY, { sid: sid }); },
    surfaceSetTitle: function (sid, title) { return self.call(OP.SURFACE_SET_TITLE, { sid: sid, title: title || '' }); },
    // Flag-word update (todos/0018): bit0 borderless, bit1 relative-mouse.
    surfaceSetFlags: function (sid, flags) { return self.call(OP.SURFACE_SET_FLAGS, { sid: sid, flags: flags | 0 }); },
    // Per-surface cursor shape (todos/0105, SDL_SetCursor): SDL_SystemCursor
    // value, or -1 to hide. The kernel overlays chrome resize cursors.
    surfaceSetCursor: function (sid, shape) { return self.call(OP.SURFACE_SET_CURSOR, { sid: sid, shape: shape | 0 }); },
    // Owner-initiated resize (todos/0068, SDL_SetWindowSize): kernel answers
    // with a WINDOW_RESIZED ring event; the ack is surfaceConfigure below.
    surfaceResize: function (sid, w, h) { return self.call(OP.SURFACE_RESIZE, { sid: sid, w: w | 0, h: h | 0 }); },
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
    // Master gain (todos/0048): percent 0..200, gain < 0 queries.
    audioGain: function (gain) { return self.call(OP.AUDIO_GAIN, { gain: gain }); },
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
 * Ctrl-C finally means something). A signal char also flushes the INPUT
 * queue — edit buffer AND queued cooked type-ahead — unless NOFLSH is set
 * (#433, POSIX 11.1.9); the OUTPUT-queue half of that flush (pty
 * slave->master buffer) is a recorded descope, no observed symptom.
 * The UI bridge stays dumb — raw bytes in
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
var T_ICRNL = 0x100, T_INLCR = 0x40, T_IGNCR = 0x80,
    T_IUTF8 = 0x4000;                                          // c_iflag
var T_OPOST = 0x1, T_ONLCR = 0x2;                              // c_oflag
var T_ECHOE = 0x2, T_ECHOK = 0x4, T_ECHO = 0x8, T_ECHONL = 0x10,
    T_ISIG = 0x80, T_ICANON = 0x100, T_NOFLSH = 0x80000000;    // c_lflag
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
  this._eofFlag = false;        // transient VEOF (^D): consumed by ONE read
  this._hupFlag = false;        // hangup (pty master gone): latched EOF forever
  this.waiters = [];            // pids with a deferred FS_READ on THIS tty, FIFO
                                // (per-instance since 0020: ptys mean many ttys)
  // Bridge-declared: a human terminal is attached, so std fd 1/2 should be
  // tty-kind (isatty true -> shells prompt). See Kernel._stdOfds.
  this.interactiveOut = !!opts.interactiveOut;
  this.termios = {
    iflag: T_ICRNL | T_IUTF8,
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

/* Terminal display width of a code point: 2 for East-Asian Wide/Fullwidth
 * blocks, 1 for everything else INCLUDING combining marks (the D5 ruling:
 * a combining mark renders as its own spacing cell, so its erase is one
 * cell). MUST MATCH os/wcwidth.h `wcwidth_cp` (the terminal's cell-layout
 * twin) — change both together or a wide char erases the wrong number of
 * cells. Condensed Unicode 15.0 EAW W/F table. */
var WCWIDTH_WIDE = [
  [0x1100, 0x115F], [0x2329, 0x232A], [0x2E80, 0x303E], [0x3041, 0x33FF],
  [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xA000, 0xA4CF], [0xA960, 0xA97F],
  [0xAC00, 0xD7A3], [0xF900, 0xFAFF], [0xFE10, 0xFE19], [0xFE30, 0xFE6B],
  [0xFF00, 0xFF60], [0xFFE0, 0xFFE6], [0x16FE0, 0x16FE4], [0x17000, 0x187F7],
  [0x18800, 0x18CD5], [0x1B000, 0x1B2FF], [0x1F300, 0x1F64F],
  [0x1F680, 0x1F6FF], [0x1F900, 0x1F9FF], [0x1FA70, 0x1FAFF],
  [0x20000, 0x2FFFD], [0x30000, 0x3FFFD],
];
function wcwidthCp(cp) {
  if (cp < 0x1100) return 1;
  for (var i = 0; i < WCWIDTH_WIDE.length; i++)
    if (cp >= WCWIDTH_WIDE[i][0] && cp <= WCWIDTH_WIDE[i][1]) return 2;
  return 1;
}

/* Remove one CHARACTER from the tail of the canonical edit buffer. With
 * IUTF8 set (Linux semantics; gucOS default) trailing UTF-8 continuation
 * bytes fall with their lead byte, so one ERASE deletes a whole multi-byte
 * character; with it clear the pop stays byte-wise (the historical mode).
 * Returns the DISPLAY width of what fell (1 or 2 cells): the caller echoes
 * one [BS SP BS] triple per cell, so a double-width CJK char visually
 * erases both of its cells (Unicode Phase D; both term.c and xterm.js
 * render such chars across 2 cells). Byte-wise mode always reports 1. */
Tty.prototype._popChar = function (t) {
  if (!(t.iflag & T_IUTF8)) { this._line.pop(); return 1; }
  var tail = [];
  while (this._line.length > 1 && (this._line[this._line.length - 1] & 0xC0) === 0x80)
    tail.unshift(this._line.pop());
  var lead = this._line.pop();
  // Decode the popped bytes into a code point (the sequence was intact
  // when typed; anything malformed just reports width 1).
  var cp;
  if (lead < 0x80 && tail.length === 0) cp = lead;
  else if ((lead & 0xE0) === 0xC0 && tail.length === 1) cp = lead & 0x1F;
  else if ((lead & 0xF0) === 0xE0 && tail.length === 2) cp = lead & 0x0F;
  else if ((lead & 0xF8) === 0xF0 && tail.length === 3) cp = lead & 0x07;
  else return 1;
  for (var i = 0; i < tail.length; i++) cp = (cp << 6) | (tail[i] & 0x3F);
  return wcwidthCp(cp);
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

/* Discard queued COOKED input (the tcflush(TCIFLUSH) core, shared by the
 * ISIG signal chars and TCSAFLUSH — #433). Brokered mode is trivially safe:
 * _cooked lives on the kernel thread and a parked FS_READ waiter holds no
 * snapshot of it. Ring mode: a reader PARKED on the SI_SEQ futex is safe
 * too — it re-loads SI_AVAIL fresh after every wake, so zeroing AVAIL
 * FIRST means any reader arriving mid-flush sees "empty" and parks rather
 * than reading a torn index pair. The one exposed window is a reader
 * already inside its avail>0 consume (loaded AVAIL, not yet subtracted) at
 * the flush instant: its unconditional Atomics.sub can leave AVAIL negative
 * — the same few-instruction race TCSAFLUSH has accepted since Phase 3
 * ("flush during concurrent reads is undefined", POSIX agrees), not
 * widened here, and unreachable in the OS proper (brokered). */
Tty.prototype._flushInput = function () {
  if (this._brokered) { this._cooked.length = 0; return; }
  var i32 = this._i32;
  Atomics.store(i32, SI_AVAIL, 0);
  Atomics.store(i32, SI_READPOS, Atomics.load(i32, SI_WRITEPOS));
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
        if (t.lflag & T_NOFLSH) {
          // NOFLSH (POSIX): a signal char flushes nothing — pending raw
          // bytes commit, the edit buffer and cooked queue survive.
          if (raw.length) { this._push(raw); raw = []; }
        } else {
          // POSIX: INTR/QUIT/SUSP flush the input queue — the edit buffer,
          // raw bytes accumulated this burst, AND completed type-ahead
          // already sitting in the cooked queue (#433: without the queue
          // flush, a line typed + Entered during a running command replays
          // into the next read after ^C). Output-queue flush is a recorded
          // descope (pty slave->master buffer; no observed symptom).
          raw = [];
          this._line.length = 0;
          this._flushInput();
        }
        if (t.lflag & T_ECHO) { this._echo([94, 64 + (b & 31)]); this._echoNl(); } // ^C style
        this._signalFg(sig);
        continue;
      }
    }
    if (t.lflag & T_ICANON) {
      if (b === t.cc[V_ERASE]) {
        if (this._line.length) {
          var ew = this._popChar(t);   // display cells (2 for CJK-wide)
          if ((t.lflag & T_ECHO) && (t.lflag & T_ECHOE))
            while (ew-- > 0) this._echo([8, 32, 8]);
        }
        continue;
      }
      if (b === t.cc[V_KILL]) {
        if ((t.lflag & T_ECHO) && (t.lflag & T_ECHOK)) {
          while (this._line.length) {
            var kw = this._popChar(t);
            while (kw-- > 0) this._echo([8, 32, 8]);
          }
        } else {
          this._line.length = 0;
        }
        continue;
      }
      if (b === t.cc[V_EOF]) {
        if (this._line.length) { this._push(this._line); this._line = []; }
        else this.eof();                             // transient one-shot EOF (0163)
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

/* End of input. Two distinct conditions POSIX termios keeps separate (0163):
 *   - VEOF (^D on an empty line): TRANSIENT. It makes the CURRENT read return
 *     0, then it's gone — the next read blocks for fresh input. So a REPL
 *     exiting on ^D must not cascade EOF into the shell reading the same tty.
 *   - hangup (pty master close / agent closed stdin): PERMANENT. Reads latch
 *     at EOF forever (the session is over; SIGHUP fired separately).
 * Pass permanent=true for the hangup path; VEOF omits it. */
Tty.prototype.eof = function (permanent) {
  if (permanent) this._hupFlag = true; else this._eofFlag = true;
  Atomics.store(this._i32, SI_EOF, 1);
  if (this._brokered) { this._kernel._ttyNotify(this); return; }
  this.wakeReaders();
};

/* Consume the transient VEOF as a read delivers its 0-byte EOF — the hangup
 * flag stays latched. Called by the brokered read-service sites right before
 * they respond with an empty buffer. */
Tty.prototype._consumeEof = function () {
  if (this._hupFlag) return;
  this._eofFlag = false;
  Atomics.store(this._i32, SI_EOF, 0);
};

/* Brokered readiness (select) and read service. */
Tty.prototype.readable = function () {
  return this._cooked.length > 0 || this._eofFlag || this._hupFlag;
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
  var wasCanon = (this.termios.lflag & T_ICANON) !== 0;
  this.termios.iflag = t.iflag >>> 0;
  this.termios.oflag = t.oflag >>> 0;
  this.termios.cflag = t.cflag >>> 0;
  this.termios.lflag = t.lflag >>> 0;
  if (Array.isArray(t.cc)) {
    for (var i = 0; i < NCCS; i++) this.termios.cc[i] = (t.cc[i] | 0) & 0xff;
  }
  if (actions === TCSAFLUSH) {
    // Discard unread input (concurrency rules: _flushInput's comment).
    this._line = [];
    this._flushInput();
  } else if (wasCanon && !(this.termios.lflag & T_ICANON) && this._line.length) {
    // Leaving canonical mode mid-line (Linux n_tty semantics, the 0171 wedge
    // class): the un-terminated edit buffer becomes readable NOW. Stranding
    // it splits a typed line straddling a shell's cooked window -> its line
    // editor's raw switch — the head is lost and the surviving tail executes
    // (or opens an unbalanced quote and wedges the shell in PS2 forever).
    var part = this._line;
    this._line = [];
    this._push(part);
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
 *                   image (ArrayBuffer|null), module (WebAssembly.Module|null),
 *                   kernelPage (SAB) }
 *       Exactly one of image/module is non-null: module is the compiled-
 *       Module cache hit (todos/0037 — structured-clone it to the worker);
 *       image is the raw-bytes path for everything uncacheable.
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
  // Cursor (todos/0105): the UI bridge is told the effective cursor shape (an
  // SDL_SystemCursor value; -1 hidden) whenever it CHANGES on a pointer move —
  // chrome resize cursors over frames, the focused/hovered surface's client
  // cursor over its client area, arrow elsewhere. Browser-only rendering (the
  // page sets canvas.style.cursor); headless kernels leave it a no-op.
  this._onCursor = opts.onCursor || function () {};
  // Audio pump gate (todos/IDLE-POWER.md "audioPump gate"): fired on every
  // AUDIO_OPEN so an embedder that parks its pump interval while the stream
  // table is empty can re-arm it. Disarm is the embedder's call — poll
  // audioStreamCount() after a pump (opens are the only RPC-visible
  // transition; pause/resume is SAB-only, so ANY table entry must keep the
  // pump running or an unpause could never be noticed).
  this._onAudioStream = opts.onAudioStream || function () {};
  // Host-clipboard bridge (ticket #79): fired at every process-side CLIP_SET
  // COMMIT with the new slot ({fmt, bytes}, null on clear) so an embedder can
  // mirror gucOS copies out to a host clipboard. Embedder-side writes
  // (Kernel.clipSet) deliberately do NOT fire it — a bidirectional bridge
  // would loop on its own echo.
  this._onClipboard = opts.onClipboard || null;
  // Deferred CLIP_GET (the clipboard seam): the INBOUND twin of onClipboard.
  // When present, a data read of the slot (CLIP_GET off 0, peek 0) PARKS the
  // calling process and fires this hook with (done, pid) — pid is the parked
  // consumer, so the embedder can scope any refresh-freshness cache per
  // consumer (#562: a pid-blind time window served one process's refresh to
  // the NEXT process's first paste); the embedder
  // refreshes the slot from the host clipboard (the browser page runs
  // navigator.clipboard.readText inside the still-live activation of the
  // keystroke/tap that triggered the paste) and calls done(), and the parked
  // read is served from the possibly-just-updated slot. The consumer is
  // held, never the input stream — key order/repeat/modifier tracking are
  // untouched; the pasting app just blocks one host round-trip like any
  // blocking read. The embedder OWNS the always-done guarantee (kernel-
  // worker.js backstops with a timeout). No hook (boot.js, unit tests,
  // standalone embedders) = the synchronous pre-seam path, byte-identical.
  this._onClipRead = opts.onClipRead || null;
  // Egress (todos/0398): the OUTBOUND file hop. Fired from the OP.EGRESS
  // dispatch with the finished artifact — (dispo, name, bytes): dispo the
  // disposition word ('download' | 'saveas'), name the sanitized artifact
  // name, bytes ONE Uint8Array (a file's bytes, or a store-only zip for a
  // directory/multi-selection). Exactly one artifact per call, always. The
  // browser embedder posts it to the page (transferred) where the still-live
  // activation of the initiating gesture performs the download / save-picker
  // act; boot.js --egress-dir writes it to a host directory (the headless
  // twin). No hook = ENOSYS to the caller — deliberately NO process-local
  // fallback (egress without a host is meaningless; the no-zombie rule).
  this._onEgress = opts.onEgress || null;
  this._log = opts.log || function () {};
  // Hung-app containment (#486, OS.md "Contain"): how long a user close
  // request (chrome close box / WMP CLOSE_REQ) may sit unconsumed in the
  // owner's input ring before the kernel force-quits that process.
  // Embedder-tunable; tests shorten it to keep the harness fast.
  this._hungGraceMs = opts.hungGraceMs > 0 ? opts.hungGraceMs | 0 : WM_HUNG_GRACE_MS;
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
  // Process-side read-only /usr (todos/0180): the embedder ships the sealed
  // system image as ONE SharedArrayBuffer plus its mount prefix
  // (opts.roImage = { prefix: '/usr', sab }); every spawn forwards it and
  // the process worker mounts it locally (host.js SabByteStore + createV4
  // readonly), so reads under the prefix never cross the RPC boundary —
  // immutable data serves itself (KERNEL.md single-writer rule). Brokered
  // only: standalone processes already own a private in-process fs.
  this._roImage = (this._brokered && opts.roImage && opts.roImage.sab &&
                   opts.roImage.prefix) ? opts.roImage : null;
  // Kernel text service (todos/0275): the ksvc blob handle (os/ksvc.js
  // load()), PUBLIC — the browser compositor reads kernel.textService, the
  // headless composite blits through _blitLabel. OS embedders (kernel-worker,
  // boot.js) hard-fail the boot when the blob won't load, so an OS kernel
  // always has one; a bare Kernel without it (non-OS embedders, unit tests —
  // nothing to read a font from) composites textless chrome. That is
  // capability ABSENCE, not a fallback renderer.
  this.textService = opts.textService || null;
  // System clipboard (todos/0090): { fmt, bytes: Uint8Array } or null.
  // Kernel-owned so it outlives the copying process; see OP.CLIP_SET.
  this._clipboard = null;
  // Vsync broadcast (todos/0100): opts.vsync declares that the embedder
  // owns a real frame clock and will call vsyncTick() from it (the browser
  // compositor rAF). Advertised to every process at spawn via KP_VSYNC_EN;
  // headless embedders leave it off and processes pace by deadline timer.
  this._vsync = !!opts.vsync;
  // On-demand compositor (todos/0169): the embedder's damage hook (the
  // browser compositor's scheduleFrame — registered late via wmOnDamage,
  // after the canvas arrives), the mirrored parked flag (single writer:
  // compSetParked, kernel worker only), and the cumulative vsync-notify
  // count (the app-worker-wake probe — flat while parked).
  this._onWmDamage = null;
  this._compParked = false;
  this._vsyncNotifies = 0;
  // Boot instant — /proc/uptime's zero and the base for per-process
  // start_time (procfs, todos/0043).
  this._bootMs = Date.now();
  // procfs (todos/0043): a ProcFS volume in the mount table renders THIS
  // kernel's process table. Bound here so embedders just add
  // `'/proc': new ProcFS()` to their MountFS mounts — nothing to wire.
  if (this._fs && Array.isArray(this._fs._mounts)) {
    for (var mi = 0; mi < this._fs._mounts.length; mi++) {
      var mfs = this._fs._mounts[mi].fs;
      if (mfs instanceof ProcFS) mfs._kernel = this;
    }
  }
  // The compiled-Module cache (todos/0037; generalized to writable volumes
  // by #188): spawn compiles each binary once and ships the
  // WebAssembly.Module in the spawn message (Modules structured-clone
  // across workers; Instances don't — and the engine's JIT state follows
  // the Module object, so one shared Module is also what makes warm spawns
  // warm). Keyed by the fs's moduleKey: an immutable `prefix:ino` on a
  // read-only volume (contents can't change for the mount's lifetime — no
  // invalidation to get wrong), a VALIDATED `prefix:ino:size:mtime` on a
  // writable one (every term read through the store per spawn, so a
  // rewritten binary derives a DIFFERENT key and a stale Module can never
  // be hit). One entry per spawned path: _modulePathKey remembers the key
  // a path last spawned under, and when the derivation moves the old entry
  // is deleted — recompiles REPLACE their entry instead of leaking a dead
  // Module per `cc -o`. Values are Promises (racing spawns of the same
  // binary share one compile); a Promise resolving null marks "uncacheable
  // after all" (ss-flavored, compile error, Modules don't clone on this
  // tier).
  this._moduleCache = new Map();   // moduleKey -> Promise<Module|null>
  this._modulePathKey = new Map(); // spawn path -> its last moduleKey
  this._moduleCacheHits = 0;
  this._moduleCacheMisses = 0;
  this._moduleCloneOk = undefined; // one-shot structuredClone(Module) probe
  this._ofds = new Map();    // ofdId -> { id, kind:'file'|'tty'|'out'|'null'|'pipe'|'socket'|'ptm', refs, bfsFd?, ch?, pipe?, end?, st?, rx?, tx?, path?, backlog?, pending?, acceptWaiters?, tty?, pty? }
                             // 'tty' with pty set = a pty SLAVE (0020);
                             // 'ptm' = a pty master.
  this._nextOfd = 1;
  this._std = null;          // lazy singleton OFDs for default stdio
  this._watches = new Map(); // FS_WATCH: ofdId -> 'watch' OFD. size === 0 is
                             // the whole subsystem's cost gate — an
                             // unwatched system pays nothing per mutation.
  this._sockBinds = new Map(); // resolved path -> listener/bound socket ofdId
  this._kernelSockServers = new Map(); // resolved path -> onConnect(peer, pcb)
                             // — KERNEL-owned AF_UNIX endpoints (sockServe;
                             // todos/0014). Checked before _sockBinds.
  // WM surfaces (todos/WM.md). The kernel owns the scene: registry, z-order,
  // focus, input routing, kernel-chrome policy (v1 — a WM client takes over
  // placement policy in v2). The compositor (browser) and the screenshot
  // composite (headless) both read this state.
  this._surfaces = new Map(); // sid -> { sid, pid, sab, i32, u8, w, h, dstW, dstH, title, x, y, bitmap, minimized, borderless, relativeMouse, pendingConfigure, mapped, mapTimer, closeWd, parentSid, dx, dy, children, grab }
  this._nextSid = 1;
  this._zOrder = [];          // sids, bottom -> top
  this._focusSid = 0;         // written ONLY through _wmSetFocus (todos/0256,
                              // menu arch A9) — the one choke point that emits
                              // the owner FOCUS_GAINED/LOST pair + EV_FOCUS
  this._wmAnchoredN = 0;      // live anchored-child count (todos/0256) — the
                              // zero-cost fast path for the _wmZNormalize
                              // subtree post-pass on anchor-free scenes
  this._wmGrabs = [];         // active grab holders, oldest -> newest (todos/
                              // 0256, menu arch A2): while the newest holder
                              // lives, a press OUTSIDE its root's client tree
                              // dismisses it (WMEV.QUIT to the holder) and is
                              // CONSUMED — Win95 menu-mode capture. Pushed at
                              // an anchored create with flag bit 7, popped at
                              // destroy or at the dismissing press.
  this._wmGrabSwallowUp = false;  // consume the release matching a consumed
                                  // press (a click is eaten whole)
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
  this._wmKeyGrabs = null;    // installed key-grab table (GRAB_SET); null =
                              // use the built-in WM_DEFAULT_GRABS. Reset to
                              // null when the last subscriber goes (0069 valve)
  this._wmOverview = null;    // window overview / Exposé (todos/EXPOSE-MISSION-
                              // CONTROL.md): null = inactive; else { cells:
                              // [{sid,x,y,w,h}], hoverSid }. A PURE presentation
                              // override — the WM sends the cell rects
                              // (OVERVIEW_SET), the kernel composites live
                              // miniatures and routes hover/pick, and changes
                              // NO focus/z/minimize/geometry (every real state
                              // change is the WM's after the PICK). Force-ended
                              // when the last subscriber goes (the 0069 valve).
  this._wmOverviewAnims = []; // transient enter/exit fly records (todos/0063
                              // shape): [{sid, fx,fy,fw,fh, tx,ty,tw,th, t0,
                              // reverse}], browser-visual only, pruned after
                              // WM_ANIM_MS. Never read by the headless composite.
  this._wmPtrLockWanted = false;  // last wanted state emitted to the bridge
  this._wmPtrLockActive = false;  // actual lock state (bridge-reported); while
                                  // true, pointer input routes RELATIVE to the
                                  // focused relative-mouse surface (no hit-test)
  this._wmCursor = 0;             // last effective cursor shape emitted to the
                                  // bridge (todos/0105); the browser starts on
                                  // the default arrow, so 0 is the honest init
  this._wmGlassOn = false;    // Aero glass tier (todos/0063): browser-
                              // compositor-only backdrop blur behind window
                              // chrome; toggled via WMP GLASS / wmGlass().
                              // NEVER read by the headless composite.
  this._wmAnims = new Map();  // sid -> transient minimize/restore animation
                              // record (todos/0063): {kind,x,y,w,h,t0} at the
                              // moment of the transition. Browser-compositor
                              // visual only — pruned after WM_ANIM_MS, never
                              // read by the headless composite or hit test.
  this._wmLastInput = Date.now();  // last user input (todos/0096): stamped at
                                   // the wmKey/wmPointer entry — the ONLY
                                   // places all real input crosses — and read
                                   // back via GET_IDLE/wmIdleMs(). Pure
                                   // mechanism: the screensaver policy (its
                                   // timeout, the saver itself) lives in
                                   // /bin/wm, which polls this.
  // Audio mixer (todos/0017; WM.md "Audio mixing"). Streams register via
  // AUDIO_OPEN; the pump mixes them into the one output ring (audioInit).
  this._audioStreams = new Map(); // aid -> stream (see _audioRpc AUDIO_OPEN)
  this._audioGain = 1;            // master output gain (todos/0048, AUDIO_GAIN)
  this._nextAid = 1;
  this._audioOut = null;          // { sab, control, f32, cap, freq, channels }
  // HTTP transport (todos/0172). Defaults to the embedder's fetch (browser
  // worker or Node ≥18 global); opts.fetch overrides (a fake fetch in tests).
  // Passing `fetch: null` EXPLICITLY disables network — HTTP_OPEN answers
  // ENOSYS (standalone pages stay offline); omitting it uses the global.
  // NB fetch must be BOUND: browsers brand-check fetch's receiver, so calling
  // it as this._fetch(...) with the Kernel as `this` throws Illegal invocation
  // before any request (Node's undici doesn't check — the Node suite can't
  // catch this; the browser HTTP e2e does).
  this._fetch = ('fetch' in opts) ? opts.fetch
    : (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
}

Kernel.prototype._makeOfd = function (kind, extra) {
  var o = { id: this._nextOfd++, kind: kind, refs: 0 };
  if (extra) for (var k in extra) o[k] = extra[k];
  this._ofds.set(o.id, o);
  return o;
};

/* Ref an OFD for a process. For ringed pipe ends this also maintains the
 * per-end holder map (pid → fd count) that drives the SPSC mode ladder
 * (todos/0181): the moment an end gains a SECOND holder process — spawn
 * inheritance is the only event that can (the spawner is parked in the
 * spawn RPC, so the flip races nothing) — a FAST pipe demotes, finally.
 * pid 0 is the kernel pseudo-holder (the strace write-end ref): it blocks
 * promotion, keeping traced pipes brokered so every byte shows in the
 * trace (todos/0181's documented strace rule). */
Kernel.prototype._ofdRef = function (o, pid) {
  o.refs++;
  if (o.kind !== 'pipe' || !o.holders) return;
  o.holders.set(pid, (o.holders.get(pid) || 0) + 1);
  var ring = o.pipe.ring;
  if (ring && o.holders.size > 1 && Atomics.load(ring.i32, PR_MODE) === PR_FAST) {
    Atomics.store(ring.i32, PR_MODE, PR_DEMOTED);   // one-way; bytes stay in the ring
  }
};

/* Promotion check (todos/0181), run when a pipe end LOSES a holder: with
 * exactly one holder process per end (and no kernel pseudo-holder, no
 * traced holder, both ends open) the pipe is single-producer/single-
 * consumer and the holders may move bytes through the ring themselves.
 * Deliberately NOT run at create: the creator's spawns would demote the
 * fresh promotion and burn the one-way ladder — so a pipeline promotes at
 * the parent's post-spawn closes, and a same-process self-pipe (no spawn,
 * no close) stays brokered for life (documented limit). */
Kernel.prototype._pipeMaybePromote = function (pipe) {
  var ring = pipe.ring;
  if (!ring || pipe.drain || !pipe.rOpen || !pipe.wOpen) return;
  if (Atomics.load(ring.i32, PR_MODE) !== PR_LATENT) return;
  var ro = pipe.rofd, wo = pipe.wofd;
  if (!ro || !wo || ro.holders.size !== 1 || wo.holders.size !== 1) return;
  var pids = [];
  ro.holders.forEach(function (n, pid) { pids.push(pid); });
  wo.holders.forEach(function (n, pid) { pids.push(pid); });
  for (var i = 0; i < pids.length; i++) {
    var hp = this._procs.get(pids[i]);
    if (!hp || hp.trace) return;   // pid 0 (kernel) or a traced holder: stay brokered
  }
  // Waiters parked from the brokered era keep waiting — raise their end's
  // flag so the peer's first FAST commit kicks them (the flag joins the
  // waiter's flagged list for _cancelWaiter's cleanup).
  var self = this;
  var flagQueued = function (pidList, op, word) {
    for (var qi = 0; qi < pidList.length; qi++) {
      var qp = self._procs.get(pidList[qi]);
      if (qp && qp.waiter && qp.waiter.op === op && qp.waiter.pipe === pipe) {
        self._pipeFlagWait(qp.waiter, pipe, word);
      }
    }
  };
  flagQueued(pipe.readWaiters, 'piperead', PR_RWAIT);
  flagQueued(pipe.writeWaiters, 'pipewrite', PR_WWAIT);
  Atomics.store(ring.i32, PR_MODE, PR_FAST);
};

Kernel.prototype._ofdUnref = function (id, pid) {
  var o = this._ofds.get(id);
  if (!o) return;
  if (o.kind === 'pipe' && o.holders && pid !== undefined) {
    var hc = o.holders.get(pid);
    if (hc !== undefined) {
      if (hc <= 1) o.holders.delete(pid); else o.holders.set(pid, hc - 1);
    }
    if (o.refs > 1) this._pipeMaybePromote(o.pipe);   // end survives: SPSC check
  }
  if (--o.refs > 0) return;
  this._ofds.delete(id);
  if (o.kind === 'file') {
    // FS_WATCH settled write: a dirty open file description's LAST release
    // means the writer is done with it — write-then-close settles exactly
    // once here, and dup'd/spawn-inherited descriptors can't fire a
    // premature settle (strictly better than inotify's any-close-of-a-
    // write-fd IN_CLOSE_WRITE).
    if (o.dirty && this._watches.size) {
      this._watchEmit(o.path, FSW_CLOSE_WRITE, FSW_CLOSE_WRITE, false);
    }
    this._fs.close(o.bfsFd);
  }
  else if (o.kind === 'watch') this._watches.delete(o.id);
  else if (o.kind === 'http') {
    // Last release of an HTTP transfer fd (todos/0417): abort the fetch.
    // close(2), a dup'd twin's death, and _exitProcess's fd sweep all
    // funnel here — teardown needs no dedicated transfer sweep.
    this._httpDestroy(o.xfer);
  }
  else if (o.kind === 'ptm') {
    // The terminal is gone (0020): SIGHUP to the pty's fg pgroup (POSIX —
    // this is how closing the terminal window ends the session), parked
    // slave writers get EIO, slave readers drain to EOF.
    var pt = o.pty;
    pt.out.rOpen = false;
    this._pipeNotify(pt.out);
    if (pt.tty.fgPgid > 0) this._killPgid(pt.tty.fgPgid, SIG.HUP);
    pt.tty.eof(true);                            // hangup: latched EOF (0163)
  } else if (o.kind === 'tty') {
    // A pty slave gone everywhere (0020) — the system tty's std OFDs keep
    // living in _std, so only pty slaves carry o.pty here: master reads
    // see EOF once the buffered output drains.
    if (o.pty) { o.pty.out.wOpen = false; this._pipeNotify(o.pty.out); }
  }
  else if (o.kind === 'pipe') {
    // Last reference to this end anywhere in the system: the peers must
    // learn (readers see EOF, writers see EPIPE + SIGPIPE). Ringed pipes
    // ALSO latch the flag word — close is always brokered, so a FAST peer
    // discovers EOF/EPIPE at its next local ring op with zero RPCs.
    if (o.end === 'read') o.pipe.rOpen = false; else o.pipe.wOpen = false;
    if (o.pipe.ring) {
      Atomics.or(o.pipe.ring.i32, PR_FLAGS, o.end === 'read' ? PRF_RGONE : PRF_WGONE);
    }
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

/* Host-clipboard bridge (ticket #79): the embedder-side twin of CLIP_SET —
 * set (or clear: fmt 0 / empty bytes) the one system clipboard slot from
 * outside the process world, so a host clipboard can feed gucOS pastes.
 * Same one-slot last-write-wins semantics as a process commit (an in-flight
 * CLIP_SET stage is untouched — it commits over this later, as any second
 * writer would). Does NOT fire onClipboard: that hook reports process-side
 * copies TO the embedder; echoing its own write back would loop the bridge. */
Kernel.prototype.clipSet = function (fmt, bytes) {
  this._clipboard = ((fmt | 0) && bytes && bytes.length)
    ? { fmt: fmt | 0, bytes: Uint8Array.from(bytes) } : null;
};
/* The current slot ({fmt, bytes} or null) — embedder/test introspection. */
Kernel.prototype.clipGet = function () { return this._clipboard; };

/* ---- process creation ---- */

Kernel.prototype._spawn = function (parent, spec, depth) {
  var self = this;
  if (this._halted) return Promise.resolve({ errno: 'ESRCH' });
  if (!spec || typeof spec.path !== 'string') return Promise.resolve({ errno: 'EFAULT' });
  // Module cache (todos/0037, #188): compute the key BEFORE the image read,
  // in the same synchronous turn (both embedders' loadImage is sync, and fs
  // mutations arrive as whole RPC turns), so the identity the cache stores
  // is the identity the bytes were read under — no window for a concurrent
  // write or rename to slip between them. A cache hit skips loadImage
  // entirely (zero fs work per spawn): moduleKey just stat'ed the path,
  // which IS the existence check, and the key's own terms (RO-volume
  // immutability, or ino+size+mtime on a writable volume) prove the cached
  // compile still matches the file.
  var mkey = this._imageCacheKey(spec.path);
  if (mkey) {
    // One entry per path (#188): a changed file derives a NEW key — that
    // alone is what correctness rests on — and the path's previous entry
    // is dropped so recompiles replace instead of accumulate. A hardlink
    // alias still reaching the old contents just re-misses and recompiles.
    var prevKey = this._modulePathKey.get(spec.path);
    if (prevKey !== undefined && prevKey !== mkey) this._moduleCache.delete(prevKey);
    this._modulePathKey.set(spec.path, mkey);
  }
  var cached = mkey ? this._moduleCache.get(mkey) : null;
  if (cached) {
    this._moduleCacheHits++;
    return cached.then(function (module) {
      // Cached null = "uncacheable after all" (ss flavor / engine-rejected
      // bytes / no clone support): fall through to the bytes path.
      return module ? self._spawnImage(parent, spec, null, module)
        : self._spawnBytes(parent, spec, null, depth);
    });
  }
  return this._spawnBytes(parent, spec, mkey, depth);
};

/* The bytes leg of _spawn: read the image, compile-and-cache when mkey says
 * it's immutable, then hand off. A `#!` image re-dispatches to its
 * interpreter instead (todos/0065); `depth` counts those hops. */
Kernel.prototype._spawnBytes = function (parent, spec, mkey, depth) {
  var self = this;
  return Promise.resolve(this._loadImage(spec.path)).then(function (image) {
    if (!image) return { errno: 'ENOENT' };
    var u8 = image instanceof Uint8Array ? image : new Uint8Array(image);
    if (u8.length >= 2 && u8[0] === 0x23 && u8[1] === 0x21) {   // "#!"
      return self._spawnShebang(parent, spec, u8, depth | 0);
    }
    return self._moduleFor(mkey, image).then(function (module) {
      return self._spawnImage(parent, spec, image, module);
    });
  });
};

/* Shebang exec (todos/0065): a text image starting "#!" runs its interpreter
 * line, Unix-style — `./foo` and a desktop double-click work on shell
 * scripts with no explicit `sh`. The interpreter line is `#!` + path + at
 * most ONE optional argument (the rest of the line verbatim, per Linux — no
 * word splitting), capped at SHEBANG_MAX bytes. The re-dispatched argv is
 * [interp, optarg?, scriptPath, ...origArgv[1:]] (the script path replaces
 * the caller's argv[0], per execve(2)); everything else in the spec — envp,
 * cwd, fd actions, pgroup flags — carries over unchanged, so the
 * interpreter lands exactly where the script would have. Depth caps a
 * script→script→… chain. The errno stays ENOEXEC where Linux reports ELOOP:
 * that started as a libc gap (no ELOOP in <errno.h>) but is now a deliberate,
 * asserted divergence — todos/0340 added `#define ELOOP 40`, and the contract
 * is pinned by test_kernel.js's 'shebang cycle -> ENOEXEC';
 * non-`#!` bytes never reach here, so WASM binaries are untouched. */
var SHEBANG_MAX = 256;        // interpreter-line budget (Linux BINPRM_BUF_SIZE)
var SHEBANG_MAX_DEPTH = 4;    // interpreter-is-itself-a-script hops

Kernel.prototype._spawnShebang = function (parent, spec, u8, depth) {
  if (depth >= SHEBANG_MAX_DEPTH) return Promise.resolve({ errno: 'ENOEXEC' });
  var end = -1;
  var lim = Math.min(u8.length, SHEBANG_MAX);
  for (var i = 2; i < lim; i++) { if (u8[i] === 10) { end = i; break; } }
  if (end < 0) return Promise.resolve({ errno: 'ENOEXEC' });  // no newline in budget
  var line = '';
  for (var j = 2; j < end; j++) line += String.fromCharCode(u8[j]);
  line = line.replace(/\r$/, '').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (!line) return Promise.resolve({ errno: 'ENOEXEC' });    // "#!\n"
  var sp = line.search(/[ \t]/);
  var interp = sp < 0 ? line : line.slice(0, sp);
  var optarg = sp < 0 ? '' : line.slice(sp).replace(/^[ \t]+/, '');
  // A relative interpreter resolves against the CHILD's cwd (the lookup the
  // spec's cwd implies); shebang interpreters are conventionally absolute.
  if (interp.charCodeAt(0) !== 47) {
    var cwd = (spec.cwd !== null && spec.cwd !== undefined) ? spec.cwd
      : (parent ? parent.cwd : '/');
    interp = (cwd === '/' ? '' : cwd) + '/' + interp;
  }
  var argv = [interp];
  if (optarg) argv.push(optarg);
  argv.push(spec.path);
  var orig = spec.argv;
  if (orig && orig.length > 1) argv = argv.concat(orig.slice(1));
  var nspec = Object.assign({}, spec, { path: interp, argv: argv });
  return this._spawn(parent, nspec, (depth | 0) + 1);
};

/* moduleKey through the kernel fs, or null (no fs / fs without the hook /
 * an uncacheable path). Never throws — an fs error just means "don't
 * cache". */
Kernel.prototype._imageCacheKey = function (path) {
  if (!this._fs || typeof this._fs.moduleKey !== 'function') return null;
  try { return this._fs.moduleKey(path); } catch (e) { return null; }
};

/* Resolve a spawn image to a shippable pre-compiled Module, or null (keep
 * the bytes path). Cache-hit or compile-once per moduleKey; the cached
 * Promise dedupes racing spawns of the same binary. ss-flavored modules are
 * excluded (runModule recompiles them from bytes with importedStringConstants
 * — see runSsModule), as are tiers where Modules don't structured-clone. */
Kernel.prototype._moduleFor = function (mkey, image) {
  if (!mkey) return Promise.resolve(null);
  var cached = this._moduleCache.get(mkey);
  if (cached) { this._moduleCacheHits++; return cached; }
  this._moduleCacheMisses++;
  var self = this;
  var bytes = image instanceof Uint8Array ? image : new Uint8Array(image);
  // Compile options MUST MATCH host.js runModule's.
  var p = WebAssembly.compile(bytes, { builtins: ['js-string'], importedStringConstants: '#' }).then(function (mod) {
    if (WebAssembly.Module.imports(mod).some(function (i) { return i.module === 'ss'; })) {
      return null;   // ss flavor: bytes path (cached null — no re-probing)
    }
    if (self._moduleCloneOk === undefined) {
      if (typeof structuredClone === 'function') {
        try { structuredClone(mod); self._moduleCloneOk = true; }
        catch (e) { self._moduleCloneOk = false; }
      } else {
        self._moduleCloneOk = true;   // no probe available; postMessage decides
      }
    }
    return self._moduleCloneOk ? mod : null;
  }, function (e) {
    // A binary the engine rejects: ship bytes and let the process worker
    // surface the real compile error to its own caller.
    self._log('module cache: compile failed for ' + mkey + ': ' + (e && e.message));
    return null;
  });
  this._moduleCache.set(mkey, p);
  return p;
};

Kernel.prototype.moduleCacheStats = function () {
  return {
    entries: this._moduleCache.size,
    hits: this._moduleCacheHits,
    misses: this._moduleCacheMisses,
  };
};

/* The tail of _spawn once the image — and, on a cache hit, its pre-compiled
 * Module — is in hand: pid allocation, fd inheritance, worker creation. */
Kernel.prototype._spawnImage = function (parent, spec, image, module) {
  var self = this;
  // strace (0046) needs the kernel-owned fd layer (the trace sink is a pipe
  // OFD); a no-fs kernel fails the request loudly rather than not tracing.
  if (typeof spec.trace === 'number' && spec.trace >= 0 && !self._brokered) {
    return { errno: 'ENOSYS' };
  }
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
    // Identity for /proc (todos/0043): comm/cmdline render from these;
    // startMs backs stat field 22 (start_time) and ps -l's STIME/ELAPSED.
    path: spec.path,
    argv: (spec.argv && spec.argv.length) ? spec.argv.slice() : [spec.path],
    startMs: Date.now(),
    exit: 0,                       // wait-status once ZOMBIE
    pendingStop: 0,                // stop signal not yet reported via WUNTRACED
    pendingCont: false,            // continue not yet reported via WCONTINUED
    children: new Set(),
    envp: spec.envp !== null && spec.envp !== undefined ? spec.envp
      : (parent ? parent.envp : []),
    cwd: spec.cwd !== null && spec.cwd !== undefined ? spec.cwd
      : (parent ? parent.cwd : '/'),
    sigdisp: new Int8Array(NSIG),  // __on_sigdisp mirror; all DFL initially
    itimer: null,                  // ITIMER_REAL (todos/0044): {expiresAt, intervalMs, timer}
                                   // — not inherited (POSIX), cleared at exit
    // ONE deferred RPC at a time (the worker is parked):
    // {op:'wait',sel,options} | {op:'ttyread',count} | {op:'select',r,w,timer}
    // | {op:'piperead',pipe,count} | {op:'pipewrite',pipe,data}
    // | {op:'clipget'} (the clipboard seam: parked on onClipRead's done)
    waiter: null,
    fds: new Map(),                // procFd -> ofdId (brokered mode)
    dirRpc: null,                  // cursor -> {dh, pending} parked FS_OPENDIR
                                   // pages mid-drain (todos/0241)
    dirRpcNext: 1,
    page: null, i32: null, u8: null,
    worker: null,
    tty: self._tty,                // v1: the one system tty (or null)
    surfaces: new Set(),           // sids owned by this process (WM.md)
    wmRing: null,                  // input ring: { i32, f32, cap }
    wantFrame: false,              // compositor pin (todos/0169): set on the
                                   // want-frame doorbell, cleared ONLY by
                                   // frame-idle (pumpWait entry) and exit
    _wmPendingFb: null,            // SAB from 'wm-sabs' awaiting SURFACE_CREATE
    audios: new Set(),             // aids owned by this process (todos/0017)
    _audioPendingSab: null,        // SAB from 'audio-sab' awaiting AUDIO_OPEN
    _httpStage: null,              // staged request body awaiting HTTP_OPEN
    trace: null,                   // strace (0046): { ofdId, pipe, follow, drops, cur }
  };
  var sab = new SharedArrayBuffer(KP_SIZE);
  pcb.page = sab;
  pcb.i32 = new Int32Array(sab);
  pcb.u8 = new Uint8Array(sab);
  // Advertise the vsync source (todos/0100) before the worker exists —
  // host.js reads the flag once at SDL-backend construction.
  if (self._vsync) Atomics.store(pcb.i32, KP_VSYNC_EN, 1);
  // Spawn-while-parked (todos/0169, the KP_VSYNC_EN precedent): stamp the
  // parked flag so the new process's first present/vsync-arm rings the
  // doorbell instead of trusting a page word that was never written. Spawn
  // and the compositor's park run on the same worker thread, so the stamp
  // can't race a park loop mid-iteration.
  if (self._compParked) Atomics.store(pcb.i32, KP_COMP_PARKED, 1);
  // vDSO block (todos/0179): publish before the worker exists so the first
  // process-side read never sees the zero-filled page.
  self._vdsoPublish(pcb);

  // Brokered fd table: full POSIX inheritance (every parent fd, sharing
  // the open file descriptions), then the spawn file_actions in order.
  // The kernel IS the parent's fd table, so no translation is needed —
  // the payoff of the fd/data-plane amendment.
  if (self._brokered) {
    var inherit = parent ? parent.fds : null;
    if (inherit) {
      inherit.forEach(function (ofdId, fd) {
        var o = self._ofds.get(ofdId);
        if (o) { self._ofdRef(o, pid); pcb.fds.set(fd, ofdId); }
      });
    } else {
      var std = self._stdOfds();
      std.in_.refs++; pcb.fds.set(0, std.in_.id);
      std.out.refs++; pcb.fds.set(1, std.out.id);
      std.err.refs++; pcb.fds.set(2, std.err.id);
    }
    // strace (todos/0046): spec.trace names a pipe WRITE end in the PARENT's
    // fd table (host.js only forwards it under spawn flags bit1, so old
    // binaries with the 32-byte spec can't set it by accident). The kernel
    // takes its own ref — the tracer's read end sees EOF exactly at tracee
    // teardown. flags bit2 = follow: descendants inherit the same pipe and
    // every line gets a [pid N] prefix. Attached BEFORE the fd-actions run
    // (todos/0181): an action-close can shrink a pipe end to single-holder
    // and fire the SPSC promotion check — the kernel pseudo-holder ref must
    // already be there so a traced pipe never even transiently promotes.
    if (typeof spec.trace === 'number' && spec.trace >= 0) {
      var trId = parent ? parent.fds.get(spec.trace | 0) : undefined;
      var trO = trId === undefined ? null : self._ofds.get(trId);
      if (!trO || trO.kind !== 'pipe' || trO.end !== 'write') {
        pcb.fds.forEach(function (id) { self._ofdUnref(id, pid); });
        return { errno: 'EBADF' };
      }
      self._ofdRef(trO, 0);   // kernel pseudo-holder: a traced pipe never promotes
      pcb.trace = { ofdId: trO.id, pipe: trO.pipe,
                    follow: (spec.flags & 4) !== 0, drops: 0, cur: null };
    } else if (parent && parent.trace && parent.trace.follow) {
      self._ofdRef(self._ofds.get(parent.trace.ofdId), 0);
      pcb.trace = { ofdId: parent.trace.ofdId, pipe: parent.trace.pipe,
                    follow: true, drops: 0, cur: null };
    }
    var actions = spec.actions || [];
    for (var ai = 0; ai < actions.length; ai++) {
      var a = actions[ai];
      var fail = null;
      if (a.op === 0) {           // DUP2: child fd `arg` -> child fd `fd`
        var srcId = pcb.fds.get(a.arg);
        if (srcId === undefined) fail = 'EBADF';
        else {
          self._ofdRef(self._ofds.get(srcId), pid);
          var oldId = pcb.fds.get(a.fd);
          if (oldId !== undefined) self._ofdUnref(oldId, pid);
          pcb.fds.set(a.fd, srcId);
        }
      } else if (a.op === 1) {    // OPEN path at fd (arg = oflag)
        var aAbs = self._pathFor(pcb, a.path);
        var aExisted = true;
        if (self._watches.size && (a.arg & 0x40)) aExisted = self._fs.stat(aAbs) !== null;
        var bfsFd = self._fs.open(aAbs, a.arg | 0, a.mode | 0);
        if (bfsFd === null) fail = self._fs._lastError || 'EIO';
        else {
          // FS_WATCH: a shell redirect (`cmd > file`) is a write like any
          // other — record the path and the truncate/create dirty bit so
          // the close settles (same rules as the FS_OPEN arm).
          var no = self._makeOfd('file', { bfsFd: bfsFd, path: aAbs,
                                           accmode: a.arg & 3 });   // todos/0376
          if ((a.arg & 0x200) || !aExisted) no.dirty = true;
          if (!aExisted) self._watchEmit(aAbs, FSW_CREATE, FSW_CREATE, false);
          no.refs++;
          var prevId = pcb.fds.get(a.fd);
          if (prevId !== undefined) self._ofdUnref(prevId, pid);
          pcb.fds.set(a.fd, no.id);
        }
      } else if (a.op === 2) {    // CLOSE
        var cId = pcb.fds.get(a.fd);
        if (cId !== undefined) { self._ofdUnref(cId, pid); pcb.fds.delete(a.fd); }
      } else if (a.op === 3) {    // CLOSEFROM: drop every child fd >= a.fd
        // posix_spawn_file_actions_addclosefrom_np. The whole point is that
        // the caller does NOT know which fds are open — only the fd-table
        // owner does, which is exactly this side. Enumerate first, then
        // mutate: pcb.fds is being edited underneath the walk.
        var cfDrop = [];
        pcb.fds.forEach(function (id, fd) { if (fd >= a.fd) cfDrop.push(fd); });
        for (var cfi = 0; cfi < cfDrop.length; cfi++) {
          self._ofdUnref(pcb.fds.get(cfDrop[cfi]), pid);
          pcb.fds.delete(cfDrop[cfi]);
        }
      }
      if (fail) {
        pcb.fds.forEach(function (id) { self._ofdUnref(id, pid); });
        // The trace ref attached above (pre-actions since todos/0181) is
        // not in pcb.fds — release it or the kernel's write-end ref leaks.
        if (pcb.trace) { self._ofdUnref(pcb.trace.ofdId, 0); pcb.trace = null; }
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
  // SPSC pipe rings (todos/0181): every ringed pipe fd in the child's
  // FINAL table (post-actions) ships its ring SAB, whatever the current
  // mode — the PR_MODE word, not process-local knowledge, gates fast ops,
  // so a pipe promoted AFTER this spawn (the parent's closes) just starts
  // moving bytes locally.
  var pipeRings = null;
  if (self._brokered) {
    pcb.fds.forEach(function (ofdId, fd) {
      var po = self._ofds.get(ofdId);
      if (po && po.kind === 'pipe' && po.pipe.ring) {
        (pipeRings = pipeRings || []).push({ fd: fd, end: po.end, sab: po.pipe.ring.sab });
      }
    });
  }
  var procSpec = {
    pid: pid, ppid: pcb.ppid, pgid: pcb.pgid,
    path: spec.path,
    argv: pcb.argv,
    envp: pcb.envp,
    cwd: pcb.cwd,
    actions: spec.actions || [],   // brokered: already applied kernel-side above
    flags: spec.flags | 0,
    // Cache hit ships the Module and DROPS the bytes (they'd be a dead
    // multi-MB clone per spawn — runModule never touches bytes when a
    // pre-compiled C module arrives).
    image: module ? null : image,
    module: module || null,
    kernelPage: sab,
    ttySab: pcb.tty ? pcb.tty.sab : null,
    brokered: self._brokered,
    ro: self._roImage,   // process-side read-only volume (todos/0180)
    pipeRings: pipeRings,   // SPSC pipe rings for inherited fds (todos/0181)
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
};

/* ---- worker message handling ---- */

Kernel.prototype._onWorkerMessage = function (pcb, msg) {
  // STOPPED still accepts messages: a krpc/exit can race the stop, and
  // dropping the krpc would deadlock the parked worker awaiting a response.
  if (!msg || pcb.state === STATE_ZOMBIE) return;
  switch (msg.type) {
    case 'krpc': this._dispatchRpc(pcb); break;
    // A parked interruptible RPC (WAIT / tty FS_READ / FS_SELECT / the
    // unified FS_WAIT / pipe FS_READ/FS_WRITE) noticed a deliverable
    // signal: answer EINTR if it's still registered. If the real
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
    // SPSC pipe ring (todos/0181): precedes its PIPE_CREATE, same handshake.
    case 'pipe-sab':
      if (msg.sab) pcb._pipePendingSab = msg.sab;
      break;
    case 'wm-frame': this._wmFrame(pcb, msg.sid | 0, msg.bmp); break;
    // On-demand compositor doorbells (todos/0169): want-frame = this pcb
    // presented / armed a vsync wait while the compositor was parked —
    // pin it awake (hard state, never heuristic) and wake it; frame-idle =
    // host.js's pumpWait entry, the app is back to waiting on events.
    case 'want-frame':
      pcb.wantFrame = true;
      if (this._onWmDamage) this._onWmDamage();
      break;
    case 'frame-idle': pcb.wantFrame = false; break;
    case 'exited': this._exitProcess(pcb, W_EXITCODE(msg.code | 0)); break;
    case 'crashed':
      this._log('pid ' + pcb.pid + ' crashed: ' + msg.error);
      this._exitProcess(pcb, W_TERMSIG(SIG.SEGV));
      break;
    default: this._log('pid ' + pcb.pid + ': unknown message ' + msg.type);
  }
};

/* ---- strace (todos/0046): per-pid syscall-RPC trace ----
 * pcb.trace = { ofdId, pipe, follow, drops, cur } — attached at spawn from
 * spec.trace (a pipe WRITE end in the parent's fd table; the kernel holds
 * its own ref until exit, so the tracer reading the other end sees EOF
 * exactly when the tracee is gone). Every RPC appends one decoded line:
 * the request formats at dispatch (pcb.trace.cur), the line lands at
 * response time — deferred RPCs (parked reads/waits) trace at completion.
 * With the flag off the cost is one falsy check per dispatch/respond. */
Kernel.prototype._traceLine = function (pcb, line, force) {
  var tr = pcb.trace;
  var pipe = tr.pipe;
  if (!pipe.rOpen || !pipe.wOpen) return;     // tracer gone: stop emitting
  // The kernel must never block: a full pipe (tracer not draining) drops
  // the line and says so at exit rather than growing without bound. The
  // exit markers ride `force` — bounded, and the drop notice must not
  // itself drop.
  if (!force && this._pipeAvail(pipe) > pipe.cap) { tr.drops++; return; }
  if (tr.follow) line = '[pid ' + pcb.pid + '] ' + line;
  var bytes = textEncoder.encode(line + '\n');
  if (pipe.ring) {
    // A ring is a hard cap (the JS buf could overshoot for `force` lines):
    // truncate the final markers rather than corrupt the ring. Trace pipes
    // never promote (the kernel's write-end ref is a pseudo-holder), so
    // this stays the kernel's single-producer lane.
    var rfree = this._pipeFree(pipe);
    if (bytes.length > rfree) {
      if (!force) { tr.drops++; return; }
      bytes = bytes.subarray(0, rfree);
    }
    if (bytes.length) pipeRingPut(pipe.ring, bytes);
  } else {
    for (var i = 0; i < bytes.length; i++) pipe.buf.push(bytes[i]);
  }
  this._pipeNotify(pipe);
};

Kernel.prototype._traceRpc = function (pcb, resp, rawBytes) {
  var cur = pcb.trace.cur;
  pcb.trace.cur = null;
  this._traceLine(pcb, cur.name + '(' + cur.args + ') = ' + traceResult(resp, rawBytes));
};

/* Final trace lines + the kernel's write-end ref release (=> reader EOF).
 * Runs once per traced pcb, from _exitProcess. */
Kernel.prototype._traceExit = function (pcb, status) {
  var tr = pcb.trace;
  var cur = tr.cur;
  tr.cur = null;
  if (cur) {
    // EXIT never gets a response by design; anything else died mid-RPC.
    this._traceLine(pcb, cur.name + '(' + cur.args + ')' +
      (cur.name === 'EXIT' ? '' : ' = <unfinished>'), true);
  }
  if (tr.drops) {
    this._traceLine(pcb, '+++ ' + tr.drops + ' trace lines dropped (pipe full) +++', true);
  }
  if (W_TERMSIG(status) !== 0 && (status & 0xff) !== 0x7f) {
    this._traceLine(pcb, '+++ killed by ' +
      (SIG_NAMES[W_TERMSIG(status)] || 'signal ' + W_TERMSIG(status)) + ' +++', true);
  } else {
    this._traceLine(pcb, '+++ exited with ' + ((status >> 8) & 0xff) + ' +++', true);
  }
  pcb.trace = null;
  this._ofdUnref(tr.ofdId, 0);
};

Kernel.prototype._respond = function (pcb, resp) {
  if (pcb.trace && pcb.trace.cur) this._traceRpc(pcb, resp, null);
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
  if (pcb.trace) {
    // Args format NOW (RAW payloads alias the kernel page); the line lands
    // when the response does — see _traceRpc.
    pcb.trace.cur = {
      name: OP_NAMES[op] || '0x' + op.toString(16),
      args: traceArgs(op, req),
    };
  }
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
      this._vdsoPublish(pcb);
      this._respond(pcb, { sid: pcb.sid });
      break;
    case OP.GETSID: {
      var tSid = (req.pid | 0) === 0 ? pcb : this._procs.get(req.pid | 0);
      this._respond(pcb, tSid ? { sid: tSid.sid } : { errno: 'ESRCH' });
      break;
    }
    // Interval timers (todos/0044): pure kernel-side bookkeeping over the
    // existing SIGPEND delivery machinery.
    case OP.SETITIMER:
      this._respond(pcb, this._setitimer(pcb, req.which | 0, req.valueMs | 0, req.intervalMs | 0));
      break;
    case OP.GETITIMER:
      this._respond(pcb, (req.which | 0) !== ITIMER_REAL ? { errno: 'EINVAL' }
        : this._itimerRemaining(pcb));
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
      // SPSC ring (todos/0181): the creator posts the ring SAB immediately
      // before this RPC ({type:'pipe-sab'} — the audio-sab handshake; the
      // kernel can't hand an SAB to a parked worker). A ringed pipe keeps
      // its bytes in the ring in every mode; no SAB (fake workers, old
      // embedders) = the JS buf and permanent brokered service.
      var prSab = pcb._pipePendingSab || null;
      pcb._pipePendingSab = null;
      if (prSab && prSab.byteLength > PIPE_RING_HDR) {
        pipe.ring = pipeRingViews(prSab);
        pipe.cap = pipe.ring.cap;
      }
      var ro = this._makeOfd('pipe', { pipe: pipe, end: 'read', holders: new Map() });
      var wo = this._makeOfd('pipe', { pipe: pipe, end: 'write', holders: new Map() });
      pipe.rofd = ro; pipe.wofd = wo;   // the promotion check reads both ends
      this._ofdRef(ro, pcb.pid); this._ofdRef(wo, pcb.pid);
      var rfd = 0; while (pcb.fds.has(rfd)) rfd++;
      pcb.fds.set(rfd, ro.id);
      var wfd = 0; while (pcb.fds.has(wfd)) wfd++;
      pcb.fds.set(wfd, wo.id);
      this._respond(pcb, { rfd: rfd, wfd: wfd });
      break;
    }
    case OP.PIPE_KICK: {
      // The SPSC doorbell (todos/0181): a fast end committed a ring op
      // while the peer's parked flag was up — re-serve parked waiters and
      // rescan selects. {epipe:1} = the caller hit PRF_RGONE locally and
      // wants its own SIGPIPE (deliver BEFORE responding so the pending
      // bit is up when the write's import returns — brokered ordering).
      var ko = null;
      var kid = pcb.fds.get(req.fd | 0);
      if (kid !== undefined) ko = this._ofds.get(kid);
      if (!ko || ko.kind !== 'pipe') { this._respond(pcb, { errno: 'EBADF' }); break; }
      if (req.epipe) this._deliver(pcb, SIG.PIPE);
      this._respond(pcb, {});
      this._pipeNotify(ko.pipe);
      break;
    }
    case OP.CLIP_SET: {
      // RAW request [u32 fmt][u32 last][u32 off][bytes...] (see the OP
      // table). off 0 opens a fresh per-pcb staging buffer; each chunk must
      // land exactly at the staged length; last commits to the one slot.
      var cs = req.raw;
      if (!cs || cs.length < 12) { this._respond(pcb, { errno: 'EFAULT' }); break; }
      var cdv = new DataView(cs.buffer, cs.byteOffset, cs.length);
      var cfmt = cdv.getUint32(0, true);
      var clast = cdv.getUint32(4, true);
      var coff = cdv.getUint32(8, true);
      if (coff === 0) pcb.clipStage = { fmt: cfmt, parts: [], len: 0 };
      var stage = pcb.clipStage;
      if (!stage || stage.fmt !== cfmt || coff !== stage.len) {
        pcb.clipStage = null;
        this._respond(pcb, { errno: 'EINVAL' });
        break;
      }
      var cbytes = cs.subarray(12);              // readPayload copied already
      if (cbytes.length) { stage.parts.push(cbytes); stage.len += cbytes.length; }
      if (clast) {
        var joined = new Uint8Array(stage.len);
        for (var cpi = 0, cpo = 0; cpi < stage.parts.length; cpi++) {
          joined.set(stage.parts[cpi], cpo);
          cpo += stage.parts[cpi].length;
        }
        // fmt 0 (or an empty commit) clears the slot — EmptyClipboard.
        this._clipboard = (cfmt && joined.length) ? { fmt: cfmt, bytes: joined } : null;
        pcb.clipStage = null;
      }
      this._respond(pcb, {});
      // Host-clipboard bridge (ticket #79): report the commit AFTER the
      // reply — the copying process is never held hostage by the mirror.
      if (clast && this._onClipboard) this._onClipboard(this._clipboard);
      break;
    }
    case OP.CLIP_GET: {
      // JSON {fmt, off, peek} -> RAW [i32 total][chunk]; total -1 =
      // unavailable. peek 1 (SDL_HasClipboardText / fo_clip_has — menu
      // graying, Paste gates) ALWAYS serves the cached slot: an
      // availability probe must never trigger a host clipboard read (on
      // iOS that would raise the paste callout per menu open). A DATA read
      // at off 0 defers through onClipRead when the embedder registered
      // one — see the hook comment in the ctor; chunk continuations
      // (off > 0) never re-refresh mid-read.
      var gfmt = req.fmt | 0, goff = req.off | 0;
      if (this._onClipRead && !req.peek && goff === 0) {
        var cw = { op: 'clipget' };
        pcb.waiter = cw;
        var cself = this;
        var cdone = function () {
          // The waiter re-check every deferred service does: the process
          // may have exited while parked (waiter dropped at _exitProcess),
          // and a buggy embedder may call done twice.
          if (pcb.waiter !== cw) return;
          cself._cancelWaiter(pcb);
          cself._clipServe(pcb, gfmt, goff);
        };
        // The consumer's pid rides along (#562): the embedder's freshness
        // window is per-CONSUMER — a size-then-read pair from one process
        // shares one refresh, while a DIFFERENT process's first read always
        // re-reads the host clipboard (first paste fresh by construction).
        try { this._onClipRead(cdone, pcb.pid); }
        catch (e) {
          this._log('onClipRead threw: ' + (e && e.message));
          cdone();   // never wedge the parked reader on a broken hook
        }
        break;
      }
      this._clipServe(pcb, gfmt, goff);
      break;
    }
    case OP.EGRESS: {
      this._egress(pcb, req.raw || null);
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
      if ((op & 0xff00) === 0x0600) { this._httpRpc(pcb, op, req); break; }
      if ((op & 0xf000) === 0x1000) { this._wmRpc(pcb, op, req); break; }
      if ((op & 0xf000) === 0x2000) { this._audioRpc(pcb, op, req); break; }
      this._respond(pcb, { errno: 'ENOSYS' });
  }
};

/* Serve a CLIP_GET reply from the slot as it stands NOW — the shared tail
 * of the synchronous path and the deferred-refresh resume. */
Kernel.prototype._clipServe = function (pcb, gfmt, goff) {
  var clip = this._clipboard;
  var total = (clip && clip.fmt === gfmt) ? clip.bytes.length : -1;
  var chunk = (total > 0 && goff >= 0 && goff < total)
    ? clip.bytes.subarray(goff, goff + Math.min(total - goff, KP_PAYLOAD_CAP - 4))
    : new Uint8Array(0);
  var gresp = new Uint8Array(4 + chunk.length);
  new DataView(gresp.buffer).setInt32(0, total, true);
  gresp.set(chunk, 4);
  this._respondRaw(pcb, gresp);
};

/* ---- Egress (todos/0398): the OP.EGRESS materializer + store-only zip ----
 * The wire carries paths; bytes exist only on the kernel->embedder leg. The
 * whole flow is synchronous inside one dispatch turn (OPFS SyncAccessHandle
 * reads are sync in the kernel worker; EGRESS_MAX bounds the blocked time),
 * so the pre-read lstat walk and the read phase cannot race a mutation. */

var EGRESS_MAX = 256 * 1024 * 1024;   // lstat-summed refusal cap, decided
                                      // BEFORE any byte is read (EFBIG). 2x
                                      // the DROP_MAX ingress precedent: a zip
                                      // of a seeded game dir plausibly tops
                                      // 128 MB. If mobile memory pressure
                                      // ever bites, this constant moves — no
                                      // wire change (todos/0398 design).
var EG_REQ_MAX = 8192 + 16;           // os/egress.h EG_MAX path-list cap plus
                                      // the disposition header word (E2BIG)
var EG_ZIP_MAX_ENTRIES = 65535;       // the pre-zip64 EOCD u16 entry count —
                                      // more entries can't be represented, so
                                      // refuse as EFBIG rather than truncate

/* Abort the walk with an errno (caught at the _egress dispatch). */
function egErr(errno) {
  var e = new Error('egress: ' + errno);
  e.egErrno = errno;
  throw e;
}

/* Artifact naming: dropFile's basename/control-strip sanitize (see
 * kernel-worker.js), inverted for the host direction. */
function egName(p) {
  var name = String(p || '').split('/').pop()
    .replace(/[\x00-\x1f\x7f]/g, '').trim();
  return (!name || name === '.' || name === '..') ? 'egress' : name;
}

/* CRC-32 (the zip polynomial), table built on first use. */
var CRC32_TAB = null;
function crc32(bytes) {
  if (!CRC32_TAB) {
    CRC32_TAB = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC32_TAB[n] = c;
    }
  }
  var crc = -1;
  for (var i = 0; i < bytes.length; i++)
    crc = CRC32_TAB[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/* MS-DOS date/time pair from epoch seconds (UTC — deterministic across
 * hosts); the format starts at 1980, earlier stamps clamp to 1980-01-01. */
function egDosStamp(sec) {
  var d = new Date((sec || 0) * 1000);
  if (d.getUTCFullYear() < 1980) return { date: (1 << 5) | 1, time: 0 };
  return {
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
}

/* Store-only zip writer. entries: [{name, mode, mtime, data}] — a name
 * ending '/' is a directory entry (empty data), a symlink entry's data is
 * its target (the Info-ZIP convention: Unix mode in the central directory's
 * external attributes, S_IFLNK marks the entry — macOS and Linux unzip both
 * restore it as a link). Deflate would be an INTERNAL upgrade here — the
 * wire and the onEgress hook shape would not change (todos/0398 design). */
function zipStore(entries) {
  var locParts = [], cenParts = [], offset = 0;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var nameBytes = textEncoder.encode(e.name);
    var data = e.data || new Uint8Array(0);
    var crc = crc32(data);
    var stamp = egDosStamp(e.mtime);
    var isDir = e.name.charCodeAt(e.name.length - 1) === 0x2f;
    var loc = new Uint8Array(30 + nameBytes.length);
    var lv = new DataView(loc.buffer);
    lv.setUint32(0, 0x04034b50, true);        // local file header
    lv.setUint16(4, 20, true);                // version needed
    lv.setUint16(6, 0x0800, true);            // flags: UTF-8 names
    lv.setUint16(8, 0, true);                 // method: store
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);      // csize == usize (store)
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);                // extra len
    loc.set(nameBytes, 30);
    var cen = new Uint8Array(46 + nameBytes.length);
    var cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);        // central directory header
    cv.setUint16(4, 0x031E, true);            // made by: Unix, spec 3.0
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    // extra/comment/disk/internal-attr words stay 0
    // External attrs: the Unix mode word high, the DOS dir bit low.
    cv.setUint32(38, ((e.mode >>> 0) << 16 | (isDir ? 0x10 : 0)) >>> 0, true);
    cv.setUint32(42, offset, true);           // local header offset
    cen.set(nameBytes, 46);
    locParts.push(loc, data);
    cenParts.push(cen);
    offset += loc.length + data.length;
  }
  var cenSize = 0;
  for (var c2 = 0; c2 < cenParts.length; c2++) cenSize += cenParts[c2].length;
  var eocd = new Uint8Array(22);
  var ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);      // entries this disk
  ev.setUint16(10, entries.length, true);     // entries total
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);             // central dir offset
  var out = new Uint8Array(offset + cenSize + 22);
  var pos = 0;
  for (var p1 = 0; p1 < locParts.length; p1++) { out.set(locParts[p1], pos); pos += locParts[p1].length; }
  for (var p2 = 0; p2 < cenParts.length; p2++) { out.set(cenParts[p2], pos); pos += cenParts[p2].length; }
  out.set(eocd, pos);
  return out;
}

Kernel.prototype._egress = function (pcb, raw) {
  // ENOSYS is decided FIRST: no embedder hook (or no kernel fs) means
  // egress has no host side at all — fail loud, never half-accept.
  if (!this._onEgress || !this._fs) { this._respond(pcb, { errno: 'ENOSYS' }); return; }
  if (!raw || !raw.length) { this._respond(pcb, { errno: 'EINVAL' }); return; }
  if (raw.length > EG_REQ_MAX) { this._respond(pcb, { errno: 'E2BIG' }); return; }
  var lines = textDecoder.decode(raw).split('\n');
  var dispo = lines[0];
  // 'clipboard' stays RESERVED (see the OP table) — EINVAL until the web
  // platform grows a file-flavored clipboard write.
  if (dispo !== 'download' && dispo !== 'saveas') { this._respond(pcb, { errno: 'EINVAL' }); return; }
  var paths = [];
  for (var i = 1; i < lines.length; i++) {
    if (lines[i] === '') continue;                 // trailing newline
    if (lines[i].charCodeAt(0) !== 0x2f) { this._respond(pcb, { errno: 'EINVAL' }); return; }
    paths.push(lines[i]);
  }
  if (paths.length === 0) { this._respond(pcb, { errno: 'EINVAL' }); return; }
  var art;
  try { art = this._egressMaterialize(paths); }
  catch (e) {
    if (!e || !e.egErrno) this._log('egress materialize threw: ' + (e && e.message));
    this._respond(pcb, { errno: (e && e.egErrno) || 'EIO' });
    return;
  }
  // The artifact is handed over BEFORE the reply: errno 0 means "accepted,
  // materialized, AND delivered to the embedder". Only the page-side act
  // itself can fail later (a blocked download), and the page logs that.
  try { this._onEgress(dispo, art.name, art.bytes); }
  catch (e2) {
    this._log('onEgress threw: ' + (e2 && e2.message));
    this._respond(pcb, { errno: 'EIO' });
    return;
  }
  this._respond(pcb, {});
};

/* Whole-file read on the kernel-side fs (size known from the pre-read walk;
 * same dispatch turn, so the size cannot have moved). */
Kernel.prototype._egressReadFile = function (abs, size) {
  var fs = this._fs;
  var fd = fs.open(abs, 0, 0);
  if (fd === null) egErr(fs._lastError || 'EIO');
  var buf = new Uint8Array(size), off = 0;
  while (off < buf.length) {
    var n = fs.read(fd, buf.subarray(off), buf.length - off);
    if (n === null) { fs.close(fd); egErr(fs._lastError || 'EIO'); }
    if (n === 0) break;
    off += n;
  }
  fs.close(fd);
  return off === buf.length ? buf : buf.subarray(0, off);
};

/* Walk one root into zip-entry METADATA — lstat-driven, no file bytes yet
 * (EFBIG comes from summed lstat sizes before any read). Symlinks inside a
 * tree are preserved as symlink ENTRIES (fo_copy's copy-as-link, os/
 * fileops.h, carried across the boundary); directories get explicit
 * entries so empty ones survive; entry order is sorted for deterministic
 * zip bytes. */
Kernel.prototype._egressWalk = function (abs, zipPath, list, state) {
  var fs = this._fs;
  var st = fs.lstat(abs);
  if (st === null) egErr(fs._lastError || 'ENOENT');
  var fmt = st.mode & 0o170000;
  if (list.length >= EG_ZIP_MAX_ENTRIES) egErr('EFBIG');
  if (fmt === 0o120000) {                        // symlink -> symlink entry
    var lbuf = new Uint8Array(4096);
    var n = fs.readlink(abs, lbuf, lbuf.length);
    if (n === null) egErr(fs._lastError || 'EIO');
    state.total += n;
    if (state.total > EGRESS_MAX) egErr('EFBIG');
    list.push({ zipPath: zipPath, kind: 'link', mode: st.mode, mtime: st.mtime,
                target: lbuf.slice(0, n) });
    return;
  }
  if (fmt === 0o040000) {                        // directory
    list.push({ zipPath: zipPath + '/', kind: 'dir', mode: st.mode, mtime: st.mtime });
    var dh = fs.opendir(abs);
    if (dh === null) egErr(fs._lastError || 'EIO');
    var names = [];
    for (var ent = fs.readdir(dh); ent !== null; ent = fs.readdir(dh)) {
      if (ent.name === '.' || ent.name === '..') continue;
      names.push(ent.name);
    }
    fs.closedir(dh);
    names.sort();
    for (var i = 0; i < names.length; i++)
      this._egressWalk(abs + '/' + names[i], zipPath + '/' + names[i], list, state);
    return;
  }
  if (fmt !== 0o100000) egErr('EINVAL');         // nothing else crosses
  state.total += st.size;
  if (state.total > EGRESS_MAX) egErr('EFBIG');
  list.push({ zipPath: zipPath, kind: 'file', mode: st.mode, mtime: st.mtime,
              abs: abs, size: st.size });
};

/* paths -> ONE artifact {name, bytes}. A single regular file crosses as
 * itself; a single directory as <basename>.zip; N>1 paths as
 * gucOS-selection.zip. A LONE symlink follows to its target (downloading a
 * Desktop launcher means "give me the thing"; dangling -> ENOENT) — inside
 * a zip, symlinks stay symlinks. */
Kernel.prototype._egressMaterialize = function (paths) {
  var fs = this._fs;
  var roots = [];                                // [{abs, root}] zip roots
  if (paths.length === 1) {
    var abs = paths[0];
    var st = fs.stat(abs);                       // FOLLOWS the lone symlink
    if (st === null) egErr(fs._lastError || 'ENOENT');
    var fmt1 = st.mode & 0o170000;
    if (fmt1 === 0o100000) {
      if (st.size > EGRESS_MAX) egErr('EFBIG');
      return { name: egName(abs), bytes: this._egressReadFile(abs, st.size) };
    }
    if (fmt1 !== 0o040000) egErr('EINVAL');
    // One dir -> <basename>.zip. Resolve through a lone symlink so the walk
    // archives the TARGET tree, but keep the artifact's name from the link.
    var real;
    try { real = fs.realpathPhysical(abs); } catch (e) { real = null; }
    if (real === null) egErr(fs._lastError || 'ENOENT');
    roots.push({ abs: real, root: egName(abs) });
  } else {
    // Selected roots keep their own basenames; a clash between two roots
    // gets the dropFile '-N' suffix (zip member names must not collide).
    var used = Object.create(null);
    for (var i = 0; i < paths.length; i++) {
      var base = egName(paths[i]);
      var root = base;
      for (var s = 1; used[root]; s++) root = base + '-' + s;
      used[root] = true;
      roots.push({ abs: paths[i], root: root });
    }
  }
  var list = [], state = { total: 0 };
  for (var r = 0; r < roots.length; r++)
    this._egressWalk(roots[r].abs, roots[r].root, list, state);
  var entries = [];
  for (var j = 0; j < list.length; j++) {
    var it = list[j];
    entries.push({
      name: it.zipPath, mode: it.mode, mtime: it.mtime,
      data: it.kind === 'file' ? this._egressReadFile(it.abs, it.size)
        : it.kind === 'link' ? it.target : null,
    });
  }
  var name = paths.length === 1 ? egName(paths[0]) + '.zip' : 'gucOS-selection.zip';
  return { name: name, bytes: zipStore(entries) };
};

Kernel.prototype._respondRaw = function (pcb, bytes) {
  if (pcb.trace && pcb.trace.cur) this._traceRpc(pcb, null, bytes);
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
/* One page of directory entries under the payload cap (todos/0241).
 * FS_OPENDIR reads the first page; when the NEXT entry would push the
 * measured JSON bytes past KP_DIR_PAGE, the open backend handle parks in
 * pcb.dirRpc behind a cursor id (reply `more`) with that entry carried as
 * `pending` — nothing is re-read or lost — and FS_READDIR {dir} continues
 * it. The final page carries no `more` and closes the handle, so the
 * ENOMEM degrade at _respond is unreachable for directory listings while
 * the general oversize guard stays for every other op. Handles are held
 * per-backend (BlockFS/ProcFS/MountFS all keep stateful dir handles), so
 * pagination covers every volume kind with zero backend change. Release
 * points: exhaustion here, a bad-cursor EBADF, and _exitProcess (a client
 * that dies mid-drain leaks nothing — the fd discipline). */
Kernel.prototype._readdirPage = function (pcb, dh, pending) {
  var fs = this._fs;
  var entries = [], bytes = 0;
  var ent = pending !== null ? pending : fs.readdir(dh);
  while (ent !== null) {
    var e = { ino: ent.ino, type: ent.type, name: ent.name };
    // Measured, not estimated: names are UTF-8 and JSON-escaped. The
    // entries.length guard keeps forward progress if a single entry ever
    // exceeded the budget (impossible at NAME_MAX-scale names, but a wedge
    // is worse than one oversize page attempt).
    var cost = textEncoder.encode(JSON.stringify(e)).length + 1;
    if (bytes + cost > KP_DIR_PAGE && entries.length > 0) {
      if (pcb.dirRpc === null) pcb.dirRpc = new Map();
      var cur = pcb.dirRpcNext++;
      pcb.dirRpc.set(cur, { dh: dh, pending: e });
      return { entries: entries, more: cur };
    }
    entries.push(e);
    bytes += cost;
    ent = fs.readdir(dh);
  }
  fs.closedir(dh);
  return { entries: entries };
};

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
      // FS_WATCH bookkeeping: record the path on every file OFD (cheap —
      // a string; the settle emit canonicalizes lazily, gated on live
      // watches), pre-stat O_CREAT existence only when watches are live
      // (the parent-dir CREATE event), and mark O_TRUNC / fresh-create
      // dirty so `echo -n > file` — truncate or create, zero writes —
      // still settles at close. The O_TRUNC test is deliberately on the
      // FLAG, not on the access mode: O_RDONLY|O_TRUNC really does empty
      // the file here (the Linux answer — see BlockFS.open's #641 block),
      // so it owes a watcher the same settle a writable truncate does.
      var oAbs = P(req.path);
      var oExisted = true;
      if (this._watches.size && (req.flags & 0x40)) oExisted = fs.stat(oAbs) !== null;
      var bfsFd = fs.open(oAbs, req.flags | 0, req.mode | 0);
      if (bfsFd === null) { this._respond(pcb, eFs()); return; }
      // accmode (todos/0376): the OFD carries flags & O_ACCMODE; FS_READ/
      // FS_WRITE enforce it. FS_DUP/FS_DUP2/spawn DUP2 share the OFD, so
      // the mode rides every duplicate (POSIX open-file-description rule).
      var o = this._makeOfd('file', { bfsFd: bfsFd, path: oAbs,
                                      accmode: req.flags & 3 });
      if ((req.flags & 0x200) || !oExisted) o.dirty = true;
      o.refs++;
      var fd = allocFd(0);
      pcb.fds.set(fd, o.id);
      if (!oExisted) this._watchEmit(oAbs, FSW_CREATE, FSW_CREATE, false);
      this._respond(pcb, { fd: fd });
      return;
    }
    case OP.FS_CLOSE: {
      var id = pcb.fds.get(req.fd | 0);
      if (id === undefined) { this._respond(pcb, { errno: 'EBADF' }); return; }
      this._ofdUnref(id, pcb.pid);
      pcb.fds.delete(req.fd | 0);
      this._respond(pcb, {});
      return;
    }
    case OP.FS_READ: {
      var o1 = ofdOf(req.fd);
      if (!o1) { this._respond(pcb, { errno: 'EBADF' }); return; }
      var count = Math.min(req.count | 0, KP_PAYLOAD_CAP);
      if (o1.kind === 'file') {
        // Access mode (todos/0376): O_WRONLY can't read. Belt-and-braces
        // with the same check in BlockFS — the kernel OFD is the layer a
        // non-BlockFS embedder fs would rely on.
        if (o1.accmode === 1) { this._respond(pcb, { errno: 'EBADF' }); return; }
        var buf = new Uint8Array(count);
        var n = fs.read(o1.bfsFd, buf, count);
        if (n === null) { this._respond(pcb, eFs()); return; }
        this._respondRaw(pcb, buf.subarray(0, n));
        return;
      }
      if (o1.kind === 'null') { this._respondRaw(pcb, new Uint8Array(0)); return; }
      if (o1.kind === 'watch') {
        // FS_WATCH drain: whole packed records only. Empty queue is EAGAIN
        // — watch fds are inherently non-blocking; the contract is
        // WAIT/select first, then drain until EAGAIN, then act once.
        var wrec = this._watchDrain(o1, count);
        if (wrec === null) { this._respond(pcb, { errno: 'EAGAIN' }); return; }
        if (wrec === false) { this._respond(pcb, { errno: 'EINVAL' }); return; }
        this._respondRaw(pcb, wrec);
        return;
      }
      if (o1.kind === 'http') {
        // HTTP body drain (todos/0417): bytes when queued, 0 at clean EOF,
        // the error when failed, EAGAIN when dry — NEVER a park. http fds
        // are inherently non-blocking like watch fds: __wait doesn't name
        // the ready fd, so a woken caller finds the ready transfer by
        // trying, and try-read-until-EAGAIN is that discipline. A drain
        // below the cap resumes a backpressure-paused fetch reader.
        var hx = o1.xfer;
        if (hx.bytes > 0) {
          this._respondRaw(pcb, this._httpDrain(hx, count));
          if (hx.paused && hx.bytes < hx.cap) this._httpPump(hx);
          return;
        }
        if (hx.error !== null) { this._respond(pcb, { errno: hx.errno || 'EIO', error: hx.error }); return; }
        if (hx.done) { this._respondRaw(pcb, new Uint8Array(0)); return; }   // clean EOF
        this._respond(pcb, { errno: 'EAGAIN' });
        return;
      }
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
        // POSIX read(fd, buf, 0): return 0 immediately, no data transfer, no
        // parking (0253) — and before the job-control check, since a
        // zero-length read moves no bytes (the simple conforming choice).
        if (count === 0) { this._respondRaw(pcb, new Uint8Array(0)); return; }
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
        if (tty._eofFlag || tty._hupFlag) { tty._consumeEof(); this._respondRaw(pcb, new Uint8Array(0)); return; }
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
        // Access mode (todos/0376): O_RDONLY can't write — the corruption
        // half; a read-only fd used to silently mutate the file.
        if (o2.accmode === 0) { this._respond(pcb, { errno: 'EBADF' }); return; }
        var wn = fs.write(o2.bfsFd, data, data.length);
        if (wn === null) { this._respond(pcb, eFs()); return; }
        if (wn > 0) {
          o2.dirty = true;               // FS_WATCH: settles at last close
          if (this._watches.size) this._watchEmit(o2.path, FSW_MODIFY, FSW_MODIFY, false);
        }
        this._respond(pcb, { n: wn });
        return;
      }
      if (o2.kind === 'watch' || o2.kind === 'http') { this._respond(pcb, { errno: 'EBADF' }); return; }
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
        this._respond(pcb, { st: { ino: 0, mode: 0x1000 | 0o600, nlink: 1, size: this._pipeAvail(o4.pipe), atime: 0, mtime: 0, ctime: 0, rdev: 0 } });
      } else if (o4.kind === 'socket') {
        this._respond(pcb, { st: { ino: 0, mode: S_IFSOCK_MODE | 0o777, nlink: 1, size: o4.st === 'conn' ? o4.rx.buf.length : 0, atime: 0, mtime: 0, ctime: 0, rdev: 0 } });
      } else {
        // Character device (tty / console / null).
        this._respond(pcb, { st: { ino: 0, mode: 0x2000 | 0o666, nlink: 1, size: 0, atime: 0, mtime: 0, ctime: 0, rdev: 0 } });
      }
      return;
    }
    case OP.FS_ACCESS: r = fs.access(P(req.path), req.mode | 0); this._respond(pcb, r === null ? eFs() : {}); return;
    // The mutating arms below feed FS_WATCH after success — every runtime
    // fs mutation flows through this dispatch (the choke point), so one
    // emit per arm covers the whole system. All emits are gated on live
    // watches inside the helpers; an unwatched system pays nothing.
    case OP.FS_UNLINK: {
      var ulAbs = P(req.path);
      r = fs.unlink(ulAbs);
      if (r !== null) this._watchEmit(ulAbs, FSW_SELF_GONE, FSW_DELETE, false);
      this._respond(pcb, r === null ? eFs() : {});
      return;
    }
    case OP.FS_RENAME: {
      var rnFrom = P(req.from), rnTo = P(req.to);
      r = fs.rename(rnFrom, rnTo);
      if (r !== null) this._watchRename(rnFrom, rnTo);
      this._respond(pcb, r === null ? eFs() : {});
      return;
    }
    case OP.FS_MKDIR: {
      var mkAbs = P(req.path);
      r = fs.mkdir(mkAbs, req.mode | 0);
      if (r !== null) this._watchEmit(mkAbs, FSW_CREATE, FSW_CREATE, true);
      this._respond(pcb, r === null ? eFs() : {});
      return;
    }
    case OP.FS_RMDIR: {
      var rdAbs = P(req.path);
      r = fs.rmdir(rdAbs);
      if (r !== null) this._watchEmit(rdAbs, FSW_SELF_GONE, FSW_DELETE, true);
      this._respond(pcb, r === null ? eFs() : {});
      return;
    }
    case OP.FS_LINK: {
      var lnTo = P(req.to);
      r = fs.link(P(req.from), lnTo);
      if (r !== null) this._watchEmit(lnTo, FSW_CREATE, FSW_CREATE, false);
      this._respond(pcb, r === null ? eFs() : {});
      return;
    }
    case OP.FS_SYMLINK: {
      var slAbs = P(req.path);
      r = fs.symlink(req.target, slAbs);
      if (r !== null) this._watchEmit(slAbs, FSW_CREATE, FSW_CREATE, false);
      this._respond(pcb, r === null ? eFs() : {});
      return;
    }
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
      // POSIX: ftruncate needs a fd open for writing (todos/0376).
      if (o5.accmode === 0) { this._respond(pcb, { errno: 'EINVAL' }); return; }
      r = fs.ftruncate(o5.bfsFd, req.size | 0);
      if (r !== null) {
        o5.dirty = true;                 // FS_WATCH: settles at last close
        if (this._watches.size) this._watchEmit(o5.path, FSW_MODIFY, FSW_MODIFY, false);
      }
      this._respond(pcb, r === null ? eFs() : {});
      return;
    }
    case OP.FS_FSYNC: {
      // fsync/fdatasync: only file OFDs reach the store (whole-image flush —
      // fsync may flush more than asked); tty/pipe/socket/null are a
      // harmless 0, matching the in-process env's no-validation behavior.
      var oSync = ofdOf(req.fd);
      if (!oSync) { this._respond(pcb, { errno: 'EBADF' }); return; }
      if (oSync.kind === 'file' && fs.fsync(oSync.bfsFd) === null) {
        this._respond(pcb, eFs());
        return;
      }
      this._respond(pcb, {});
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
      this._ofdRef(o8, pcb.pid);
      var dfd = allocFd(0);
      pcb.fds.set(dfd, o8.id);
      this._respond(pcb, { fd: dfd });
      return;
    }
    case OP.FS_DUP2: {
      var o9 = ofdOf(req.fd);
      if (!o9) { this._respond(pcb, { errno: 'EBADF' }); return; }
      if ((req.fd | 0) !== (req.newfd | 0)) {
        this._ofdRef(o9, pcb.pid);
        var prev = pcb.fds.get(req.newfd | 0);
        if (prev !== undefined) this._ofdUnref(prev, pcb.pid);
        pcb.fds.set(req.newfd | 0, o9.id);
      }
      this._respond(pcb, { fd: req.newfd | 0 });
      return;
    }
    case OP.FS_FCNTL_DUPFD: {
      var oA = ofdOf(req.fd);
      if (!oA) { this._respond(pcb, { errno: 'EBADF' }); return; }
      this._ofdRef(oA, pcb.pid);
      var mfd = allocFd(req.min | 0);
      pcb.fds.set(mfd, oA.id);
      this._respond(pcb, { fd: mfd });
      return;
    }
    case OP.FS_OPENDIR: {
      var dh = fs.opendir(P(req.path));
      if (dh === null) { this._respond(pcb, eFs()); return; }
      this._respond(pcb, this._readdirPage(pcb, dh, null));
      return;
    }
    case OP.FS_READDIR: {
      var dcur = pcb.dirRpc !== null ? pcb.dirRpc.get(req.dir | 0) : undefined;
      if (dcur === undefined) { this._respond(pcb, { errno: 'EBADF' }); return; }
      pcb.dirRpc.delete(req.dir | 0);
      this._respond(pcb, this._readdirPage(pcb, dcur.dh, dcur.pending));
      return;
    }
    case OP.FS_REALPATH: {
      // PHYSICAL realpath — every symlink component resolved against the real
      // kernel-side fs (todos/0263). Chattiness is nil: the walk's lstat/
      // readlink hops stay kernel-local, so a brokered realpath is ONE RPC.
      var rp;
      try { rp = fs.realpathPhysical(P(req.path)); } catch (e) { rp = null; }
      this._respond(pcb, rp ? { path: rp } : { errno: fs._lastError || 'ENOENT' });
      return;
    }
    case OP.FS_ISATTY: {
      var oB = ofdOf(req.fd);
      this._respond(pcb, { tty: oB && (oB.kind === 'tty' || oB.kind === 'ptm') ? 1 : 0 });
      return;
    }
    case OP.FS_SELECT: {
      // Flag-BEFORE-scan (todos/0181): raise the ring parked-peer flags,
      // THEN scan. A fast commit that the scan missed loads the flag after
      // its commit (SC order) and kicks — the orders cross, so the wake is
      // never lost. An immediate answer drops the flags via _clearFlags.
      var w = { op: 'select', r: req.r || [], w: req.w || [], timer: null };
      this._waitFlagRings(pcb, w);
      var ready = this._selectScan(pcb, w.r, w.w);
      if (ready.count > 0 || req.timeoutMs === 0) {
        this._clearFlags(w);
        this._respond(pcb, ready);
        return;
      }
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
    case OP.FS_WAIT: {
      // Unified wait (todos/0178): FS_SELECT readiness over req.r/req.w,
      // PLUS the process's input ring as a wake source (req.ring). Response
      // { why } — 0 timeout, 1 fd (r/w lists attached), 2 ring; a posted
      // signal completes the park as EINTR through the ordinary
      // interruptible-RPC path. The caller's contract is re-poll-on-any-
      // return, so a wake never has to be exact — only never lost.
      // No-fs kernels answer ENOSYS like every 0x04xx op (the fd layer is
      // the point); single-source ring waits stay on the raw pumpWait
      // futex tier and don't come through here.
      // NB waiter op is 'uwait' — 'wait' is taken by a parked waitpid
      // (OP.WAIT, answered by _exitProcess). Ring flags go up BEFORE the
      // readiness scan (the FS_SELECT comment above — same lost-wake rule).
      var uw = { op: 'uwait', r: req.r || [], w: req.w || [], ring: !!req.ring, timer: null };
      this._waitFlagRings(pcb, uw);
      var wReady = this._selectScan(pcb, uw.r, uw.w);
      var ringReady = !!req.ring && this._wmRingReady(pcb);
      if (wReady.count > 0 || ringReady || req.timeoutMs === 0) {
        this._clearFlags(uw);
        this._respond(pcb, wReady.count > 0 ? { why: 1, r: wReady.r, w: wReady.w }
          : { why: ringReady ? 2 : 0 });
        return;
      }
      if (req.timeoutMs !== null && req.timeoutMs !== undefined) {
        uw.timer = setTimeout(function () {
          if (pcb.waiter === uw) {
            self._cancelWaiter(pcb);
            self._respond(pcb, { why: 0 });
          }
        }, req.timeoutMs);
      }
      pcb.waiter = uw;     // fd side: _recheckSelects; ring side: _waitRingWake
      return;
    }
    case OP.FS_WATCH_OPEN: {
      // FS_WATCH: one watch per fd (inotify's wd layer deliberately
      // dropped — fds are cheap here and FS_WAIT takes fd lists, so
      // "several watches" is several fds; with the wd goes its whole
      // failure cluster: wd→path maps, wd reuse, the IN_IGNORED race).
      // The path must exist at creation (catches typos loudly) but the
      // watch tolerates later absence: SELF_GONE fires and the watch
      // stays ARMED — a delete-and-recreate or rename-over editor save
      // keeps notifying, because the PATH is the identity, not the inode.
      if (req.flags | 0) { this._respond(pcb, { errno: 'EINVAL' }); return; }
      var wCanon = this._watchCanon(P(req.path));
      var wSt = fs.stat(wCanon);
      if (wSt === null) { this._respond(pcb, eFs()); return; }
      var wOfd = this._makeOfd('watch', {
        path: wCanon,
        isDir: (wSt.mode & 0xF000) === 0x4000,
        mask: (req.mask | 0) || FSW_MASK_DEFAULT,
        queue: [],
        overflowed: false,
      });
      wOfd.refs++;
      this._watches.set(wOfd.id, wOfd);
      var wNewFd = allocFd(0);
      pcb.fds.set(wNewFd, wOfd.id);
      this._respond(pcb, { fd: wNewFd });
      return;
    }
    default: this._respond(pcb, { errno: 'ENOSYS' });
  }
};

/* ---- FS_WATCH (path-keyed file watching; ticket #75) ----
 * The primitive inotify structurally couldn't be: gucOS's single-writer
 * kernel sees EVERY runtime fs mutation as one RPC in the _fsRpc dispatch
 * above, with the path present as a string — so watches key on canonical
 * PATHS, events carry names, a rename is one record with both names, and
 * the editor rename-over-save trap (write tmp + rename onto the target —
 * a per-inode watch dies with the old inode) is gone: the rename lands
 * FSW_CLOSE_WRITE on the watched destination path and the watch survives.
 * Delivery is the existing OFD machinery — a 'watch' OFD is readable in
 * _selectScan (FS_SELECT / the 0178 unified FS_WAIT), drains via FS_READ,
 * dies via FS_CLOSE/_ofdUnref. No new blocking mechanism.
 *
 * Canonicalization is LEXICAL (cwd-join + dot-collapse — fs._resolvePath):
 * the fs surface has no physical resolver (realpath is lexical-only in
 * this flavor, todos/0263), so a write through a symlink alias attributes
 * to the alias's path — the documented residual twin of inotify's
 * hardlink-alias case, harmless to path-consistent consumers. When 0263
 * lands a physical resolver, _watchCanon is the ONE seam to upgrade. */
Kernel.prototype._watchCanon = function (abs) {
  try { var p = this._fs._resolvePath(abs); if (p) return p; } catch (e) {}
  return abs;
};

/* Queue one record on one watch (mask-gated, tail-coalesced). Overflow
 * policy: CLEAR the queue and latch — after a loss the survivors would be
 * a misleading partial prefix; one honest FSW_OVERFLOW ("rescan") beats a
 * plausible-looking lie. The kernel never blocks a mutating RPC on a slow
 * watcher (the strace 0046 principle). Returns true if readiness changed
 * in a way the caller should _recheckSelects for. */
Kernel.prototype._watchQueue = function (w, type, flags, name) {
  if (!(w.mask & (1 << type))) return false;
  if (w.overflowed) return false;              // latched: one OVERFLOW pending
  var q = w.queue;
  var tail = q.length ? q[q.length - 1] : null;
  if (tail && tail.t === type && tail.f === flags && tail.n === name) return false;
  if (q.length >= FSW_QUEUE_CAP) {
    q.length = 0;
    w.overflowed = true;
    if (w.cb) this._watchCbArm(w);
    return true;
  }
  q.push({ t: type, f: flags, n: name });
  if (w.cb) this._watchCbArm(w);
  return true;
};

/* Embedder watches (watchPath below) have no fd to drain: the queued
 * records collapse into ONE deferred callback per event batch. The
 * setTimeout(0) matters twice — a watcher must never run inside the
 * mutating RPC's dispatch, and a burst (tmp write + rename-over) fires
 * the callback once, after the batch settled. */
Kernel.prototype._watchCbArm = function (w) {
  if (w.cbArmed) return;
  w.cbArmed = true;
  setTimeout(function () {
    w.cbArmed = false;
    w.queue.length = 0;
    w.overflowed = false;
    w.cb();
  }, 0);
};

/* Embedder-side path watch: the SAME per-mutation choke FS_WATCH rides,
 * minus the fd machinery — the embedder (kernel-worker) registers a
 * callback on an absolute path and gets one coalesced "this path changed"
 * call per settled batch (no records: the consumer re-reads the file, the
 * cfgstore way). Exact-path semantics only (PATH-keyed like FS_WATCH, so
 * the path may not exist yet and a rename-over save keeps notifying);
 * lifetime is the kernel's — there is no unwatch, embedder watches are
 * boot-scoped by design. First user: the display-density bridge
 * (os/kernel-worker.js watches the display cfgstore layers and re-posts
 * the effective zoom to the page). */
Kernel.prototype.watchPath = function (absPath, cb) {
  this._embWatchN = (this._embWatchN || 0) + 1;
  this._watches.set('embedder:' + this._embWatchN, {
    path: this._watchCanon(absPath),
    isDir: false,
    mask: FSW_MASK_DEFAULT,
    queue: [],
    overflowed: false,
    cb: cb,
    cbArmed: false,
  });
};

/* An embedder-side WRITE participating in the watch contract: the FSW
 * choke lives in the RPC dispatch, so a direct kfs write from the embedder
 * (e.g. kernel-worker persisting the page's zoom control) is invisible to
 * watchers — both process FS_WATCH fds and watchPath — unless it announces
 * the settled content here. */
Kernel.prototype.notifySettled = function (absPath) {
  this._watchEmit(absPath, FSW_CLOSE_WRITE, FSW_CLOSE_WRITE, false);
};

/* Fan a mutation at `absPath` out to the live watches: selfType lands on
 * an exact-path watch (empty name), childType on a watch of the parent
 * directory (the leaf as the record name). Gated on _watches.size — no
 * canonicalization, no iteration on an unwatched system. */
Kernel.prototype._watchEmit = function (absPath, selfType, childType, isDir) {
  if (this._watches.size === 0 || !absPath) return;
  var p = this._watchCanon(absPath);
  var cut = p.lastIndexOf('/');
  var parent = cut <= 0 ? '/' : p.slice(0, cut);
  var leaf = p.slice(cut + 1);
  var fl = isDir ? FSWF_ISDIR : 0;
  var woke = false;
  var self = this;
  this._watches.forEach(function (w) {
    if (w.path === p) { if (self._watchQueue(w, selfType, fl, '')) woke = true; }
    else if (w.isDir && w.path === parent) { if (self._watchQueue(w, childType, fl, leaf)) woke = true; }
  });
  if (woke) this._recheckSelects();
};

/* Rename arrives as ONE RPC carrying both names, so it emits as one story
 * per watcher — no inotify cookie pairing, no unpaired halves:
 *  - exact watch on the source        -> FSW_SELF_GONE (watch stays armed)
 *  - exact watch on the destination   -> FSW_CLOSE_WRITE (rename publishes
 *    COMPLETE content by definition — the rename-over-save settle; a dir
 *    renamed in is FSW_CREATE + ISDIR instead)
 *  - dir watch seeing both sides      -> ONE FSW_RENAME record "old\0new\0"
 *  - dir watch seeing one side        -> FSW_DELETE (out) or the settle/
 *    CREATE (in) — each watcher gets a coherent story for ITS directory. */
Kernel.prototype._watchRename = function (fromAbs, toAbs) {
  if (this._watches.size === 0) return;
  var from = this._watchCanon(fromAbs), to = this._watchCanon(toAbs);
  var st = this._fs.lstat(to);
  var isDir = !!st && (st.mode & 0xF000) === 0x4000;
  var fl = isDir ? FSWF_ISDIR : 0;
  var fc = from.lastIndexOf('/'), tc = to.lastIndexOf('/');
  var fParent = fc <= 0 ? '/' : from.slice(0, fc), fLeaf = from.slice(fc + 1);
  var tParent = tc <= 0 ? '/' : to.slice(0, tc), tLeaf = to.slice(tc + 1);
  var woke = false;
  var self = this;
  this._watches.forEach(function (w) {
    var hit = false;
    if (w.path === from) hit = self._watchQueue(w, FSW_SELF_GONE, fl, '') || hit;
    if (w.path === to) {
      hit = self._watchQueue(w, isDir ? FSW_CREATE : FSW_CLOSE_WRITE, fl, '') || hit;
    }
    if (w.isDir) {
      var f = w.path === fParent, t = w.path === tParent;
      if (f && t) hit = self._watchQueue(w, FSW_RENAME, fl, fLeaf + '\u0000' + tLeaf) || hit;
      else if (f) hit = self._watchQueue(w, FSW_DELETE, fl, fLeaf) || hit;
      else if (t) hit = self._watchQueue(w, isDir ? FSW_CREATE : FSW_CLOSE_WRITE, fl, tLeaf) || hit;
    }
    if (hit) woke = true;
  });
  if (woke) this._recheckSelects();
};

/* Drain queued records into one packed FS_READ reply (whole records only).
 * null = nothing pending (EAGAIN); false = the first record doesn't fit
 * the caller's buffer (EINVAL, the inotify rule — callers size for
 * 4 + NAME_MAX). An overflow latch drains as a single FSW_OVERFLOW record
 * and clears (the queue was already cleared at latch time). */
Kernel.prototype._watchDrain = function (w, cap) {
  var pack = function (t, f, n) {
    var nb = new TextEncoder().encode(n);
    var len = (4 + nb.length + 1 + 3) & ~3;    // header + name + NUL, 4-aligned
    var rec = new Uint8Array(len);
    rec[0] = len & 0xff; rec[1] = (len >> 8) & 0xff;
    rec[2] = t; rec[3] = f;
    rec.set(nb, 4);
    return rec;
  };
  if (w.overflowed) {
    var orec = pack(FSW_OVERFLOW, 0, '');
    if (orec.length > cap) return false;
    w.overflowed = false;
    w.queue.length = 0;
    return orec;
  }
  if (w.queue.length === 0) return null;
  var chunks = [], total = 0;
  while (w.queue.length) {
    var e = w.queue[0];
    var rec = pack(e.t, e.f, e.n);
    if (total + rec.length > cap) break;
    w.queue.shift();
    chunks.push(rec);
    total += rec.length;
  }
  if (chunks.length === 0) return false;
  var out = new Uint8Array(total), off = 0;
  for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
  return out;
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
        var kpeer = this._kernelPeer(ka, kb, pcb);
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

Kernel.prototype._kernelPeer = function (recvDir, sendDir, clientPcb) {
  var self = this;
  var peer = {
    onData: null,               // (Uint8Array) — set by the endpoint handler
    onClose: null,              // () — client hung up (fires once)
    send: function (bytes) {
      if (!sendDir.rOpen || !sendDir.wOpen) return false;
      // A client parked in a kernel fd-waiter (unified WAIT / select,
      // todos/0178) is woken by the _pipeNotify below — its RPC completion
      // IS the wake, atomically. Only the raw ring-futex tier
      // (__sdl_pump_wait — SDL_WaitEvent) still needs the ring kick, so
      // capture the waiter kind BEFORE notifying and skip the kick when
      // the RPC path served it (the record would only buy a spurious
      // extra wake at the client's next entry drain).
      var fdParked = clientPcb && clientPcb.waiter &&
        (clientPcb.waiter.op === 'uwait' || clientPcb.waiter.op === 'select');
      for (var i = 0; i < bytes.length; i++) sendDir.buf.push(bytes[i]);
      self._pipeNotify(sendDir);                  // serve the client's park
      // Kernel-socket→input-ring wake (todos/0168, IDLE-POWER piece W):
      // a client parked on its input ring (__sdl_pump_wait — SDL_WaitEvent)
      // must wake when kernel-peer data lands, or a WMP event
      // (EV_CREATED, EV_SNAP_EDGE, EV_SCREEN, R_IDLE…) sits until the
      // park's timeout. _wmKick pushes a type-0 ring record so the futex
      // word itself changes — see the lost-notify note there.
      if (clientPcb && clientPcb.wmRing && !fdParked) self._wmKick(clientPcb);
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
      // Anchored child surface (todos/0256, menu arch §3.1): creation-flag
      // bit 6 pins the new surface to a same-process parent at a fixed
      // (dx, dy) offset from the parent's client origin. parentSid forms an
      // arbitrary-depth TREE (amendment A1 — a popup may parent another
      // popup); the kernel moves/hides/raises/destroys/scales the subtree
      // with its root and never learns what the child is FOR (menus,
      // tooltips, dropdowns — the anchored-popup family, A8). Bit 7 adds
      // the GRAB (A2): press-outside-dismisses, see _wmGrabs above.
      var parent = null;
      if ((req.flags | 0) & 64) {
        parent = this._surfaces.get(req.parentSid | 0);
        if (!parent || parent.pid !== pcb.pid) {
          this._respond(pcb, { errno: 'EINVAL' }); break;
        }
      }
      var sid = this._nextSid++;
      // Cascade placement (kernel default; a connected /bin/wm re-places on
      // EV_CREATED — until that lands the surface is unmapped, todos/0069);
      // the client rect is (x,y,w,h) with the title bar above it, so y
      // starts below the bar.
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
        hasAlpha: !!((req.flags | 0) & 8),        // bit3: SDL_WINDOW_TRANSPARENT
                                                  // (todos/0063): per-pixel alpha,
                                                  // composited src-over
        transient: !!((req.flags | 0) & 16),      // bit4: SDL_WINDOW_UTILITY
                                                  // (todos/0281): owned/modal —
                                                  // no taskbar button, skipped by
                                                  // window cycling (create-only,
                                                  // never toggled via SET_FLAGS)
        cursor: 0,                // per-surface client cursor shape (todos/0105,
                                  // SDL_SystemCursor; -1 hidden). SDL_SetCursor
                                  // via SURFACE_SET_CURSOR; chrome cursors
                                  // overlay in _wmCursorAt.
        layer: 0,                 // z layer (todos/0038): -1 bottom / 0 / +1 top;
                                  // set post-create via SET_LAYER / wmSetLayer
        pendingConfigure: null,   // { w, h } resize asked, ack not yet in (0019)
        mapped: true,             // in the composite + hit test (todos/0069);
                                  // see the map-on-placement decision below
        mapTimer: null,           // the unmapped-surface backstop timeout
        closeWd: null,            // hung-app watchdog (#486): armed by
                                  // wmCloseRequest, disarmed on consumption
        parentSid: 0,             // anchored child (todos/0256): the parent
                                  // surface this one is pinned to (0 = a
                                  // top-level); forms a tree (A1)
        dx: 0, dy: 0,             // the anchor offset, in PARENT BUFFER
                                  // coordinates — on-screen geometry is
                                  // MATERIALIZED from these (A11), see
                                  // _wmAnchorApply
        children: [],             // anchored children, creation-ordered sids
        grab: false,              // this child holds a grab (flag bit 7, A2)
      };
      if (parent) {
        surf.parentSid = parent.sid;
        surf.dx = req.dx | 0;
        surf.dy = req.dy | 0;
        surf.borderless = true;   // children are chrome-free in every rendering
        surf.grab = !!((req.flags | 0) & 128);
        // Materialize the on-screen rect from the parent (A11) — position,
        // inherited scale, and the into-the-screen clamp all land in the
        // stored x/y/dstW/dstH, so the scene walk / composite / hit test
        // read a plain per-surface rect and stay anchor-blind.
        this._wmAnchorApply(surf, parent);
      }
      // Map-on-placement (todos/0069): with a WM subscribed, the surface is
      // created UNMAPPED — the compositor and hit test skip it until the
      // WM's first geometry/stacking op on the sid lands (wm.c MOVEs every
      // window it manages on EV_CREATED, so that MOVE doubles as the map
      // ack), killing the first-frame teleport from the cascade default.
      // Exceptions keep windows from ever being lost: no subscriber maps
      // immediately (the no-WM fallback is byte-identical to pre-0069);
      // borderless surfaces map immediately UNLESS a subscriber process
      // owns them (wm.c deliberately ignores foreign borderless surfaces —
      // taskbar-class, owner-positioned — but parks its OWN furniture, the
      // start menu being the worst teleport case); and a WM_MAP_TIMEOUT_MS
      // backstop maps anything a wedged WM never places. Anchored children
      // are exempt (todos/0282): their placement is materialized from the
      // parent at create (_wmAnchorApply above) — placement IS decided —
      // and no map ack could ever land anyway (every WM geometry/stacking
      // op refuses children with EPERM), so gating a subscriber-owned one
      // (wm.c's own menu flyouts) would strand it on the backstop timer.
      if (this._wmSubs.size && !parent &&
          (!surf.borderless || this._wmSubOwned(pcb.pid))) {
        surf.mapped = false;
        var mapSelf = this;
        surf.mapTimer = setTimeout(function () { mapSelf._wmMap(sid); },
                                   WM_MAP_TIMEOUT_MS);
      }
      this._surfaces.set(sid, surf);
      this._zOrder.push(sid);
      if (parent) {
        parent.children.push(sid);
        this._wmAnchoredN++;
        if (surf.grab) this._wmGrabs.push(sid);
      }
      this._wmZNormalize();       // create raises within the NORMAL layer only
                                  // (and re-slots anchored subtrees, A1)
      pcb.surfaces.add(sid);
      this._bumpWm();
      this._respond(pcb, { sid: sid, x: surf.x, y: surf.y });
      this._wmEmit(WMP.EV_CREATED, this._wmpRecord(surf));
      // New window takes focus (v1 policy) — EXCEPT anchored children, which
      // never steal focus (§3.1: a menu must not deactivate its own window
      // as it opens; this also kills the wm.c-style hand-back dance for
      // popups). The funnel emits the owner FOCUS pair + EV_FOCUS; it runs
      // AFTER EV_CREATED because wm.c's dismissal gating relies on the
      // create echo naming the sid before its EV_FOCUS arrives (wm.c:3284).
      if (!parent) this._wmSetFocus(sid);
      this._wmSyncPointerLock();
      break;
    }
    // Update the surface flag word (todos/0018): bit0 borderless, bit1
    // relative-mouse, bit2 resizable (0021), bit3 has-alpha (0063). The
    // pointer-lock sync below round-trips a wanted-state change to the UI
    // bridge.
    case OP.SURFACE_SET_FLAGS: {
      var sf = this._surfaces.get(req.sid | 0);
      if (!sf || sf.pid !== pcb.pid) { this._respond(pcb, { errno: 'EINVAL' }); break; }
      var fl = req.flags | 0;
      // Anchored children stay chrome-free invariantly (todos/0256, §3.1):
      // a flag update can never grow a popup a title bar.
      sf.borderless = sf.parentSid ? true : !!(fl & 1);
      sf.relativeMouse = !!(fl & 2);
      sf.resizable = !!(fl & 4);
      sf.hasAlpha = !!(fl & 8);
      // Resizable and scaled are exclusive modes (todos/0024): granting
      // bit2 snaps the viewport back to the buffer (resizable => dst == w/h).
      if (sf.resizable && (sf.dstW !== sf.w || sf.dstH !== sf.h)) {
        sf.dstW = sf.w; sf.dstH = sf.h;
        this._wmEmit(WMP.EV_SCALED, [sf.sid, sf.dstW, sf.dstH]);
      }
      this._bumpWm();
      this._respond(pcb, {});
      this._wmSyncPointerLock();
      break;
    }
    // Per-surface cursor (todos/0105): SDL_SetCursor's shape. Stored only —
    // the effective cursor is derived on the next pointer move (chrome
    // overlay in _wmCursorAt); a stationary pointer over this surface's
    // client updates on the next move (Win95-ish, and it keeps this RPC
    // cheap). Clamp to the known enum range (or -1 hidden).
    case OP.SURFACE_SET_CURSOR: {
      var sc2 = this._surfaces.get(req.sid | 0);
      if (!sc2 || sc2.pid !== pcb.pid) { this._respond(pcb, { errno: 'EINVAL' }); break; }
      var shp = req.shape | 0;
      sc2.cursor = (shp < 0) ? -1 : (shp > 19 ? 0 : shp);
      this._respond(pcb, {});
      break;
    }
    // Owner-initiated resize (todos/0068): the surface's own process asks
    // for a new buffer size. No resizable gate (see the OP table comment);
    // the client completes via the usual WINDOW_RESIZED -> SURFACE_CONFIGURE
    // renegotiation, so geometry only changes at the tear-free ack.
    case OP.SURFACE_RESIZE: {
      var sr = this._surfaces.get(req.sid | 0);
      if (!sr || sr.pid !== pcb.pid) { this._respond(pcb, { errno: 'EINVAL' }); break; }
      var rw = req.w | 0, rh = req.h | 0;
      // WM_MIN_SIZE keeps a framed window's title reachable; an anchored
      // child is chrome-free and owner-managed, and menu-bar-class strips
      // are legitimately thinner (todos/0256) — only >0 applies there.
      var srMin = sr.parentSid ? 1 : WM_MIN_SIZE;
      if (rw < srMin || rh < srMin || rw > 8192 || rh > 8192) {
        this._respond(pcb, { errno: 'EINVAL' }); break;
      }
      if (rw === sr.w && rh === sr.h && !sr.pendingConfigure) {
        this._respond(pcb, {}); break;            // no-op
      }
      var srPrev = sr.pendingConfigure;
      sr.pendingConfigure = { w: rw, h: rh };
      var srErr = this._wmEventTo(sr.sid, [WMEV.WINDOW_RESIZED, 0, rw, rh, 0, 0, 0, 0]);
      if (srErr) {         // EAGAIN in practice: the caller owns the surface
        sr.pendingConfigure = srPrev;
        this._respond(pcb, { errno: srErr }); break;
      }
      this._respond(pcb, {});
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
      this._bumpWm();
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
      if (sc.parentSid) {
        // Anchored child (todos/0256, A5/A11): dst is INHERITED — re-derive
        // position + scale from the parent instead of resetting dst to the
        // buffer, so an owner-resized strip child keeps riding the parent's
        // scale and anchor.
        var cpar = this._surfaces.get(sc.parentSid);
        if (cpar) this._wmAnchorApply(sc, cpar);
      } else {
        sc.dstW = cw; sc.dstH = ch; // configure implies resizable: dst tracks
                                    // the buffer (never scaled, todos/0024)
      }
      if (sc.children.length) this._wmAnchorLayout(sc);  // subtree follows the
                                                         // new geometry (A1)
      if (sc.pendingConfigure.w !== cw || sc.pendingConfigure.h !== ch) {
        // Superseded while the client was renegotiating: latest wins — keep
        // the (valid, newer-than-old) buffer and re-issue the configure.
        this._wmEventTo(sc.sid, [WMEV.WINDOW_RESIZED, 0,
          sc.pendingConfigure.w, sc.pendingConfigure.h, 0, 0, 0, 0]);
      } else {
        sc.pendingConfigure = null;
      }
      this._bumpWm();
      this._respond(pcb, { sid: sc.sid, w: cw, h: ch });
      this._wmEmit(WMP.EV_CONFIGURED, [sc.sid, cw, ch]);
      break;
    }
    default: this._respond(pcb, { errno: 'ENOSYS' });
  }
};

/* ---- map-on-placement (todos/0069) ----
 * An unmapped surface exists (listed, focusable, injectable, single-surface
 * screenshots work) but is not composited and not hit-tested — the classic
 * X11/Wayland rule: a WM-managed window isn't shown until the WM placed it.
 * Mapping is one-way and per-surface; the map ack is the WM's first
 * geometry/stacking op on the sid (wmMove/wmResize/wmSetDst/wmSetLayer/
 * wmRestack — wm.c's EV_CREATED MOVE covers every window it manages). */

Kernel.prototype._wmMap = function (sid) {
  var s = this._surfaces.get(sid | 0);
  if (!s) return;
  if (s.mapTimer) { clearTimeout(s.mapTimer); s.mapTimer = null; }
  if (s.mapped) return;
  s.mapped = true;
  this._bumpWm();
};

/* Does any subscribed WM connection belong to this pid? (The SURFACE_CREATE
 * borderless exception: the WM parks its own furniture, so only ITS
 * borderless surfaces wait for placement.) */
Kernel.prototype._wmSubOwned = function (pid) {
  var owned = false;
  this._wmSubs.forEach(function (c) { if (c.pid === pid) owned = true; });
  return owned;
};

/* Drop a WM-protocol connection. When the LAST subscriber goes (crash,
 * close, corrupt stream), map every pending surface at once — a dead WM
 * can never hide windows, and the kernel-chrome fallback shows the full
 * scene immediately. */
Kernel.prototype._wmSubDrop = function (conn) {
  if (!this._wmSubs.delete(conn) || this._wmSubs.size) return;
  this._wmKeyGrabs = null;   // reset to the default table — a dead WM must not
                             // leave stale grabs eating keys for the next
                             // subscriber (the 0069 valve; KEYBIND §3)
  this._wmOverviewForceEnd();  // a killed WM must never leave the screen stuck
                               // in overview — only the WM can exit it, so the
                               // valve does it here (the 0069 rule, EXPOSE doc)
  var self = this;
  this._surfaces.forEach(function (s) { self._wmMap(s.sid); });
};

Kernel.prototype._wmDestroySurface = function (sid) {
  var s = this._surfaces.get(sid);
  if (!s) return;
  // Destroy-cascade (todos/0256, A1): anchored children die first,
  // recursively — a popup never outlives its anchor. Each child's own
  // destroy unlinks it from s.children, so the loop drains the list.
  while (s.children.length) this._wmDestroySurface(s.children[0]);
  if (s.parentSid) {
    var dpar = this._surfaces.get(s.parentSid);
    if (dpar) {
      var dci = dpar.children.indexOf(sid);
      if (dci >= 0) dpar.children.splice(dci, 1);
    }
    this._wmAnchoredN--;
    var dgi = this._wmGrabs.indexOf(sid);      // a dead holder releases its
    if (dgi >= 0) this._wmGrabs.splice(dgi, 1); // grab (A2)
  }
  if (s.mapTimer) { clearTimeout(s.mapTimer); s.mapTimer = null; }
  this._wmCloseWdClear(s);      // #486: no watchdog outlives its surface
  this._wmAnims.delete(sid);    // no animating a dead surface (todos/0063)
  this._surfaces.delete(sid);
  var zi = this._zOrder.indexOf(sid);
  if (zi >= 0) this._zOrder.splice(zi, 1);
  var owner = this._procs.get(s.pid);
  if (owner) owner.surfaces.delete(sid);
  if (s.bitmap && s.bitmap.close) { try { s.bitmap.close(); } catch (e) {} }
  if (this._wmDrag && this._wmDrag.sid === sid) this._wmDrag = null;
  if (this._wmResizeDrag && this._wmResizeDrag.sid === sid) this._wmResizeDrag = null;
  if (this._focusSid === sid) this._wmFocusFall();
  this._bumpWm();
  this._wmEmit(WMP.EV_DESTROYED, [sid]);
  this._wmSyncPointerLock();
};

/* The focus fall (todos/0039): when the focused surface goes away
 * (destroy, minimize), prefer the topmost non-minimized NORMAL-layer
 * window — after 0038 the top of raw z is ALWAYS pinned furniture (the
 * taskbar), which must not swallow keyboard focus. Furniture only takes
 * the fall when no normal window remains (the pre-0038 degenerate). */
Kernel.prototype._wmFocusFall = function () {
  var fall = 0;
  for (var i = this._zOrder.length - 1; i >= 0; i--) {
    var t = this._surfaces.get(this._zOrder[i]);
    if (!t || t.minimized) continue;
    if (t.parentSid) continue;            // anchored children never take focus
    if (t.layer === 0) { fall = t.sid; break; }
    if (!fall) fall = t.sid;              // remember the topmost furniture
  }
  this._wmSetFocus(fall);
};

/* ---- the focus funnel (todos/0256, menu arch A9) ----
 * The ONE writer of _focusSid. Every focus TRANSITION — the surface-create
 * steal, wmFocus, and the destroy/minimize focus fall — lands here, so the
 * owner focus pair (WMEV.FOCUS_LOST to the old owner, FOCUS_GAINED to the
 * new — SDL3's stock SDL_EVENT_WINDOW_FOCUS_GAINED/LOST) and the
 * WM-subscriber EV_FOCUS fire at all of them BY CONSTRUCTION. Half-wired
 * focus events are worse than none: an app can't pause-on-deactivate off an
 * event that only fires for one of three transitions. */
Kernel.prototype._wmSetFocus = function (sid) {
  sid = sid | 0;
  var prev = this._focusSid | 0;
  if (prev === sid) return;
  this._focusSid = sid;
  // Best-effort delivery (a dying prev surface or a ringless owner just
  // drops its event — same contract as every ring push).
  if (prev) this._wmEventTo(prev, [WMEV.FOCUS_LOST, 0, 0, 0, 0, 0, 0, 0]);
  if (sid) this._wmEventTo(sid, [WMEV.FOCUS_GAINED, 0, 0, 0, 0, 0, 0, 0]);
  this._wmEmit(WMP.EV_FOCUS, [sid]);
  this._bumpWm();
};

/* ---- anchored-child geometry (todos/0256, menu arch §3.1/A1/A11) ---- */

/* Materialize an anchored child's on-screen rect from its parent: position
 * = the parent origin + the (dx, dy) anchor offset scaled by the parent's
 * dst/buffer ratio; size = the child's own buffer scaled the same way —
 * scale INHERITS down the tree, so a dst-scaled fixed-size window (todos/
 * 0024) carries its popups exactly like its client pixels. Runs at every
 * MUTATION site (create, parent move/drag/screen-clamp, wmSetDst, either
 * side's configure) and STORES the result (A11), so the scene walk, the
 * headless composite and the hit test read a plain per-surface rect and
 * stay anchor-blind — the consumers genuinely cost zero lines. (The ONE
 * sanctioned exception is the group fly: wmScene marks children of an
 * animating root with animRootSid so the browser compositor can ride the
 * whole subtree along a minimize/restore fly — see the wmScene filter.)
 *
 * The into-the-screen slide (the xdg-positioner "slide" shape) applies to
 * GRABBED children only — grab tells the kernel which of the two anchored
 * kinds this is. A grabbed child is a TRANSIENT MENU (POPUP_MENU): it must
 * stay reachable to be clickable, so it slides into the screen without the
 * app knowing screen dims (re-derived from dx/dy each time, so clamps
 * never accumulate). A non-grab child (TOOLTIP) is a STRUCTURAL ATTACHMENT
 * — a menu-bar strip, a docked panel: it rigidly tracks the parent and
 * clips at the viewport edge exactly like the parent's own client pixels
 * (sliding one would shear it off its window frame whenever the parent
 * hangs off-screen, e.g. a desktop-sized window on a phone viewport). */
Kernel.prototype._wmAnchorApply = function (c, p) {
  c.dstW = Math.max(1, Math.round(c.w * p.dstW / p.w));
  c.dstH = Math.max(1, Math.round(c.h * p.dstH / p.h));
  c.x = p.x + Math.round(c.dx * p.dstW / p.w);
  c.y = p.y + Math.round(c.dy * p.dstH / p.h);
  if (c.grab) {
    c.x = Math.max(0, Math.min(c.x, this._wmScreen.w - c.dstW));
    c.y = Math.max(0, Math.min(c.y, this._wmScreen.h - c.dstH));
  }
};

/* Re-materialize every anchored DESCENDANT of s — the recursive subtree
 * walk (A1: arbitrary depth, never depth-1). s itself is not touched. */
Kernel.prototype._wmAnchorLayout = function (s) {
  for (var i = 0; i < s.children.length; i++) {
    var c = this._surfaces.get(s.children[i]);
    if (!c) continue;
    this._wmAnchorApply(c, s);
    this._wmAnchorLayout(c);
  }
};

/* The ONE funnel for top-level x/y writes (§3.1 move-with-parent): wmMove,
 * the interactive title drag (clamp included) and the EV_SCREEN one-shot
 * clamp all land here, so the anchored subtree follows by construction. */
Kernel.prototype._wmMoveWithChildren = function (s, nx, ny) {
  s.x = nx | 0;
  s.y = ny | 0;
  if (s.children.length) this._wmAnchorLayout(s);
};

/* Hide/show with parent (§3.1): an anchored child is hidden when ANY
 * ancestor is minimized or unmapped — asked on the fly by the hit test,
 * the headless composite, the cursor walk and the scene accessor (no state
 * fan-out; the walk only runs for surfaces that HAVE a parent). */
Kernel.prototype._wmAnchorHidden = function (s) {
  for (var p = this._surfaces.get(s.parentSid); p;
       p = p.parentSid ? this._surfaces.get(p.parentSid) : null) {
    if (p.minimized || !p.mapped) return true;
  }
  return false;
};

/* The top-level ancestor of an anchored child (itself for a top-level). */
Kernel.prototype._wmAnchorRoot = function (s) {
  while (s.parentSid) {
    var p = this._surfaces.get(s.parentSid);
    if (!p) break;
    s = p;
  }
  return s;
};

/* ---- the grab (todos/0256, menu arch A2) ----
 * Called on every pointer PRESS while a grab is active, with the hit-test
 * result (target surface or null for the desktop, and whether the press
 * landed in its client area). A press in the client area of any surface in
 * the grab holder's root tree routes normally (slide between menu levels,
 * clicks on the owning window — the in-process engine handles in-window
 * dismissal itself, exactly as today). ANY other press — other windows,
 * chrome (own included: Win95 eats the title click that closes a menu),
 * the desktop — dismisses the holder (WMEV.QUIT -> the veneer's per-window
 * SDL_EVENT_WINDOW_CLOSE_REQUESTED, since a popup implies >= 2 live
 * windows) and is CONSUMED, matching release included. The grab pops at
 * the dismissing press, not at the holder's destroy ack, so a wedged owner
 * can never turn one stuck popup into a system-wide input eater. Keyboard
 * needs no grab: children never take focus, so keys already flow to the
 * popup's own process via the focused parent. Pointer lock outranks the
 * grab by branch order in wmPointer (locked routing never hit-tests). */
Kernel.prototype._wmGrabConsume = function (target, isClient) {
  var hSid = this._wmGrabs[this._wmGrabs.length - 1];
  var holder = this._surfaces.get(hSid);
  if (!holder) { this._wmGrabs.pop(); return null; }   // stale entry: no grab
  if (target && isClient &&
      this._wmAnchorRoot(target) === this._wmAnchorRoot(holder)) {
    return null;                                       // inside: route normally
  }
  this._wmGrabs.pop();
  this._wmGrabSwallowUp = true;
  // Deliberately NOT wmCloseRequest (#486): a grab dismissal is UI
  // housekeeping, not a user close request — a momentarily-busy owner must
  // not be force-quit because a click landed outside its popup.
  this._wmEventTo(hSid, [WMEV.QUIT, 0, 0, 0, 0, 0, 0, 0]);
  return 'grab-dismiss';
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
    this._bumpWm();
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
      this._onAudioStream();
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
    case OP.AUDIO_GAIN: {
      // Master output gain (todos/0048): percent, clamped 0..200 (unity
      // 100). A negative request queries. Deliberately NOT per-process —
      // the volume slider is a system control, like the physical knob.
      var g = req.gain | 0;
      if (g >= 0) this._audioGain = Math.min(200, g) / 100;
      this._respond(pcb, { gain: Math.round(this._audioGain * 100) });
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

/* Vsync broadcast (todos/0100): the embedder calls this from its real frame
 * clock — the browser compositor's rAF, right where it samples the scene.
 * One bump + notify per live process; KernelClient.vsyncWait parks on the
 * word and host.js's surface backend paces SDL frame loops off it. No clock,
 * no ticks: a hidden tab (rAF stopped) parks every SDL app at its next frame
 * boundary by construction — the honest pause. Only meaningful when the
 * kernel was built with {vsync: true} (spawn advertises KP_VSYNC_EN). */
Kernel.prototype.vsyncTick = function () {
  var n = 0;
  this._procs.forEach(function (pcb) {
    if (!pcb.i32) return;
    Atomics.add(pcb.i32, KP_VSYNC_SEQ, 1);
    Atomics.notify(pcb.i32, KP_VSYNC_SEQ);
    n++;
  });
  this._vsyncNotifies += n;   // app-worker-wake probe (todos/0169)
};

/* Cumulative count of per-pcb vsync notifies — the test/measurement probe
 * for "app workers stop waking when the compositor parks" (todos/0169). */
Kernel.prototype.vsyncNotifyCount = function () {
  return this._vsyncNotifies;
};

/* Cumulative count of gpu-transport frame ships (wm-frame bitmaps received)
 * — the #551 producer-clamp probe: a delay-loop SDL app must ship at the
 * vsync rate, never at its present rate (tests/browser/os-devloss.mjs). */
Kernel.prototype.wmFrameCount = function () {
  return this._wmFrameN | 0;
};

/* ---- on-demand compositor park protocol (todos/0169; IDLE-POWER piece B).
 * The compositor shares this worker: when its scene goes clean it parks the
 * rAF (no ticks, no submits) and these are the kernel half of the handshake.
 * Wake paths back in are (a) _bumpWm — every WM state change, (b) _wmFrame —
 * every gpu present's message, (c) the want-frame doorbell — a process that
 * presented or armed a vsync wait while KP_COMP_PARKED was up, and (d) the
 * embedder's own handler wires (input/resize/drop). */

/* Register the embedder's damage hook (the compositor's scheduleFrame).
 * Late-bound: the browser canvas arrives after boot. Null when headless. */
Kernel.prototype.wmOnDamage = function (fn) {
  this._onWmDamage = fn || null;
};

/* Version bump + damage: EVERY scene change routes through here so a parked
 * compositor is always re-armed (the map-timeout setTimeout path included —
 * no message accompanies it, the hook is the only wake). */
Kernel.prototype._bumpWm = function () {
  this._wmVersion++;
  if (this._onWmDamage) this._onWmDamage();
};

/* Publish/clear the parked flag on every pcb page. MUST be stored before
 * the caller re-reads ARMED/wantFrame/seqs (Dekker store-then-check): with
 * seq-cst atomics a process either observes PARKED=1 and posts want-frame,
 * or its ARMED add / present seq bump happens-before our re-read — a lost
 * wake is impossible. Single writer: the kernel worker (compositor). */
Kernel.prototype.compSetParked = function (on) {
  on = !!on;
  this._compParked = on;
  var v = on ? 1 : 0;
  this._procs.forEach(function (pcb) {
    if (pcb.i32) Atomics.store(pcb.i32, KP_COMP_PARKED, v);
  });
};

/* Any reason the compositor must keep its rAF armed: a pcb that rang the
 * doorbell and hasn't re-entered its event wait (wantFrame), or a live
 * vsync waiter (KP_VSYNC_ARMED > 0 — parking would strand it: no ticks, no
 * resolve, a FROZEN app, not just a stale screen). Zombies are skipped: a
 * SIGKILLed app can leave ARMED set forever. Stopped pcbs still count —
 * SIGCONT has no compositor hook, so they must not be parked away from. */
Kernel.prototype.compKeepAlive = function () {
  var alive = false;
  this._procs.forEach(function (pcb) {
    if (pcb.state === STATE_ZOMBIE || !pcb.i32) return;
    if (pcb.wantFrame || Atomics.load(pcb.i32, KP_VSYNC_ARMED) > 0) alive = true;
  });
  return alive;
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

/* Live stream count — the embedder's pump-disarm probe (dying streams
 * count: they still need pumps to drain). */
Kernel.prototype.audioStreamCount = function () {
  return this._audioStreams.size;
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
  var spent = null;   // dying streams whose tail can't back one more frame
  this._audioStreams.forEach(function (s) {
    if (!Atomics.load(s.control, AU_PLAYING)) return;   // paused: skip, keep queued
    var qb = Atomics.load(s.control, AU_QUEUED);
    if (qb < 0) { Atomics.store(s.control, AU_QUEUED, 0); qb = 0; }  // clear() race heal
    var srcFrames = Math.floor(qb / s.frameBytes);
    var ratio = s.freq / out.freq;
    var avail = srcFrames > 0 ? Math.floor((srcFrames - s.frac) / ratio) : 0;
    if (avail <= 0) {
      // A dying stream that can't back another output frame is DRY: at a
      // non-integer resample ratio the fractional cursor strands the last
      // source frame(s) forever (floor((srcFrames - frac)/ratio) hits 0
      // with queued > 0), so waiting for queued == 0 would leak the
      // stream — one-shot clips (PlaySound, todos/0094) hit this on
      // every play. Live streams keep the tail: the producer's next push
      // makes it mixable again.
      if (s.dying) (spent = spent || []).push(s.aid);
      return;
    }
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
  if (spent) spent.forEach(function (aid) { self._audioStreams.delete(aid); });
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
  var gain = this._audioGain;                        // master gain (0048)
  for (var f = 0; f < frames; f++) {
    cdv.setFloat32(f * outFrameBytes, Math.max(-1, Math.min(1, mixL[f] * gain)), true);
    cdv.setFloat32(f * outFrameBytes + 4, Math.max(-1, Math.min(1, mixR[f] * gain)), true);
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
  this._wmFrameN = (this._wmFrameN | 0) + 1;   // gpu-ship counter (#551 clamp probe)
  Atomics.add(s.i32, SH_SEQ, 1);   // frameSeq accounting rides the header either way
  // On-demand compositor (todos/0169): every gpu present already messages
  // this worker, so the message IS the doorbell — arm unconditionally
  // (free insurance; a no-op while armed).
  if (this._onWmDamage) this._onWmDamage();
};

/* ---- input ring (kernel = single producer) ---- */

/* Socket→ring wake (todos/0168; race closed in the 0169 gate): wake a
 * client parked on its input ring because kernel-peer socket data landed.
 * This was a bare Atomics.notify(IR_WPOS), but a notify on an unchanged
 * word wakes nobody — one landing between the client's last ring check and
 * its Atomics.wait entry (the __sdl_pump_wait park, whose 0169 frame-idle
 * post sits exactly in that window) slept out the full park chunk: wm.c's
 * 1s, and test_wm_service_e2e's placement legs started losing the
 * EV_CREATED race to it. Push a type-0 record instead: WPOS — the futex
 * word — changes, so a parker either sees a non-empty ring at its entry
 * drain or its wait resolves; a lost wake is impossible. host.js's
 * drainInput skips unknown types but counts them as drained (return-on-
 * drained re-polls, the 0168 contract), so the record is invisible to the
 * app's SDL queue. Full ring: no record needed — WPOS≠RPOS already denies
 * any park (and a waiter inside Atomics.wait entered on empty, so WPOS has
 * since changed under it); notify anyway as a belt. */
Kernel.prototype._wmKick = function (pcb) {
  var ring = pcb.wmRing;
  if (!ring) return;
  var cap2 = ring.cap * 2;
  var wpos = Atomics.load(ring.i32, IR_WPOS);
  var rpos = Atomics.load(ring.i32, IR_RPOS);
  if (((wpos - rpos + cap2) % cap2) < ring.cap) {
    var base = (IR_HDR_BYTES >> 2) + (wpos % ring.cap) * IR_RECORD_WORDS;
    for (var k = 0; k < IR_RECORD_WORDS; k++) ring.i32[base + k] = 0;
    Atomics.store(ring.i32, IR_WPOS, (wpos + 1) % cap2);
  }
  Atomics.notify(ring.i32, IR_WPOS);
  this._waitRingWake(pcb);      // a WAIT park counts the ring as a source
};

/* Ring readiness / ring wake for the unified WAIT (todos/0178). The parked
 * process cannot move RPOS (it is inside the RPC), so an entry scan that
 * sees an empty ring stays true until a push lands — and every push calls
 * back here. That pairing is what makes check-and-park atomic. */
Kernel.prototype._wmRingReady = function (pcb) {
  var ring = pcb.wmRing;
  return !!ring && Atomics.load(ring.i32, IR_WPOS) !== Atomics.load(ring.i32, IR_RPOS);
};

Kernel.prototype._waitRingWake = function (pcb) {
  if (pcb.waiter && pcb.waiter.op === 'uwait' && pcb.waiter.ring) {
    this._cancelWaiter(pcb);
    this._respond(pcb, { why: 2 });
  }
};

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
  // Wake a host parked ON THE RING (host.js __sdl_pump_wait — user32's
  // blocking GetMessage, todos/0058) and the doorbell parks alike.
  Atomics.notify(ring.i32, IR_WPOS);
  this._ring(pcb);                                          // wake SDL_WaitEvent parks
  this._waitRingWake(pcb);                                  // complete a unified WAIT (0178)
  return true;
};

var _wmF32Scratch = new Float32Array(1);
var _wmI32Scratch = new Int32Array(_wmF32Scratch.buffer);
function f32bits(v) { _wmF32Scratch[0] = v; return _wmI32Scratch[0]; }

/* Deliver one event to a surface's owner. Returns 0, or the errno NAME for
 * the real failure (todos/0242): EINVAL unknown sid, ESRCH the owning
 * process is gone, EAGAIN no ring / ring full (delivery would drop). */
Kernel.prototype._wmEventTo = function (sid, words) {
  var s = this._surfaces.get(sid);
  if (!s) return 'EINVAL';
  var pcb = this._procs.get(s.pid);
  if (!pcb || pcb.state !== STATE_RUNNING) return 'ESRCH';
  words[1] = sid;
  return this._wmPushEvent(pcb, words) ? 0 : 'EAGAIN';
};

/* ---- hung-app containment (#486; OS.md "Contain") ----
 * A close request is the one event whose non-consumption is PROOF the owner
 * is not responding: the user asked the window to close, and an app that
 * never advances its input-ring rpos past the QUIT record (a wedged loop, a
 * pump-free render loop) will ignore it forever. wmCloseRequest is the ONE
 * choke for user close requests — the chrome close box and WMP CLOSE_REQ
 * (wm.c taskbar Close, wmctl close). Grab dismissals are deliberately
 * excluded (_wmGrabConsume): dismissing a popup is UI housekeeping, not a
 * request to quit, and a momentarily-busy owner must not die for it.
 *
 * Semantics: deliver WMEV.QUIT and arm a ONE-SHOT per-surface watchdog that
 * polls the ring's rpos. Consumed within the grace period -> disarm; an app
 * that pumps the request and then chooses to stay open is RESPONDING (the
 * Windows rule: pumping = alive; what it does with the event is its
 * business). Unconsumed at the deadline -> force-quit THAT process (the
 * SIGKILL path — _exitProcess reclaims surfaces/fds/ring, so a hung app
 * cannot block its own teardown) with a legible reason through _log. A
 * second close request during the grace window with the first QUIT still
 * unconsumed force-quits immediately (Windows-style escalation). A full
 * ring at request time (EAGAIN — cap records already sitting undrained) is
 * the strongest not-draining signal there is: the watchdog arms anyway,
 * retries delivery each poll, and the grace clock still starts at the
 * user's click.
 *
 * Consumption tracking: rpos/wpos live in [0, 2*cap) and a live consumer
 * can lap that space (5s of mousemotion outruns a 256-slot ring), so ONE
 * deadline check could alias. The poll instead keeps need = records left
 * to consume (the QUIT last among everything queued at push time) and
 * subtracts the per-poll rpos delta; a drained-dry ring (rpos == wpos,
 * where wpos only moves on this thread) is alias-proof evidence on its
 * own. Undercounting would need >= 2*cap records consumed inside one poll
 * interval with the ring never once observed empty — not a real consumer. */
Kernel.prototype.wmCloseRequest = function (sid) {
  var s = this._surfaces.get(sid);
  if (!s) return 'EINVAL';
  var pcb = this._procs.get(s.pid);
  if (!pcb || pcb.state !== STATE_RUNNING) return 'ESRCH';
  if (s.closeWd) {
    if (!this._wmCloseWdDone(pcb, s.closeWd)) {
      // Second close during grace, first QUIT still unconsumed: hung now.
      this._wmCloseWdClear(s);
      this._wmForceQuit(s, pcb);
      return 0;
    }
    this._wmCloseWdClear(s);       // consumed: this click is a fresh request
  }
  var err = this._wmEventTo(sid, [WMEV.QUIT, 0, 0, 0, 0, 0, 0, 0]);
  if (err === 'EINVAL' || err === 'ESRCH') return err;   // no target: no watchdog
  var wd = { deadline: Date.now() + this._hungGraceMs, timer: null,
             delivered: false, need: 0, lastRpos: 0 };
  s.closeWd = wd;
  if (err === 0) this._wmCloseWdTrack(pcb, wd);
  this._wmCloseWdSchedule(sid);
  return err;      // EAGAIN still reported to the caller; the watchdog owns
                   // the request from here (delivery retries in the poll)
};

/* Record what "consumed" means for the QUIT just pushed: the consumer must
 * advance rpos past everything queued at push time — our record is last. */
Kernel.prototype._wmCloseWdTrack = function (pcb, wd) {
  var ring = pcb.wmRing;
  if (!ring) return;               // undeliverable after all; the poll retries
  var cap2 = ring.cap * 2;
  wd.lastRpos = Atomics.load(ring.i32, IR_RPOS);
  wd.need = (Atomics.load(ring.i32, IR_WPOS) - wd.lastRpos + cap2) % cap2;
  wd.delivered = true;
};

Kernel.prototype._wmCloseWdDone = function (pcb, wd) {
  if (!wd.delivered) return false;
  var ring = pcb.wmRing;
  if (!ring) return false;
  var cap2 = ring.cap * 2;
  var rpos = Atomics.load(ring.i32, IR_RPOS);
  if (rpos === Atomics.load(ring.i32, IR_WPOS)) return true;   // drained dry
  wd.need -= (rpos - wd.lastRpos + cap2) % cap2;
  wd.lastRpos = rpos;
  return wd.need <= 0;
};

Kernel.prototype._wmCloseWdClear = function (s) {
  if (!s.closeWd) return;
  if (s.closeWd.timer) clearTimeout(s.closeWd.timer);
  s.closeWd = null;
};

Kernel.prototype._wmCloseWdSchedule = function (sid) {
  var s = this._surfaces.get(sid);
  if (!s || !s.closeWd) return;
  var self = this;
  // Poll fast enough that the consumer cannot lap the [0, 2*cap) index
  // space between polls (the aliasing note above); a short grace (tests)
  // polls at grace/4 so the deadline is hit promptly.
  var t = setTimeout(function () { self._wmCloseWdPoll(sid); },
                     Math.max(10, Math.min(WM_HUNG_POLL_MS, this._hungGraceMs >> 2)));
  if (t.unref) t.unref();          // never pins a Node embedder's event loop
  s.closeWd.timer = t;
};

Kernel.prototype._wmCloseWdPoll = function (sid) {
  var s = this._surfaces.get(sid);
  if (!s || !s.closeWd) return;
  var wd = s.closeWd;
  wd.timer = null;
  var pcb = this._procs.get(s.pid);
  if (!pcb || pcb.state === STATE_ZOMBIE) { s.closeWd = null; return; }  // gone already
  if (!wd.delivered) {
    // The ring was full (or absent) at request time — retry delivery on
    // the SAME grace clock; a drain would have made room by now.
    if (this._wmEventTo(sid, [WMEV.QUIT, 0, 0, 0, 0, 0, 0, 0]) === 0) {
      this._wmCloseWdTrack(pcb, wd);
    }
  }
  if (this._wmCloseWdDone(pcb, wd)) { s.closeWd = null; return; }        // responding
  if (Date.now() >= wd.deadline) {
    s.closeWd = null;
    this._wmForceQuit(s, pcb);
    return;
  }
  this._wmCloseWdSchedule(sid);
};

/* The containment action. Reason FIRST — the user must be able to learn why
 * the window vanished (boot.js wires _log to stderr; the browser embedder
 * to the boot-log console) — then the SIGKILL path. A STOPPED process
 * force-quits too: it cannot consume a close request either, and SIGKILL
 * reaches stopped processes by definition. */
Kernel.prototype._wmForceQuit = function (s, pcb) {
  this._log('"' + (s.title || 'window ' + s.sid) + '" (pid ' + pcb.pid +
            ') is not responding — force quit');
  this._deliver(pcb, SIG.KILL);
};

/* ---- raw input from the UI bridge (SCREEN coordinates) ----
 * The kernel hit-tests against the scene and routes: client-area events go
 * to the owning process (window-local coords); chrome events run the v1
 * policy right here. The agent inject API below shares these code paths. */

Kernel.prototype.wmKey = function (down, scancode, keysym, mod, repeat) {
  this._wmLastInput = Date.now();      // idle clock (todos/0096)
  // Kernel key-grab table (todos/KEYBINDING-OVERRIDE-SYSTEM.md §3): ONE
  // data-driven passive-grab table replaces the four historical hardcoded
  // chord blocks (cycle/menu/snap/sysmenu). Evaluated at the TOP of wmKey,
  // BEFORE focus routing, and ONLY with a WM subscribed — the unchanged
  // no-WM rule: no subscriber, no interception, the chord isn't recognized
  // and the focused app gets the key (the kernel never silently eats
  // keystrokes). Until a WM sends GRAB_SET the kernel uses WM_DEFAULT_GRABS,
  // whose reserved tokens emit the LEGACY events so pre-grab-table clients
  // stay byte-identical. A match swallows BOTH edges (apps never see half a
  // chord); repeat keeps firing.
  if (this._wmSubs.size) {
    var grabs = this._wmKeyGrabs || WM_DEFAULT_GRABS;
    var fold = wmKmFromSdl(mod | 0);
    var sc = scancode | 0;
    for (var gi = 0; gi < grabs.length; gi++) {
      var e = grabs[gi];
      if ((e.scancode | 0) !== sc) continue;
      // Exact modifier match on the non-Shift families. The Shift rule
      // (Fable amendment): an entry that NAMES Shift requires it exactly;
      // one that does NOT still matches with Shift held (Shift masked out),
      // so cycle-reverse rides the reported Shift bit and a user override
      // like ctrl+shift+e never collapses to ctrl+e.
      var matched = (e.km & KM_SHIFT) ? (fold === (e.km | 0))
                                      : ((fold & ~KM_SHIFT) === (e.km | 0));
      if (!matched) continue;
      return this._wmGrabHit(down, e.token | 0, sc,
        (fold & KM_SHIFT) ? 1 : 0, repeat ? 1 : 0);
    }
  }
  // Overview active (todos/EXPOSE-MISSION-CONTROL.md): a pure presentation
  // override that swallows ALL input so apps never see half-gestures. The
  // toggle chord already fired above (the grab table reaches its intercept
  // first — that is how Ctrl+Alt+E exits). Esc DOWN dismisses via a PICK{0};
  // every other key is eaten (both edges). The kernel changes no state here —
  // the WM acts on the PICK.
  if (this._wmOverview) {
    if (down && (scancode | 0) === 41) this._wmEmit(WMP.EV_OVERVIEW_PICK, [0]);  // Esc
    return true;   // swallowed (never delivered to the focused app)
  }
  if (!this._focusSid) return false;
  // Boolean by contract (the raw UI-bridge seam, not a WMP op): true =
  // delivered, false = dropped — _wmEventTo's errno name is a 0242 shape.
  return this._wmEventTo(this._focusSid,
    [down ? WMEV.KEYDOWN : WMEV.KEYUP, 0, scancode | 0, keysym | 0, mod | 0, repeat ? 1 : 0, 0, 0]) === 0;
};

/* A key-grab entry matched (todos/KEYBINDING-OVERRIDE-SYSTEM.md §3). The
 * matching keydown emits an event; both edges are swallowed (apps never see
 * half a chord). Returns wmKey's action string. RESERVED tokens (high bit)
 * belong to WM_DEFAULT_GRABS and emit the LEGACY event with its historical
 * payload + return its historical string, so scripted-WM tests and pre-grab-
 * table clients are byte-identical; any other token rides EV_HOTKEY. */
Kernel.prototype._wmGrabHit = function (down, token, scancode, shift, repeat) {
  switch (token | 0) {
    case WM_TOK_CYCLE:
      if (down) this._wmEmit(WMP.EV_CYCLE, [shift ? -1 : 1]);
      return 'cycle';
    case WM_TOK_MENU:
      if (down) this._wmEmit(WMP.EV_MENU, []);
      return 'menu';
    case WM_TOK_SNAP:
      // direction 0 L / 1 R / 2 U / 3 D from the arrow scancode (0095).
      if (down) this._wmEmit(WMP.EV_SNAP_KEY,
        [scancode === 80 ? 0 : scancode === 79 ? 1 : scancode === 82 ? 2 : 3]);
      return 'snap';
    case WM_TOK_SYSMENU:
      if (down) this._wmEmit(WMP.EV_SYSMENU, [this._focusSid | 0]);
      return 'sysmenu';
    default:
      // A wm.c-installed chord: the one event for all user grabs. flags
      // bit0 = Shift held, bit1 = key repeat; focusSid rides along.
      if (down) this._wmEmit(WMP.EV_HOTKEY,
        [token | 0, (shift ? 1 : 0) | (repeat ? 2 : 0), this._focusSid | 0]);
      return 'grab';
  }
};

/* Install a new key-grab table (WMP_GRAB_SET) — replace the whole table
 * (idempotent; n = 0 = empty = no interception). Subscriber-only. dv/plen are
 * the raw frame payload: i32 n, then n x (scancode, km, token). */
Kernel.prototype.wmGrabSet = function (conn, dv, plen) {
  if (!this._wmSubs.has(conn)) return 'ENODEV';   // only the WM may grab keys
  var n = plen >= 4 ? dv.getInt32(8, true) : 0;
  if (n < 0 || n > WM_GRAB_MAX) return 'EINVAL';
  if (plen < 4 * (1 + 3 * n)) return 'EINVAL';    // short frame
  var tbl = [];
  for (var i = 0; i < n; i++) {
    var o = 8 + 4 * (1 + 3 * i);
    tbl.push({ scancode: dv.getInt32(o, true) | 0,
               km: dv.getInt32(o + 4, true) | 0,
               token: dv.getInt32(o + 8, true) | 0 });
  }
  this._wmKeyGrabs = tbl;
  return 0;
};

/* ---- window overview / Exposé (todos/EXPOSE-MISSION-CONTROL.md) ----
 * The kernel mechanism: it renders and routes; wm.c decides. OVERVIEW_SET
 * hands us the miniature cell rects (WM policy), we store them as a pure
 * presentation override and composite live seq-gated miniatures + route
 * hover/pick; we NEVER change focus/z/minimize/geometry — every real state
 * change is the WM's move after the PICK. */

/* Enter the overview (or relayout if already active) with the given cell
 * rects. Subscriber-only — a presentation takeover nothing else may seize.
 * dv/plen are the raw frame payload: i32 n, then n x (sid, x, y, w, h). Dead
 * sids are dropped (the WM's model can lag a destroy). N = 0 leaves nothing
 * to show, so it exits rather than showing an empty screen. */
Kernel.prototype.wmOverviewSet = function (conn, dv, plen) {
  if (!this._wmSubs.has(conn)) return 'ENODEV';   // only the WM drives overview
  var n = plen >= 4 ? dv.getInt32(8, true) : 0;
  if (n < 0 || n > 256) return 'EINVAL';          // MAX_WIN is 64; a sane cap
  if (plen < 4 * (1 + 5 * n)) return 'EINVAL';    // short frame
  var cells = [];
  for (var i = 0; i < n; i++) {
    var o = 8 + 4 * (1 + 5 * i);
    var sid = dv.getInt32(o, true) | 0;
    if (!this._surfaces.get(sid)) continue;       // dropped: dead sid
    cells.push({ sid: sid, x: dv.getInt32(o + 4, true) | 0,
                 y: dv.getInt32(o + 8, true) | 0,
                 w: Math.max(1, dv.getInt32(o + 12, true) | 0),
                 h: Math.max(1, dv.getInt32(o + 16, true) | 0) });
  }
  if (!cells.length) { this._wmOverviewForceEnd(); return 0; }
  // Preserve a live hover across a relayout; else start un-hovered.
  var prevHover = this._wmOverview ? this._wmOverview.hoverSid : 0;
  var keep = 0;
  for (var h = 0; h < cells.length; h++) if (cells[h].sid === prevHover) keep = prevHover;
  var entering = !this._wmOverview;
  this._wmOverview = { cells: cells, hoverSid: keep };
  // Enter/exit fly (todos/0063 shape): only on the first SET (entering) — a
  // relayout while up must not re-fly. Browser-visual only; the headless
  // composite ignores it, so goldens are unaffected.
  if (entering) this._wmOverviewFlies(cells, false);
  this._bumpWm();
  return 0;
};

/* Leave the overview (WMP_OVERVIEW_END). Subscriber-only. Pure presentation
 * clear — no focus/z/geometry touched (the WM already moved, or is about to). */
Kernel.prototype.wmOverviewEnd = function (conn) {
  if (!this._wmSubs.has(conn)) return 'ENODEV';
  this._wmOverviewForceEnd();
  return 0;
};

/* Force-end the overview (the last-subscriber-gone valve + the N=0 exit +
 * OVERVIEW_END). Records the reverse fly for the browser, then clears. */
Kernel.prototype._wmOverviewForceEnd = function () {
  if (!this._wmOverview) return;
  this._wmOverviewFlies(this._wmOverview.cells, true);
  this._wmOverview = null;
  this._bumpWm();
};

/* Build the enter/exit fly records: each cell miniature flies between its
 * window's REAL on-screen rect and the cell rect (reverse on exit). Browser-
 * visual only (compositor interpolates + prunes past WM_ANIM_MS). */
Kernel.prototype._wmOverviewFlies = function (cells, reverse) {
  var t0 = Date.now();
  var anims = [];
  for (var i = 0; i < cells.length; i++) {
    var c = cells[i];
    var s = this._surfaces.get(c.sid);
    if (!s) continue;
    anims.push({ sid: c.sid, reverse: !!reverse, t0: t0,
                 rx: s.x, ry: s.y, rw: s.dstW, rh: s.dstH,     // real rect
                 cx: c.x, cy: c.y, cw: c.w, ch: c.h });        // cell rect
  }
  this._wmOverviewAnims = anims;
};

/* Command-side overview gesture (WMP_OVERVIEW): fire EV_OVERVIEW at the WM,
 * the CYCLE/MENU pattern. R_ERR with no subscriber (overview IS policy — the
 * kernel never invents the candidate set or layout). The Ctrl+Alt+E chord
 * rides the grab table's KTOK_OVERVIEW -> EV_HOTKEY instead. */
Kernel.prototype.wmOverview = function () {
  if (!this._wmSubs.size) return 'ENODEV';
  this._wmEmit(WMP.EV_OVERVIEW, []);
  return 0;
};

/* ---- cursor shapes (todos/0105) ----
 * SDL_SystemCursor wire values; the CSS-name map lives host-side (CURSOR_CSS
 * in host.js + os.html). Chrome resize cursors use the AXIS-PAIR shapes so a
 * side frame reads ew-/ns-resize and the corner the matching diagonal. */
var CUR_DEFAULT = 0, CUR_NWSE = 5, CUR_EW = 7, CUR_NS = 8;

/* The effective cursor at a SCREEN point (todos/0105): pointer-lock hides it
 * (-1), an in-flight resize drag shows its edge cursor, a title drag the
 * arrow, a frame edge the matching resize cursor, a client area the surface's
 * OWN cursor (SDL_SetCursor), else the arrow. Mirrors wmPointer's hit test
 * — same on-screen (dst) rects, same topmost order — but side-effect-free, so
 * it serves both the move-time emit and the WMP_CURSOR_AT query. */
Kernel.prototype._wmCursorAt = function (x, y) {
  if (this._wmPtrLockActive) return -1;          // no cursor while locked
  if (this._wmResizeDrag) {
    var rd = this._wmResizeDrag;
    return rd.ex && rd.ey ? CUR_NWSE : rd.ex ? CUR_EW : rd.ey ? CUR_NS : CUR_DEFAULT;
  }
  if (this._wmDrag) return CUR_DEFAULT;          // moving a window: arrow
  for (var i = this._zOrder.length - 1; i >= 0; i--) {
    var s = this._surfaces.get(this._zOrder[i]);
    if (!s || s.minimized || !s.mapped) continue;
    if (s.parentSid && this._wmAnchorHidden(s)) continue;   // (todos/0256)
    var dw = s.dstW, dh = s.dstH;
    var inTitle = !s.borderless &&
      x >= s.x && x < s.x + dw && y >= s.y - WM_TITLE_H && y < s.y;
    var inClient = x >= s.x && x < s.x + dw && y >= s.y && y < s.y + dh;
    var inFrame = !s.borderless && !inTitle && !inClient &&
      x >= s.x - WM_BORDER && x < s.x + dw + WM_BORDER_HIT &&
      y >= s.y - WM_TITLE_H - WM_BORDER && y < s.y + dh + WM_BORDER_HIT;
    // The SE grip's inward reach (#388) advertises itself, mirroring the
    // hit test: a resizable client's bottom-right WM_GRIP_IN square reads
    // the NWSE cursor even though moves still flow to the app.
    if (inClient && !s.borderless && s.resizable &&
        x >= s.x + dw - WM_GRIP_IN && y >= s.y + dh - WM_GRIP_IN)
      return CUR_NWSE;
    if (inFrame) {
      // Resize cursors only on RESIZABLE surfaces (fixed-size frames read the
      // arrow, matching Windows — the 0024 scale-drag is a power gesture, not
      // advertised). Drag zones live on the E/S/SE edges (left/top just focus);
      // the SE corner widens by WM_GRIP_HIT, mirroring the hit test.
      if (!s.resizable) return CUR_DEFAULT;
      var ex = x >= s.x + dw ? 1 : 0;
      var ey = y >= s.y + dh ? 1 : 0;
      if (ex && y >= s.y + dh - WM_GRIP_HIT) ey = 1;
      if (ey && x >= s.x + dw - WM_GRIP_HIT) ex = 1;
      return ex && ey ? CUR_NWSE : ex ? CUR_EW : ey ? CUR_NS : CUR_DEFAULT;
    }
    if (inTitle) return CUR_DEFAULT;
    if (inClient) return s.cursor | 0;           // the app's per-surface cursor
  }
  return CUR_DEFAULT;                            // desktop
};

/* Emit an effective-cursor change to the UI bridge, debounced (todos/0105).
 * Called on every pointer MOVE; browser-only rendering, headless no-ops. */
Kernel.prototype._wmEmitCursor = function (x, y) {
  var shape = this._wmCursorAt(x, y);
  if (shape !== this._wmCursor) {
    this._wmCursor = shape;
    this._onCursor(shape);
  }
};

/* kind: 'move' | 'down' | 'up' | 'wheel'; opts: { button, buttons, wheelX,
 * wheelY, direction, dx, dy }. Returns what happened (for tests/bridge
 * cursors). While the pointer lock is active (todos/0018) the bridge sends
 * moves with dx/dy deltas instead of coordinates. */
Kernel.prototype.wmPointer = function (kind, x, y, opts) {
  opts = opts || {};
  this._wmLastInput = Date.now();      // idle clock (todos/0096) — every real
                                       // pointer path (lock, drags, chrome,
                                       // client) enters here, INJECT_SCREEN
                                       // included; per-window INJECT_POINTER
                                       // deliberately does not (tests can
                                       // poke apps without waking the saver)
  // Overview active (todos/EXPOSE-MISSION-CONTROL.md): a pure presentation
  // override. Pointer input drives hover + pick over the WM's cell rects and
  // is otherwise fully swallowed (no hit test, no chrome, no client delivery).
  // move -> update hoverSid (topmost = last cell in order); down -> PICK{cell
  // sid or 0}; up/wheel eaten. The kernel changes nothing itself — the WM acts
  // on the PICK.
  if (this._wmOverview) {
    var ov = this._wmOverview;
    var hit = 0;
    for (var ci = 0; ci < ov.cells.length; ci++) {
      var c = ov.cells[ci];
      if (x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h) hit = c.sid;
    }
    if (kind === 'move') {
      if (hit !== ov.hoverSid) { ov.hoverSid = hit; this._bumpWm(); }
    } else if (kind === 'down') {
      this._wmEmit(WMP.EV_OVERVIEW_PICK, [hit | 0]);
    }
    return 'overview';   // swallowed whole (down/up/move/wheel)
  }
  // Cursor (todos/0105): recompute the effective cursor on every move (chrome
  // overlay + hovered surface's client cursor), debounced. Before the lock/
  // drag branches so it also updates mid-drag (they early-return); _wmCursorAt
  // reads the same drag/lock state, so the shape is right in every case.
  if (kind === 'move') this._wmEmitCursor(x, y);
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
  // The release matching a grab-consumed press is consumed too (todos/0256,
  // A2): a dismissing click is eaten WHOLE — no stray button-up lands on
  // whatever was under it.
  if (this._wmGrabSwallowUp && kind === 'up') {
    this._wmGrabSwallowUp = false;
    return 'grab-swallow';
  }
  // An in-flight title drag captures the pointer (kernel-enforced capture).
  if (this._wmDrag) {
    var d = this._wmDrag, ds = this._surfaces.get(d.sid);
    if (!ds) { this._wmDrag = null; }
    else if (kind === 'move') {
      // Keep the title bar reachable: clamp to the screen (on-screen size
      // is the dst rect, todos/0024). The move funnels through
      // _wmMoveWithChildren so the anchored subtree follows (todos/0256).
      var dnx = Math.round(x - d.dx);
      var dny = Math.round(y - d.dy);
      dnx = Math.max(40 - ds.dstW, Math.min(dnx, this._wmScreen.w - 40));
      dny = Math.max(WM_TITLE_H, Math.min(dny, this._wmScreen.h - 8));
      this._wmMoveWithChildren(ds, dnx, dny);
      // Aero Snap zones (todos/0095): the POINTER (not the window) within
      // WM_SNAP_MARGIN of a screen edge is a snap gesture — mechanism only:
      // the kernel tracks the zone and tells the WM on every change
      // (EV_SNAP_EDGE, edge 0 = left the zone), policy draws the preview
      // and commits at the drop. Nothing arms until the pointer travels
      // WM_SNAP_SLOP from the mousedown: a click (jitter included) is not
      // a drag. No subscriber, no zones — the drag is byte-identical to
      // pre-0095 (kernel-chrome has no snap, by design).
      if (!d.moved &&
          (Math.abs(x - (d.x0 + d.dx)) > WM_SNAP_SLOP ||
           Math.abs(y - (d.y0 + d.dy)) > WM_SNAP_SLOP))
        d.moved = true;
      if (this._wmSubs.size && d.moved) {
        var sm = WM_SNAP_MARGIN, sw = this._wmScreen.w, sh = this._wmScreen.h;
        var eL = x < sm, eR = x >= sw - sm, eT = y < sm, eB = y >= sh - sm;
        var edge = eT && eL ? 4 : eT && eR ? 5 : eB && eL ? 6 : eB && eR ? 7
          : eL ? 1 : eR ? 2 : eT ? 3 : 0;
        if (edge !== (d.edge | 0)) {
          d.edge = edge;
          this._wmEmit(WMP.EV_SNAP_EDGE, [d.sid, edge]);
        }
      }
      this._bumpWm();
      return 'drag';
    } else if (kind === 'up') {
      var dend = this._wmDrag;
      this._wmDrag = null;
      var dsurf = this._surfaces.get(dend.sid);
      if (dsurf) this._wmEmit(WMP.EV_MOVED, [dsurf.sid, dsurf.x, dsurf.y]);
      // The snap drop (todos/0095): after the EV_MOVED so policy's model
      // holds the drop position. Emitted for every drag that actually
      // MOVED (past WM_SNAP_SLOP) with a subscriber — edge 0 is the
      // drag-off-restore signal for a snapped/maximized window, and a
      // motionless title click must NOT restore (the double-click's first
      // click is exactly that). x0/y0 = the pre-drag position (see
      // drag-start), so a snap commit can save the true floating rect.
      if (dsurf && dend.moved && this._wmSubs.size)
        this._wmEmit(WMP.EV_SNAP_DROP,
          [dsurf.sid, dend.edge | 0, dend.x0 | 0, dend.y0 | 0]);
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
      this._bumpWm();
      return 'resize';
    } else if (kind === 'up') {
      var rdend = this._wmResizeDrag;
      this._wmResizeDrag = null;
      this._bumpWm();
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
  // you see. Minimized and unmapped (todos/0069) surfaces aren't on screen;
  // borderless ones (taskbar-class) have no title-bar band and no frame.
  for (var i = this._zOrder.length - 1; i >= 0; i--) {
    var s = this._surfaces.get(this._zOrder[i]);
    if (!s || s.minimized || !s.mapped) continue;
    if (s.parentSid && this._wmAnchorHidden(s)) continue;   // hides with its
                                                            // parent (0256)
    var dw = s.dstW, dh = s.dstH;
    var inTitle = !s.borderless &&
      x >= s.x && x < s.x + dw && y >= s.y - WM_TITLE_H && y < s.y;
    var inClient = x >= s.x && x < s.x + dw && y >= s.y && y < s.y + dh;
    // The resize frame (todos/0019): a band around title+client, accepting
    // presses out to WM_BORDER_HIT past the E/S edges — fatter than the 4px
    // drawn frame (#388); the focus-only N/W edges keep the thin band.
    var inFrame = !s.borderless && !inTitle && !inClient &&
      x >= s.x - WM_BORDER && x < s.x + dw + WM_BORDER_HIT &&
      y >= s.y - WM_TITLE_H - WM_BORDER && y < s.y + dh + WM_BORDER_HIT;
    // The SE grip's inward reach (#388): on a RESIZABLE surface a press in
    // the client's bottom-right WM_GRIP_IN square starts an SE resize — the
    // only way a maximized/snapped window (band clipped/covered outward)
    // stays resizable. 'down' only: moves/ups/wheels still reach the app.
    var inGrip = inClient && !s.borderless && s.resizable &&
      x >= s.x + dw - WM_GRIP_IN && y >= s.y + dh - WM_GRIP_IN;
    // The grab gate (todos/0256, A2): this surface is the topmost hit — with
    // a grab active, a press anywhere but the client area of the holder's
    // own window tree dismisses the holder and is consumed (chrome included:
    // Win95 eats the title click that closes a menu).
    if ((inTitle || inClient || inFrame) && kind === 'down' &&
        this._wmGrabs.length) {
      var gd = this._wmGrabConsume(s, inClient);
      if (gd) return gd;
    }
    if (inFrame || (inGrip && kind === 'down')) {
      if (kind === 'down') {
        this.wmFocus(s.sid);
        // Drag zones on E/S/SE edges. Both kinds get them since todos/0024;
        // the release dispatches on the resizable bit — configure (0019) vs
        // scale the dst rect (fixed-res apps like doom stay oblivious).
        var ex = x >= s.x + dw ? 1 : 0;                // right edge -> E
        var ey = y >= s.y + dh ? 1 : 0;                // bottom edge -> S
        // A WM_GRIP_HIT corner zone widens E/S into SE near the corner;
        // the inward grip square (#388) is SE by definition.
        if (ex && y >= s.y + dh - WM_GRIP_HIT) ey = 1;
        if (ey && x >= s.x + dw - WM_GRIP_HIT) ex = 1;
        if (inGrip) { ex = 1; ey = 1; }
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
          // agents/wmctl can still kill), with the #486 hung-app watchdog
          // armed — an owner that never consumes the request is force-quit
          // after the grace period (wmCloseRequest).
          this.wmCloseRequest(s.sid);
          return 'close';
        }
        // Title-bar boxes (todos/0030), Win95 order [min][max][close] —
        // same metrics, left of the close box. Like close, box clicks
        // never focus and never start a drag or the double-click timer.
        // Each box exists only if it FITS inside the title (a WM_MIN_SIZE
        // window keeps a draggable title instead of an unreachable one);
        // the same rule gates the composites.
        var mx0 = cx0 - WM_CLOSE_W - WM_BOX_GAP;         // maximize box
        var nx0 = mx0 - WM_CLOSE_W - WM_BOX_GAP;         // minimize box
        if (y >= cy0 && y < cy0 + WM_CLOSE_W) {
          if (mx0 >= s.x && x >= mx0 && x < mx0 + WM_CLOSE_W) {
            // Maximize = the 0025 gesture: EV_TITLE_ACTIVATE to the WM
            // (policy owns the toggle); no subscriber -> the same no-op
            // as wmctl max (kernel-chrome has no maximize, by design).
            return this.wmTitleActivate(s.sid) === 0 ? 'title-activate' : 'title-box';
          }
          if (nx0 >= s.x && x >= nx0 && x < nx0 + WM_CLOSE_W) {
            // Minimize is kernel MECHANISM already — the box calls it
            // directly and works with no WM (focus-fall included).
            this.wmMinimize(s.sid);
            return 'minimize';
          }
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
        // x0/y0: the pre-drag position — EV_SNAP_DROP carries it so policy
        // can save the true floating rect for a later restore (todos/0095;
        // the drag-end EV_MOVED has already overwritten the live one).
        this._wmDrag = { sid: s.sid, dx: x - s.x, dy: y - s.y, x0: s.x, y0: s.y };
        return 'drag-start';
      }
      return 'title';
    }
    if (inClient) {
      // Click-to-focus — except borderless (taskbar-class) surfaces, which
      // receive the click but never steal focus: a taskbar click must see
      // the focus state it's acting ON (minimize-toggle), and Win95 agrees.
      // A borderless surface gets focus only via the WM protocol.
      // An anchored child focuses its top-level ROOT instead (todos/0256,
      // §3.1): clicking a background window's popup activates that window,
      // matching Windows — the child itself never takes focus.
      if (kind === 'down') {
        if (s.parentSid) this.wmFocus(this._wmAnchorRoot(s).sid);
        else if (!s.borderless) this.wmFocus(s.sid);
      }
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
  // A press on the bare desktop while a grab is active dismisses + consumes
  // too (todos/0256, A2) — the classic click-away-closes-the-menu.
  if (kind === 'down' && this._wmGrabs.length) {
    var gdd = this._wmGrabConsume(null, false);
    if (gdd) return gdd;
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
               hasAlpha: !!s.hasAlpha,          // per-pixel alpha (todos/0063)
               layer: s.layer | 0,
               mapped: !!s.mapped,              // map-on-placement (todos/0069)
               parent: s.parentSid | 0,         // anchored child (todos/0256)
               configurePending: !!s.pendingConfigure,
               frameSeq: Atomics.load(s.i32, SH_SEQ) });
  }
  return out;
};

/* Re-sort _zOrder by z layer (todos/0038). Array.prototype.sort is stable
 * (ES2019), so within a layer the existing order — including the raise/
 * lower/create that just happened — is preserved; the sort only pushes a
 * surface back inside its layer's band. Called after EVERY z mutation:
 * that is the whole always-on-top mechanism (a raise lands at the top of
 * its OWN layer, never above a +1-pinned bar; a lower lands at the bottom
 * of its layer, never under a -1-pinned desktop). */
Kernel.prototype._wmZNormalize = function () {
  var self = this;
  this._zOrder.sort(function (a, b) {
    var sa = self._surfaces.get(a), sb = self._surfaces.get(b);
    return (sa ? sa.layer : 0) - (sb ? sb.layer : 0);
  });
  // Anchored-child post-pass (todos/0256, A1): re-slot each child subtree
  // immediately above its parent, creation-ordered depth-first, so children
  // can never interleave with foreign windows in ANY rendering — z-order
  // leaves the kernel already correct and the compositor / headless
  // composite / hit test stay anchor-blind (zero lines there, §3.0).
  // Children ride their root's layer by construction; normalization runs
  // after every z mutation, which is the whole raise-as-subtree mechanism.
  if (!this._wmAnchoredN) return;
  var out = [], seen = new Set();
  var emit = function (sid) {
    if (seen.has(sid)) return;
    seen.add(sid);
    out.push(sid);
    var s = self._surfaces.get(sid);
    if (!s) return;
    for (var i = 0; i < s.children.length; i++) {
      var c = self._surfaces.get(s.children[i]);
      if (c) { c.layer = s.layer; emit(c.sid); }
    }
  };
  for (var i = 0; i < this._zOrder.length; i++) {
    var t = this._surfaces.get(this._zOrder[i]);
    if (t && t.parentSid) continue;      // children are emitted by their parent
    emit(this._zOrder[i]);
  }
  for (var j = 0; j < this._zOrder.length; j++) {  // defensive: never drop a sid
    if (!seen.has(this._zOrder[j])) out.push(this._zOrder[j]);
  }
  this._zOrder = out;
};

/* Pin a surface to a z layer (todos/0038): -1 below normal windows (the
 * desktop layer), 0 normal, +1 above (the taskbar). Mechanism only — which
 * surfaces are furniture is WM policy (/bin/wm pins its own windows); the
 * no-WM fallback never sets layers, so kernel-chrome behavior is untouched.
 * No event: the window record carries the layer (word 11). */
/* The wm* command methods return 0 on success or an errno NAME on failure
 * (todos/0242) — see WMP_ERRNO and the R_ERR payload contract above. */
Kernel.prototype.wmSetLayer = function (sid, layer) {
  var s = this._surfaces.get(sid | 0);
  if (!s) return 'EINVAL';
  if (s.parentSid) return 'EPERM';   // children ride the parent's layer (0256)
  layer = layer | 0;
  if (layer < -1 || layer > 1) return 'EINVAL';
  if (s.layer === layer) {
    this._wmMap(s.sid);         // a stacking op maps even as a no-op (0069)
    return 0;
  }
  s.layer = layer;
  this._wmMap(s.sid);           // stacking maps (todos/0069)
  this._wmZNormalize();
  this._bumpWm();
  return 0;
};

Kernel.prototype.wmFocus = function (sid) {
  var s = this._surfaces.get(sid | 0);
  if (!s) return 'EINVAL';
  // Anchored children never take focus (todos/0256, §3.1) — focusing one
  // focuses (and raises, restores) its top-level root instead, the same
  // policy as a client click on the child.
  if (s.parentSid) s = this._wmAnchorRoot(s);
  if (s.minimized) {                                            // focus restores
    s.minimized = false;
    this._wmAnimPush(s, 'restore');   // compositor animation (todos/0063)
    this._bumpWm();
    this._wmEmit(WMP.EV_MINIMIZED, [s.sid, 0]);
  }
  var zi = this._zOrder.indexOf(s.sid);
  if (zi >= 0 && zi !== this._zOrder.length - 1) {
    this._zOrder.splice(zi, 1);
    this._zOrder.push(s.sid);
    this._wmZNormalize();                       // raise stays within the layer
                                                // (subtree re-slots with it)
    this._bumpWm();      // z changed even if focus doesn't below (todos/0165)
  }
  this._wmSetFocus(s.sid);          // the A9 funnel: owner pair + EV_FOCUS
  this._wmSyncPointerLock();
  return 0;
};

Kernel.prototype.wmMove = function (sid, x, y) {
  var s = this._surfaces.get(sid | 0);
  if (!s) return 'EINVAL';
  // Anchored geometry derives from the parent (todos/0256, A11): the
  // materializer would clobber a direct move on the next relayout, so the
  // op refuses loud instead of lying. Same rule for the other WM geometry/
  // stacking/minimize ops below — the WM never manages children (§3.1).
  if (s.parentSid) return 'EPERM';
  this._wmMoveWithChildren(s, x | 0, y | 0);   // subtree follows (A1)
  this._wmMap(s.sid);           // placement maps (todos/0069)
  this._bumpWm();
  this._wmEmit(WMP.EV_MOVED, [s.sid, s.x, s.y]);
  return 0;
};

/* Ask the client to resize (todos/0019). Geometry does NOT change here —
 * the surface keeps its old buffer and size until the SURFACE_CONFIGURE
 * ack lands (so a slow client shows its last frame, never a torn one).
 * Latest wins: a new request while one is pending replaces it, and the ack
 * path re-issues the configure if the client acked a stale size. Fails with
 * the delivery errno (ESRCH dead process, EAGAIN full ring) when the request
 * can't reach the client: nothing would ever ack, so no pending state is
 * left behind. Non-resizable surfaces (no SDL_WINDOW_RESIZABLE, todos/0021)
 * refuse outright with EPERM — same no-pending-state rule: the app would
 * never renegotiate. */
Kernel.prototype.wmResize = function (sid, w, h) {
  var s = this._surfaces.get(sid | 0);
  if (!s) return 'EINVAL';
  if (s.parentSid) return 'EPERM';   // children resize owner-side only (0256)
  if (!s.resizable) return 'EPERM';
  w = w | 0; h = h | 0;
  if (w < WM_MIN_SIZE || h < WM_MIN_SIZE || w > 8192 || h > 8192) return 'EINVAL';
  if (w === s.w && h === s.h && !s.pendingConfigure) {
    this._wmMap(s.sid);         // a geometry op maps even as a no-op (0069)
    return 0;
  }
  var prev = s.pendingConfigure;
  s.pendingConfigure = { w: w, h: h };
  var err = this._wmEventTo(s.sid, [WMEV.WINDOW_RESIZED, 0, w, h, 0, 0, 0, 0]);
  if (err) {
    s.pendingConfigure = prev;
    return err;
  }
  this._wmMap(s.sid);           // the WM sized it: placement decided (0069)
  return 0;
};

/* Set the on-screen dst viewport of a FIXED-SIZE surface (todos/0024 —
 * the wp_viewport / DWM-DPI-virtualization shape): the buffer keeps its
 * size, the compositor maps it to dstW x dstH (nearest-neighbor), input
 * inverse-maps, and the app never knows. Resizable surfaces refuse — they
 * configure (todos/0019/0021); the two modes are exclusive by design, and
 * maximize (todos/0025) dispatches on the same bit. Echoes EV_SCALED. */
Kernel.prototype.wmSetDst = function (sid, w, h) {
  var s = this._surfaces.get(sid | 0);
  if (!s) return 'EINVAL';
  if (s.parentSid) return 'EPERM';   // child dst is INHERITED (0256, A11)
  if (s.resizable) return 'EPERM';
  w = w | 0; h = h | 0;
  if (w < WM_MIN_SIZE || h < WM_MIN_SIZE || w > 8192 || h > 8192) return 'EINVAL';
  if (w === s.dstW && h === s.dstH) {
    this._wmMap(s.sid);         // a geometry op maps even as a no-op (0069)
    return 0;
  }
  s.dstW = w; s.dstH = h;
  if (s.children.length) this._wmAnchorLayout(s);  // scale inheritance (A11):
                                                   // popups ride the new dst
  this._wmMap(s.sid);           // placement maps (todos/0069)
  this._bumpWm();
  this._wmEmit(WMP.EV_SCALED, [s.sid, w, h]);
  return 0;
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
  if (!s) return 'EINVAL';
  if (s.borderless) return 'EPERM';
  if (!this._wmSubs.size) return 'ENODEV';
  this._wmEmit(WMP.EV_TITLE_ACTIVATE, [s.sid]);
  return 0;
};

/* Fire the window-cycling gesture (todos/0032) — the same EV_CYCLE the
 * Alt+Tab-family chord emits, so wmctl cycle and the keyboard share ONE
 * policy path in /bin/wm. Mechanism only: the kernel keeps no cycle
 * state; policy picks the next window and sends FOCUS. Refuses without a
 * subscriber (cycling IS policy — nothing would ever answer). */
Kernel.prototype.wmCycle = function (dir) {
  if (!this._wmSubs.size) return 'ENODEV';
  this._wmEmit(WMP.EV_CYCLE, [(dir | 0) < 0 ? -1 : 1]);
  return 0;
};

/* Fire the Start-menu gesture (todos/0078) — the same EV_MENU the
 * Ctrl+Esc chord emits, so wmctl menu and the keyboard share ONE policy
 * path in /bin/wm (the menu toggle). Mechanism only: the kernel keeps no
 * menu state; policy owns the columns. Refuses without a subscriber (the
 * menu IS policy — nothing would ever answer). */
Kernel.prototype.wmMenu = function () {
  if (!this._wmSubs.size) return 'ENODEV';
  this._wmEmit(WMP.EV_MENU, []);
  return 0;
};

/* Fire the Aero Snap gesture (todos/0095) — the same EV_SNAP_KEY the
 * Win+arrow chord emits, so wmctl snap and the keyboard share ONE policy
 * path in /bin/wm. Mechanism only: the kernel keeps no snap state; policy
 * holds the per-window snap edge and the saved floating rect. Refuses
 * without a subscriber (snap IS policy — nothing would ever answer). */
Kernel.prototype.wmSnap = function (dir) {
  if (!this._wmSubs.size) return 'ENODEV';
  this._wmEmit(WMP.EV_SNAP_KEY, [dir & 3]);
  return 0;
};

/* Ms since the last real user input (todos/0096) — the screensaver policy's
 * idle clock. Mechanism only: the kernel keeps NO timeout and NO saver
 * state; /bin/wm polls this over GET_IDLE and applies its configured
 * timeout. Clamped into an i32 for the wire. */
Kernel.prototype.wmIdleMs = function () {
  return Math.min(0x7fffffff, Math.max(0, Date.now() - this._wmLastInput));
};

/* Fire the screensaver gesture (todos/0096) — wmctl saver and the Control
 * Panel Preview button ride this into EV_SAVER, the wmMenu pattern. Policy
 * raises the configured saver immediately. Refuses without a subscriber
 * (the saver IS policy — nothing would ever answer). */
Kernel.prototype.wmSaver = function () {
  if (!this._wmSubs.size) return 'ENODEV';
  this._wmEmit(WMP.EV_SAVER, []);
  return 0;
};

/* Fire the window system-menu gesture (todos/0102) — the same EV_SYSMENU the
 * Alt+Space chord emits, so wmctl sysmenu and the keyboard share ONE policy
 * path in /bin/wm (Restore/Move/Size/Minimize/Maximize/Close). Carries the
 * currently-focused sid; policy raises the menu on it (ignores sid 0).
 * Mechanism only: the kernel keeps no menu state. Refuses without a
 * subscriber (the menu IS policy — nothing would ever answer). */
Kernel.prototype.wmSysMenu = function () {
  if (!this._wmSubs.size) return 'ENODEV';
  this._wmEmit(WMP.EV_SYSMENU, [this._focusSid | 0]);
  return 0;
};

/* Minimize: off screen + out of hit-testing, still listed. Focus falls via
 * _wmFocusFall (topmost normal-layer window first — todos/0039). Restore =
 * wmFocus (which un-minimizes). */
Kernel.prototype.wmMinimize = function (sid) {
  var s = this._surfaces.get(sid | 0);
  if (!s) return 'EINVAL';
  if (s.parentSid) return 'EPERM';   // visibility derives from the parent (0256)
  if (s.minimized) return 0;
  s.minimized = true;
  this._wmAnimPush(s, 'min');   // transient compositor animation (todos/0063)
  this._wmEmit(WMP.EV_MINIMIZED, [s.sid, 1]);
  if (this._wmDrag && this._wmDrag.sid === s.sid) this._wmDrag = null;
  if (this._wmResizeDrag && this._wmResizeDrag.sid === s.sid) this._wmResizeDrag = null;
  if (this._focusSid === s.sid) this._wmFocusFall();
  this._bumpWm();
  this._wmSyncPointerLock();
  return 0;
};

/* place: 0 = raise to top (without stealing focus), 1 = lower to bottom —
 * of the surface's own z LAYER (todos/0038): the normalize below pushes it
 * back inside its band, so a lower never sinks under a pinned desktop and
 * a raise never covers a pinned taskbar. */
Kernel.prototype.wmRestack = function (sid, place) {
  var s = this._surfaces.get(sid | 0);
  if (!s) return 'EINVAL';
  if (s.parentSid) return 'EPERM';   // children re-slot with the parent (0256)
  var zi = this._zOrder.indexOf(s.sid);
  if (zi < 0) return 'EINVAL';
  this._zOrder.splice(zi, 1);
  if ((place | 0) === 1) this._zOrder.unshift(s.sid);
  else this._zOrder.push(s.sid);
  this._wmMap(s.sid);           // stacking maps (todos/0069)
  this._wmZNormalize();
  this._bumpWm();
  return 0;
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
  return 'EINVAL';              // unknown kind
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

/* Label text into an RGBA composite (todos/0275): render via the ksvc blob
 * at WM_LABEL_PX and src-over the straight-alpha bytes with the exact 0063
 * integer formula, clipped to W*H. Geometry contract with compositor.js
 * (the two composites MUST place text identically): x is the left edge
 * (opts.cx: the center — the caller passes the strip's center x), y is the
 * vertical CENTER (opts.top: the top edge); the label centers itself from
 * the render header's h. No textService (bare-Kernel embedders): no text. */
Kernel.prototype._blitLabel = function (out, W, H, x, y, text, maxW, rgba, opts) {
  if (!this.textService) return;
  var r = this.textService.render(text, WM_LABEL_PX, Math.ceil(maxW), rgba, 1);
  var x0 = Math.round(opts && opts.cx ? x - r.w / 2 : x);
  var y0 = Math.round(opts && opts.top ? y : y - r.h / 2);
  var b = r.bytes;
  for (var gy = 0; gy < r.h; gy++) {
    var oy = y0 + gy;
    if (oy < 0 || oy >= H) continue;
    for (var gx = 0; gx < r.w; gx++) {
      var ox = x0 + gx;
      if (ox < 0 || ox >= W) continue;
      var si = (gy * r.w + gx) * 4;
      var a = b[si + 3];
      if (!a) continue;
      var di = (oy * W + ox) * 4, inv = 255 - a;
      out[di] = (b[si] * a + out[di] * inv + 127) / 255 | 0;
      out[di + 1] = (b[si + 1] * a + out[di + 1] * inv + 127) / 255 | 0;
      out[di + 2] = (b[si + 2] * a + out[di + 2] * inv + 127) / 255 | 0;
      out[di + 3] = 255;
    }
  }
};

/* Screenshot the screen: CPU composite of the scene in z-order — desktop
 * fill, then each surface's front buffer + its kernel chrome. Since
 * todos/0275 label TEXT is part of the deterministic composite too: title
 * captions, the close-box 'x' and Exposé captions render via the kernel's
 * ksvc text service (the SAME blob the browser compositor uses — same
 * bytes, same rasterizer, same geometry, so the two composites agree on
 * text everywhere; browser-only affordances left are furniture: AA
 * shadows, rounded corners, glass). Row blits when unscaled; a
 * nearest-neighbor loop maps the buffer into the dst viewport when scaled
 * (todos/0024). */
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
  // Overview / Exposé (todos/EXPOSE-MISSION-CONTROL.md): the SAME presentation
  // the browser compositor draws, minus the browser-only furniture (shadows +
  // rounded corners). Per cell in order: a border frame (navy when hovered,
  // face gray otherwise — hover follows the injected pointer, so it is
  // deterministic) then the window's LIVE front buffer NN scale-blitted into
  // the cell rect, then the caption centered under the cell (ksvc text,
  // todos/0275 — the same blob and geometry as compositor.js drawOverview).
  // Minimized windows composite their still-live buffers like any other.
  // Goldens stay bit-exact and `wmctl shot` sees the overview — which is
  // what makes the e2e honest.
  if (this._wmOverview) {
    var ovcells = this._wmOverview.cells;
    var hoverSid = this._wmOverview.hoverSid | 0;
    var OVB = 3;                                    // border-frame thickness
    for (var oi = 0; oi < ovcells.length; oi++) {
      var oc = ovcells[oi];
      var os = this._surfaces.get(oc.sid);
      if (!os) continue;
      fill(oc.x - OVB, oc.y - OVB, oc.w + 2 * OVB, oc.h + 2 * OVB,
           oc.sid === hoverSid ? WM_COLORS.titleFocused : WM_COLORS.border);
      var ofront = Atomics.load(os.i32, SH_FLIP) & 1;
      var obase = SH_HDR_BYTES + ofront * os.w * os.h * 4;
      var ox0 = Math.max(0, -oc.x), oy0 = Math.max(0, -oc.y);
      var ox1 = Math.min(oc.w, W - oc.x), oy1 = Math.min(oc.h, H - oc.y);
      for (var ody = oy0; ody < oy1; ody++) {
        var osrow = obase + Math.floor(ody * os.h / oc.h) * os.w * 4;
        var odrow = ((oc.y + ody) * W + oc.x) * 4;
        for (var odx = ox0; odx < ox1; odx++) {
          var osi = osrow + Math.floor(odx * os.w / oc.w) * 4;
          var odi = odrow + odx * 4;
          out[odi] = os.u8[osi]; out[odi + 1] = os.u8[osi + 1];
          out[odi + 2] = os.u8[osi + 2]; out[odi + 3] = 255;
        }
      }
      // Caption centered under the cell (compositor drawOverview's exact
      // formula: x centered on rendered width, top edge = cell bottom + 2).
      this._blitLabel(out, W, H, oc.x + oc.w / 2, oc.y + oc.h + 2,
        os.title || ('pid ' + os.pid), Math.max(8, oc.w), 0xFFFFFFFF,
        { cx: true, top: true });
    }
    return { w: W, h: H, rgba: out };
  }
  for (var i = 0; i < this._zOrder.length; i++) {
    var s = this._surfaces.get(this._zOrder[i]);
    if (!s || s.minimized || !s.mapped) continue;   // unmapped: todos/0069
    if (s.parentSid && this._wmAnchorHidden(s)) continue;   // hides with its
                                                            // parent (0256)
    var dw = s.dstW, dh = s.dstH;      // on-screen rect (todos/0024)
    // Chrome: resize frame under title bar + close box (borderless surfaces
    // draw bare). The frame is one outer fill; title + client cover its
    // middle — cheap, and exactly the hit-test geometry.
    if (!s.borderless) {
      fill(s.x - WM_BORDER, s.y - WM_TITLE_H - WM_BORDER,
        dw + 2 * WM_BORDER, WM_TITLE_H + dh + 2 * WM_BORDER, WM_COLORS.border);
      fill(s.x, s.y - WM_TITLE_H, dw, WM_TITLE_H,
        s.sid === this._focusSid ? WM_COLORS.titleFocused : WM_COLORS.titleBlurred);
      // Title text (todos/0275): the SAME string + maxW arithmetic + center
      // formula as compositor.js's title labelFor call — the two composites'
      // text contract.
      this._blitLabel(out, W, H, s.x + 6, s.y - WM_TITLE_H / 2,
        s.title || ('pid ' + s.pid),
        Math.max(8, dw - 3 * (WM_CLOSE_W + WM_BOX_GAP) - 16), 0xFFFFFFFF);
      // Title-bar boxes, Win95 order [min][max][close] (todos/0030) — the
      // same offsets and fit-gating the hit test uses. Glyphs are
      // deterministic flat rects (bar / hollow box) plus the ksvc-rasterized
      // close 'x' (todos/0275).
      var bx = s.x + dw - WM_CLOSE_W - WM_CLOSE_PAD;
      var by = s.y - WM_TITLE_H + WM_CLOSE_PAD;
      var mxx = bx - WM_CLOSE_W - WM_BOX_GAP;
      var nxx = mxx - WM_CLOSE_W - WM_BOX_GAP;
      var glyph = [0, 0, 0, 255];
      fill(bx, by, WM_CLOSE_W, WM_CLOSE_W, WM_COLORS.closeBox);
      this._blitLabel(out, W, H, bx + 5, by + WM_CLOSE_W / 2 + 1,
        'x', 32, 0x000000FF);
      if (mxx >= s.x) {
        fill(mxx, by, WM_CLOSE_W, WM_CLOSE_W, WM_COLORS.closeBox);
        fill(mxx + 4, by + 4, 12, 2, glyph);             // max: hollow box
        fill(mxx + 4, by + 14, 12, 1, glyph);
        fill(mxx + 4, by + 4, 1, 11, glyph);
        fill(mxx + 15, by + 4, 1, 11, glyph);
      }
      if (nxx >= s.x) {
        fill(nxx, by, WM_CLOSE_W, WM_CLOSE_W, WM_COLORS.closeBox);
        fill(nxx + 4, by + 14, 10, 2, glyph);            // min: the bar
      }
    }
    // Client pixels: front buffer rows, clipped to the screen.
    var front = Atomics.load(s.i32, SH_FLIP) & 1;
    var base = SH_HDR_BYTES + front * s.w * s.h * 4;
    var sx0 = Math.max(0, -s.x), sy0 = Math.max(0, -s.y);
    var sx1 = Math.min(dw, W - s.x), sy1 = Math.min(dh, H - s.y);
    if (s.hasAlpha) {
      // Per-pixel src-over (todos/0063), deterministic integer math:
      // out = floor((src*a + dst*(255-a) + 127) / 255) — i.e. src/255
      // rounded to nearest. Uses the scaled path's nearest dst->src
      // mapping, which is the identity when unscaled.
      for (var ay = sy0; ay < sy1; ay++) {
        var arow = base + Math.floor(ay * s.h / dh) * s.w * 4;
        var adrow = ((s.y + ay) * W + s.x) * 4;
        for (var ax = sx0; ax < sx1; ax++) {
          var asi = arow + Math.floor(ax * s.w / dw) * 4;
          var adi = adrow + ax * 4;
          var aa = s.u8[asi + 3], ainv = 255 - aa;
          out[adi] = (s.u8[asi] * aa + out[adi] * ainv + 127) / 255 | 0;
          out[adi + 1] = (s.u8[asi + 1] * aa + out[adi + 1] * ainv + 127) / 255 | 0;
          out[adi + 2] = (s.u8[asi + 2] * aa + out[adi + 2] * ainv + 127) / 255 | 0;
          out[adi + 3] = 255;
        }
      }
    } else if (dw === s.w && dh === s.h) {
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
  // Fan the new dims out to every live page (todos/0179) — per-process cost
  // is a handful of atomic stores, and resizes are human-rate.
  var self = this;
  this._procs.forEach(function (p) {
    if (p.state !== STATE_ZOMBIE) self._vdsoPublish(p);
  });
  this._bumpWm();
  this._wmEmit(WMP.EV_SCREEN, [w, h]);
  for (var i = 0; i < this._zOrder.length; i++) {
    var s = this._surfaces.get(this._zOrder[i]);
    if (!s || s.borderless) continue;
    var nx = Math.max(40 - s.dstW, Math.min(s.x, w - 40));
    var ny = Math.max(WM_TITLE_H, Math.min(s.y, h - 8));
    if (nx === s.x && ny === s.y) continue;
    this._wmMoveWithChildren(s, nx, ny);   // subtree follows the clamp (0256)
    this._wmEmit(WMP.EV_MOVED, [s.sid, s.x, s.y]);
  }
  // Re-materialize every anchored subtree against the NEW screen bounds
  // (todos/0256): the child's into-the-screen clamp depends on the screen
  // dims even when its top-level didn't move (borderless roots are skipped
  // by the loop above but their popups must still slide back on-screen).
  if (this._wmAnchoredN) {
    for (var j = 0; j < this._zOrder.length; j++) {
      var t = this._surfaces.get(this._zOrder[j]);
      if (t && !t.parentSid && t.children.length) this._wmAnchorLayout(t);
    }
  }
};

/* Downscaled front-buffer thumbnail (todos/0063, Aero Peek): the surface's
 * CPU pixels box-filtered to fit maxW x maxH, aspect preserved, never
 * upscaled. Deterministic (integer accumulate, floor divide) so agents can
 * golden it; gpu-transport surfaces thumb black, same caveat as
 * wmScreenshot. Serving it kernel-side keeps the WMP payload small — the
 * WM asks for exactly the popup size instead of shipping full frames. */
Kernel.prototype.wmThumbnail = function (sid, maxW, maxH) {
  var s = this._surfaces.get(sid | 0);
  if (!s) return null;
  maxW = Math.max(1, Math.min((maxW | 0) || 96, 512));
  maxH = Math.max(1, Math.min((maxH | 0) || 72, 512));
  var scale = Math.min(maxW / s.w, maxH / s.h, 1);
  var tw = Math.max(1, Math.round(s.w * scale));
  var th = Math.max(1, Math.round(s.h * scale));
  var front = Atomics.load(s.i32, SH_FLIP) & 1;
  var base = SH_HDR_BYTES + front * s.w * s.h * 4;
  // Anchored children composite INTO the thumbnail (todos/0256, menu arch
  // A10): a window's thumbnail is the window as composited — the parent's
  // buffer plus its mapped anchored subtree at anchor positions, clipped to
  // the parent rect. Without this, a persistent child (the M1 menu bar)
  // would leave a stale strip in every Aero-Peek thumb. Child pixels blit
  // opaquely (the thumb is a box-filtered preview, not the exact composite).
  var srcU8 = s.u8, srcBase = base;
  if (s.children.length) {
    var comp = new Uint8Array(s.w * s.h * 4);
    comp.set(s.u8.subarray(base, base + s.w * s.h * 4));
    var self = this;
    var blitKids = function (p) {
      for (var i = 0; i < p.children.length; i++) {
        var c = self._surfaces.get(p.children[i]);
        if (!c || !c.mapped) continue;
        // Materialized screen coords -> parent BUFFER space; the child's
        // buffer size maps 1:1 there (its dst rides the same ratio, A11).
        var bx = Math.round((c.x - s.x) * s.w / s.dstW);
        var by = Math.round((c.y - s.y) * s.h / s.dstH);
        var cf = Atomics.load(c.i32, SH_FLIP) & 1;
        var cbase = SH_HDR_BYTES + cf * c.w * c.h * 4;
        var x0 = Math.max(0, -bx), y0 = Math.max(0, -by);
        var x1 = Math.min(c.w, s.w - bx), y1 = Math.min(c.h, s.h - by);
        for (var yy = y0; yy < y1; yy++) {
          var srow = cbase + (yy * c.w + x0) * 4;
          comp.set(c.u8.subarray(srow, srow + (x1 - x0) * 4),
                   ((by + yy) * s.w + (bx + x0)) * 4);
        }
        blitKids(c);
      }
    };
    blitKids(s);
    srcU8 = comp; srcBase = 0;
  }
  var out = new Uint8Array(tw * th * 4);
  for (var dy = 0; dy < th; dy++) {
    var sy0 = Math.floor(dy * s.h / th);
    var sy1 = Math.max(sy0 + 1, Math.floor((dy + 1) * s.h / th));
    for (var dx = 0; dx < tw; dx++) {
      var sx0 = Math.floor(dx * s.w / tw);
      var sx1 = Math.max(sx0 + 1, Math.floor((dx + 1) * s.w / tw));
      var r = 0, g = 0, b = 0;
      for (var sy = sy0; sy < sy1; sy++) {
        var row = srcBase + (sy * s.w + sx0) * 4;
        for (var sx = sx0; sx < sx1; sx++) {
          r += srcU8[row]; g += srcU8[row + 1]; b += srcU8[row + 2];
          row += 4;
        }
      }
      var n = (sy1 - sy0) * (sx1 - sx0);
      var di = (dy * tw + dx) * 4;
      out[di] = (r / n) | 0; out[di + 1] = (g / n) | 0;
      out[di + 2] = (b / n) | 0; out[di + 3] = 255;
    }
  }
  return { w: tw, h: th, rgba: out };
};

/* Aero glass tier toggle (todos/0063): browser-compositor-only backdrop
 * blur behind window chrome. Kernel state so wmctl/tests can flip it, but
 * the headless composite NEVER reads it — goldens stay bit-exact. */
Kernel.prototype.wmGlass = function (on) {
  on = !!on;
  if (this._wmGlassOn !== on) { this._wmGlassOn = on; this._bumpWm(); }
  return 0;                     // no failure mode: a pure state toggle
};

/* Record a transient minimize/restore animation (todos/0063): geometry AT
 * the transition + a wall-clock stamp. The browser compositor interpolates
 * from it; wmScene() prunes expired records, so headless kernels just
 * accumulate-and-drop tiny objects. */
Kernel.prototype._wmAnimPush = function (s, kind) {
  this._wmAnims.set(s.sid, { sid: s.sid, kind: kind, x: s.x, y: s.y,
                             w: s.dstW, h: s.dstH, t0: Date.now() });
  this._bumpWm();
};

/* Scene accessors for the browser compositor (same worker; it may hold the
 * returned surface objects and read their SABs/bitmaps directly). */
Kernel.prototype.wmScene = function () {
  var self = this;
  var now = Date.now();                 // prune expired animations (todos/0063)
  this._wmAnims.forEach(function (a, sid) {
    if (now - a.t0 > WM_ANIM_MS) self._wmAnims.delete(sid);
  });
  // Overview enter/exit flies (todos/EXPOSE): prune past WM_ANIM_MS so a
  // settled overview (or a settled exit) stops churning the compositor.
  if (this._wmOverviewAnims.length &&
      now - this._wmOverviewAnims[0].t0 > WM_ANIM_MS) this._wmOverviewAnims = [];
  return {
    version: this._wmVersion,
    screen: { w: this._wmScreen.w, h: this._wmScreen.h },
    focusSid: this._focusSid,
    pointerLockWanted: this._wmPtrLockWanted,   // relative mouse (todos/0018)
    resizeDrag: this._wmResizeDrag,   // rubber-band preview (todos/0019)
    glass: this._wmGlassOn,           // Aero glass tier (todos/0063)
    overview: this._wmOverview,       // window overview / Exposé (todos/EXPOSE):
                                      // null or { cells:[{sid,x,y,w,h}], hoverSid }
    overviewAnims: this._wmOverviewAnims,   // enter/exit flies (browser-only)
    anims: Array.from(this._wmAnims.values()),  // minimize/restore (todos/0063)
    surfaces: this._zOrder.map(function (sid) { return self._surfaces.get(sid); })
      .filter(function (s) {
        // Anchored children hidden by an ancestor leave the scene entirely
        // (todos/0256) — the browser compositor stays anchor-blind, with
        // ONE sanctioned exception: the group fly (0256 menu arch). While
        // the child's ROOT has a live minimize/restore animation, the
        // whole anchored subtree must ride the fly as a rigid group (pre-
        // 0259 the bar was painted INTO the parent's pixels and rode for
        // free; a separate surface must be told to). The kernel computes
        // the linkage — animRootSid names the root whose anim record the
        // compositor should transform this child by — so the compositor
        // stays geometry-dumb: it never walks parentSid chains, it just
        // resolves the anim by (animRootSid || sid). A min-direction child
        // is anchor-hidden (root minimized) but KEPT while the fly is
        // live; restore-direction children are visible anyway (minimized
        // clears before the restore push) and only need the linkage.
        if (!s) return false;
        if (!s.parentSid) return true;
        var root = self._wmAnchorRoot(s);
        var anim = self._wmAnims.get(root.sid);   // post-prune: live or absent
        s.animRootSid = anim ? root.sid : 0;
        if (!self._wmAnchorHidden(s)) return true;
        return !!(anim && anim.kind === 'min');
      }),
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
  var n = Math.min(31, enc.length);
  // Truncation snaps back to a whole UTF-8 sequence (the user32.c
  // w2a_trunc "no split UTF-8" rule) so the record never renders tofu.
  while (n > 0 && n < enc.length && (enc[n] & 0xC0) === 0x80) n--;
  out.set(enc.subarray(0, n));                          // always NUL-terminated
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
              (s.resizable ? 16 : 0) | (s.hasAlpha ? 32 : 0) |
              (s.parentSid ? 64 : 0) |    // WMP_F_ANCHORED (todos/0256)
              (s.transient ? 128 : 0);   // WMP_F_TRANSIENT (todos/0281)
  var fields = [s.sid, s.pid, s.x, s.y, s.w, s.h,
                this._zOrder.indexOf(s.sid), flags, Atomics.load(s.i32, SH_SEQ),
                s.dstW, s.dstH, s.layer | 0];
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
  this.sockServe(path || WM_SOCK_PATH, function (peer, pcb) {
    // conn.pid: the connecting process — the map-on-placement borderless
    // exception (todos/0069) needs to know which surfaces a subscriber owns.
    var conn = { peer: peer, acc: [], pid: pcb ? pcb.pid : 0 };
    peer.onData = function (chunk) {
      for (var i = 0; i < chunk.length; i++) conn.acc.push(chunk[i]);
      for (;;) {
        if (conn.acc.length < 4) return;
        var len = (conn.acc[0] | (conn.acc[1] << 8) | (conn.acc[2] << 16) |
                   (conn.acc[3] << 24)) >>> 0;
        if (len < 4 || len > (1 << 20)) {       // corrupt stream: hang up
          self._wmSubDrop(conn);
          peer.close();
          return;
        }
        if (conn.acc.length < 4 + len) return;
        var frame = Uint8Array.from(conn.acc.splice(0, 4 + len));
        self._wmpDispatch(conn, new DataView(frame.buffer).getUint32(4, true),
                          new DataView(frame.buffer), len - 4);
      }
    };
    peer.onClose = function () { self._wmSubDrop(conn); };
  });
};

Kernel.prototype._wmpDispatch = function (conn, type, dv, plen) {
  var self = this;
  var g = function (i) { return (i + 1) * 4 <= plen ? dv.getInt32(8 + i * 4, true) : 0; };
  var gf = function (i) { return (i + 1) * 4 <= plen ? dv.getFloat32(8 + i * 4, true) : 0; };
  // e: 0 = R_OK; an errno NAME (a wm* method's return) = R_ERR carrying the
  // real cause as its distinct i32 (todos/0242; see the WMP_ERRNO table).
  var ok = function (e) {
    conn.peer.send(e ? self._wmpFrame(WMP.R_ERR, [WMP_ERRNO[e] || WMP_ERRNO.EINVAL])
                     : self._wmpFrame(WMP.R_OK, []));
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
    case WMP.CYCLE: ok(this.wmCycle(g(0))); break;
    case WMP.MENU: ok(this.wmMenu()); break;           // Start menu (0078)
    case WMP.SNAP: ok(this.wmSnap(g(0))); break;       // Aero Snap (0095)
    case WMP.GET_IDLE:                                 // idle clock (0096)
      conn.peer.send(this._wmpFrame(WMP.R_IDLE, [this.wmIdleMs()]));
      break;
    case WMP.CURSOR_AT:                                // cursor shape (0105)
      conn.peer.send(this._wmpFrame(WMP.R_CURSOR, [this._wmCursorAt(gf(0), gf(1))]));
      break;
    case WMP.SAVER: ok(this.wmSaver()); break;         // screensaver (0096)
    case WMP.SYSMENU: ok(this.wmSysMenu()); break;     // window sys menu (0102)
    case WMP.GRAB_SET: ok(this.wmGrabSet(conn, dv, plen)); break;  // key grabs
    case WMP.OVERVIEW_SET: ok(this.wmOverviewSet(conn, dv, plen)); break;  // Exposé
    case WMP.OVERVIEW_END: ok(this.wmOverviewEnd(conn)); break;
    case WMP.OVERVIEW: ok(this.wmOverview()); break;   // wmctl overview gesture

    case WMP.SET_LAYER: ok(this.wmSetLayer(g(0), g(1))); break;
    case WMP.GLASS: ok(this.wmGlass(g(0) !== 0)); break;   // Aero tier (0063)
    case WMP.FOCUS: ok(this.wmFocus(g(0))); break;
    case WMP.MINIMIZE: ok(this.wmMinimize(g(0))); break;
    case WMP.RESTORE: ok(this.wmFocus(g(0))); break;    // focus restores
    case WMP.RESTACK: ok(this.wmRestack(g(0), g(1))); break;
    case WMP.CLOSE_REQ:
      ok(this.wmCloseRequest(g(0)));  // QUIT + the #486 hung-app watchdog
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
    case WMP.INJECT_SCREEN: {
      // Screen-coordinate injection (todos/0095): the raw wmPointer path —
      // hit test, chrome, title drags, snap zones — exactly what the UI
      // bridge feeds it. wmPointer always reports what happened, so this
      // never fails; R_OK doubles as the sequencing barrier.
      var sKind = ['move', 'down', 'up'][g(0)] || 'move';
      var sOpts = sKind === 'move' ? { buttons: g(3) } : { button: g(3) || 1 };
      this.wmPointer(sKind, gf(1), gf(2), sOpts);
      ok(0);
      break;
    }
    case WMP.INJECT_WMKEY:
      // Keyboard injection (#423): the raw wmKey path — grab table, chord
      // swallow, overview, focus routing — exactly what the UI bridge feeds
      // it. The 0x22 rule again: wmKey always reports what happened (event,
      // delivery, or drop), so this never fails; R_OK is the barrier.
      this.wmKey(g(0) !== 0, g(1), g(2), g(3), g(4) !== 0);
      ok(0);
      break;
    case WMP.SHOT: case WMP.SHOT_SCREEN: case WMP.THUMB: {
      var shot = type === WMP.SHOT ? this.wmScreenshot(g(0))
        : type === WMP.THUMB ? this.wmThumbnail(g(0), g(1), g(2))   // 0063
        : this.wmScreenshotScreen();
      if (!shot) { ok('EINVAL'); break; }          // null = unknown sid
      var head = new Uint8Array(12 + shot.rgba.length);
      var hdv = new DataView(head.buffer);
      hdv.setInt32(0, type === WMP.SHOT_SCREEN ? 0 : g(0), true);
      hdv.setInt32(4, shot.w, true);
      hdv.setInt32(8, shot.h, true);
      head.set(shot.rgba, 12);
      conn.peer.send(this._wmpFrame(WMP.R_SHOT, null, head));
      break;
    }
    default: ok('ENOSYS');                         // unknown op
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
      if (o.end !== 'read' || self._pipeAvail(o.pipe) > 0 || !o.pipe.wOpen) r.push(fd);
    }
    else if (o.kind === 'socket') {
      // conn: data or peer-gone EOF; listening: a queued connection;
      // fresh/bound: ready (the read fails immediately, so it won't block).
      if (o.st === 'conn') { if (o.rx.buf.length > 0 || !o.rx.wOpen) r.push(fd); }
      else if (o.st === 'listening') { if (o.pending.length > 0) r.push(fd); }
      else r.push(fd);
    }
    else if (o.kind === 'watch') {
      // FS_WATCH: readable iff records (or the overflow latch) are
      // pending. This branch is mandatory, not an optimization — the
      // default arm below reports unknown kinds always-readable, which
      // would spuriously wake every parked watcher forever.
      if (o.queue.length > 0 || o.overflowed) r.push(fd);
    }
    else if (o.kind === 'http') {
      // HTTP transfer (todos/0417): readable iff at least one CONSUMABLE
      // is pending — an UNCONSUMED status, queued body bytes, clean EOF,
      // or the error. Mandatory branch, the watch rule above. The status
      // leg is gated on statusConsumed because headers-arrived is a
      // PERMANENT condition: without the bit, a caller that consumed the
      // status and now waits for the first body byte finds the fd
      // readable forever and spins (wait -> read -> EAGAIN -> wait). The
      // done/error legs stay permanent ON PURPOSE — a pipe at EOF is
      // also readable forever, and 0 bytes (or the error) is the honest
      // answer.
      var hx = o.xfer;
      if ((hx.status !== null && !hx.statusConsumed) ||
          hx.bytes > 0 || hx.done || hx.error !== null) r.push(fd);
    }
    else if (o.kind !== 'out') r.push(fd);
  });
  wfds.forEach(function (fd) {
    var id = pcb.fds.get(fd | 0);
    var o = id === undefined ? null : self._ofds.get(id);
    if (o && o.kind === 'pipe' && o.end === 'write' &&
        self._pipeFree(o.pipe) === 0 && o.pipe.rOpen) return;      // full: not ready
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
    } else if (tty._eofFlag || tty._hupFlag) {
      tty._consumeEof();
      this._cancelWaiter(pcb);
      this._respondRaw(pcb, new Uint8Array(0));
    } else {
      break;                                             // no data for anyone eligible
    }
  }
  this._recheckSelects();
};

/* Re-scan every deferred select — and the fd side of every unified WAIT
 * (todos/0178) — after any readiness change (tty bytes, pipe data/space,
 * pipe end closed, a connection queued on a listener). */
Kernel.prototype._recheckSelects = function () {
  var self = this;
  this._procs.forEach(function (pcb) {
    if (!pcb.waiter) return;
    if (pcb.waiter.op === 'select' || pcb.waiter.op === 'uwait') {
      var ready = self._selectScan(pcb, pcb.waiter.r, pcb.waiter.w);
      if (ready.count > 0) {
        var isWait = pcb.waiter.op === 'uwait';
        self._cancelWaiter(pcb);
        self._respond(pcb, isWait ? { why: 1, r: ready.r, w: ready.w } : ready);
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

/* Pipe storage accessors (todos/0181): a ringed pipe keeps its bytes in
 * the shared ring IN EVERY MODE (see the PR_* block); everything else
 * (sockets, ptys, ring-less pipes — fake-worker tests) keeps the JS buf.
 * Every kernel touch point goes through these so the two storages can't
 * diverge. */
Kernel.prototype._pipeAvail = function (dir) {
  return dir.ring ? pipeRingAvail(dir.ring) : dir.buf.length;
};
Kernel.prototype._pipeFree = function (dir) {
  return dir.ring ? dir.ring.cap - pipeRingAvail(dir.ring) : dir.cap - dir.buf.length;
};
Kernel.prototype._pipeTake = function (dir, n) {
  if (dir.ring) return pipeRingTake(dir.ring, n);
  return Uint8Array.from(dir.buf.splice(0, n));
};
Kernel.prototype._pipePut = function (dir, data) {
  if (dir.ring) { pipeRingPut(dir.ring, data); return; }
  for (var i = 0; i < data.length; i++) dir.buf.push(data[i]);
};

/* Park-side half of the suppressed-doorbell protocol: latch "someone is
 * parked on this end" in the ring header BEFORE the caller's readiness
 * rescan, and record the word on the waiter so _cancelWaiter (the single
 * wake choke point — serve, EINTR, timeout, kill) clears it. Flag order vs
 * the fast peer's commit-then-check is what makes wakes lossless. */
Kernel.prototype._pipeFlagWait = function (waiter, dir, word) {
  if (!dir.ring) return;
  Atomics.store(dir.ring.i32, word, 1);
  (waiter.flagged = waiter.flagged || []).push({ i32: dir.ring.i32, word: word });
};

/* Raise parked-peer flags for every ringed pipe end a select/uwait names
 * (mode-independent: a brokered-mode flag is just never read). Runs BEFORE
 * the readiness scan; _clearFlags/_cancelWaiter drop them. */
Kernel.prototype._waitFlagRings = function (pcb, waiter) {
  var self = this;
  var flagList = function (fds, end, word) {
    for (var i = 0; i < fds.length; i++) {
      var id = pcb.fds.get(fds[i] | 0);
      var o = id === undefined ? null : self._ofds.get(id);
      if (o && o.kind === 'pipe' && o.end === end) self._pipeFlagWait(waiter, o.pipe, word);
    }
  };
  flagList(waiter.r || [], 'read', PR_RWAIT);
  flagList(waiter.w || [], 'write', PR_WWAIT);
};

Kernel.prototype._clearFlags = function (waiter) {
  if (!waiter.flagged) return;
  for (var i = 0; i < waiter.flagged.length; i++) {
    Atomics.store(waiter.flagged[i].i32, waiter.flagged[i].word, 0);
  }
  waiter.flagged = null;
};

/* Blocking stream ops shared by pipes and connected sockets — `dir` is one
 * pipe-shaped direction. Deferred waiters register under the pipe op names
 * so _pipeNotify/_cancelWaiter serve both kinds unchanged. */
Kernel.prototype._streamRead = function (pcb, dir, count) {
  // POSIX read(fd, buf, 0): return 0 immediately, never park — even on an
  // empty stream with a live writer (the 0252 R1 class, kernel-brokered
  // side: pipes / sockets / pty master). BEFORE any avail check or waiter
  // enqueue, matching the host.js R1 short-circuit.
  if (count === 0) { this._respondRaw(pcb, new Uint8Array(0)); return; }
  var avail = this._pipeAvail(dir);
  if (avail > 0) {
    this._respondRaw(pcb, this._pipeTake(dir, Math.min(count, avail)));
    this._pipeNotify(dir);                        // space freed: writers may proceed
    return;
  }
  if (!dir.wOpen) { this._respondRaw(pcb, new Uint8Array(0)); return; }  // EOF
  pcb.waiter = { op: 'piperead', pipe: dir, count: count };  // served by _pipeNotify
  this._pipeFlagWait(pcb.waiter, dir, PR_RWAIT);
  dir.readWaiters.push(pcb.pid);
  // Flag-then-rescan: a fast writer that committed between the avail check
  // above and the flag store sees no flag — so look again now that it's up.
  if (dir.ring && pipeRingAvail(dir.ring) > 0) this._pipeNotify(dir);
};

Kernel.prototype._streamWrite = function (pcb, dir, data) {
  // A zero-length write on a pipe/socket is unspecified by POSIX; gucOS
  // takes the Linux answer for both ("null write succeeds", fs/pipe.c;
  // AF_UNIX's send loop never iterates for len 0): respond 0 BEFORE the
  // EPIPE/SIGPIPE check and before any space check — a full stream must
  // never park a zero-length writer. (#644)
  if (data.length === 0) { this._respond(pcb, { n: 0 }); return; }
  if (!dir.rOpen || !dir.wOpen) {
    // POSIX: write to a pipe/socket nobody reads = EPIPE + SIGPIPE (default
    // action terminates — the `yes | head` pipeline death). !wOpen is the
    // socket shutdown(SHUT_WR) case: the direction's write side is gone
    // even though this OFD is still referenced.
    this._respond(pcb, { errno: 'EPIPE' });
    this._deliver(pcb, SIG.PIPE);
    return;
  }
  var free = this._pipeFree(dir);
  if (free === 0 || (data.length <= PIPE_ATOMIC && data.length > free)) {
    // Full (or a PIPE_ATOMIC-small write that would split): block.
    // Copy the bytes OUT of the SAB payload region — it's reused.
    pcb.waiter = { op: 'pipewrite', pipe: dir, data: data.slice() };
    this._pipeFlagWait(pcb.waiter, dir, PR_WWAIT);
    dir.writeWaiters.push(pcb.pid);
    if (dir.ring && dir.ring.cap - pipeRingAvail(dir.ring) > free) this._pipeNotify(dir);
    return;
  }
  var n = Math.min(free, data.length);
  this._pipePut(dir, data.subarray(0, n));
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
    var ri = 0;
    while (ri < pipe.readWaiters.length) {
      var rpcb = this._procs.get(pipe.readWaiters[ri]);
      if (!rpcb || !rpcb.waiter || rpcb.waiter.op !== 'piperead' || rpcb.waiter.pipe !== pipe) {
        pipe.readWaiters.splice(ri, 1);
        continue;
      }
      // Serve-time eligibility (#647): a STOPPED process's parked read stays
      // parked and consumes nothing — the _ttyNotify rule (a Ctrl-Z'd reader
      // must not steal bytes a running reader behind it in the FIFO should
      // get, and bytes handed to a stopped-then-killed process are destroyed
      // where the pipe would have kept them). _contProcess re-notifies this
      // stream on resume, so the skip can never strand the waiter. Writers
      // are deliberately NOT gated: a parked write's bytes were committed at
      // the write() call, so completing it while stopped loses nothing and
      // unblocks running readers.
      if (rpcb.state === STATE_STOPPED) { ri++; continue; }
      var ravail = this._pipeAvail(pipe);
      if (ravail > 0) {
        var count = rpcb.waiter.count;
        this._cancelWaiter(rpcb);                       // splices index ri out
        this._respondRaw(rpcb, this._pipeTake(pipe, Math.min(count, ravail)));
        progress = true;
      } else if (!pipe.wOpen) {
        this._cancelWaiter(rpcb);
        this._respondRaw(rpcb, new Uint8Array(0));     // EOF
        progress = true;
      } else {
        break;                                          // no data for anyone eligible
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
      var free = this._pipeFree(pipe);
      if (free === 0 || (data.length <= PIPE_ATOMIC && data.length > free) ||
          (ww.whole && data.length > free)) break;
      this._cancelWaiter(wpcb);
      var n = ww.whole ? data.length : Math.min(free, data.length);
      this._pipePut(pipe, data.subarray(0, n));
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

/* ---- HTTP transport (0x06xx; todos/0172, fd-shaped since todos/0417) ----
 * Fetch-backed HTTP for processes. The kernel owns the fetch; the process
 * drives it through three ops plus the ordinary fd layer. A transfer is
 * fetch-shaped: request (method, url, headers, optional whole body) ->
 * response headers -> streamed body -> clean EOF or error. HTTP_OPEN
 * returns an ORDINARY FD whose OFD (kind 'http') owns the transfer, so any
 * number of transfers multiplex against pipes, watches, the input ring and
 * a timeout through one FS_SELECT/FS_WAIT: readable iff a CONSUMABLE is
 * pending (_selectScan), body drains via FS_READ (EAGAIN when dry — http
 * fds NEVER park; the contract is WAIT first, then consume until EAGAIN,
 * the watch-fd discipline), close via FS_CLOSE (_ofdUnref's last release
 * aborts the fetch — teardown is _exitProcess's ordinary fd sweep).
 * HTTP_STATUS is non-blocking (EAGAIN before headers) and consumes the
 * status. The body queue is a chunk list with kernel-side backpressure
 * (the async reader pauses past HTTP_BUF_CAP), the same bounded-buffer
 * discipline as pipes. Two kernel deadlines bound every transfer (headers
 * + idle; see HTTP_HEADERS_MS above; expiry = ETIMEDOUT on the error leg).
 * Needs the fd layer: no opts.fs -> HTTP_OPEN answers ENOSYS, like every
 * 0x04xx op. NOT a socket layer; TLS is the fetch stack's. */
Kernel.prototype._httpRpc = function (pcb, op, req) {
  switch (op) {
    case OP.HTTP_BODY: {
      // RAW [u32 off][bytes...] — stage the request body contiguously (off 0
      // opens a fresh stage), mirroring CLIP_SET. Consumed by HTTP_OPEN.
      var hb = req.raw;
      if (!hb || hb.length < 4) { this._respond(pcb, { errno: 'EFAULT' }); break; }
      var bdv = new DataView(hb.buffer, hb.byteOffset, hb.length);
      var boff = bdv.getUint32(0, true);
      var bbytes = hb.subarray(4);
      var stage = pcb._httpStage;
      if (boff === 0) { stage = pcb._httpStage = { parts: [], len: 0 }; }
      if (!stage || boff !== stage.len) { pcb._httpStage = null;
        this._respond(pcb, { errno: 'EINVAL' }); break; }
      if (bbytes.length) { stage.parts.push(bbytes.slice()); stage.len += bbytes.length; }
      this._respond(pcb, {});
      break;
    }
    case OP.HTTP_OPEN: {
      // The transfer is an fd, so both halves are required: the embedder's
      // fetch AND the fd layer (no opts.fs -> no fd table to live in).
      if (!this._fetch || !this._fs) { pcb._httpStage = null; this._respond(pcb, { errno: 'ENOSYS' }); break; }
      var method = (req.method || 'GET') + '';
      var url = (req.url || '') + '';
      var hdrs = Array.isArray(req.headers) ? req.headers : [];
      // Deadlines: > 0 overrides the kernel default; idleMs < 0 disables
      // the idle deadline (headers stays bounded no matter what).
      var headersMs = (req.headersMs | 0) > 0 ? (req.headersMs | 0) : HTTP_HEADERS_MS;
      var idleMs = (req.idleMs | 0) > 0 ? (req.idleMs | 0)
        : ((req.idleMs | 0) < 0 ? 0 : HTTP_IDLE_MS);
      // Consume any staged body (join the chunks).
      var body = null, st = pcb._httpStage; pcb._httpStage = null;
      if (st && st.len) {
        body = new Uint8Array(st.len);
        for (var pi = 0, po = 0; pi < st.parts.length; pi++) { body.set(st.parts[pi], po); po += st.parts[pi].length; }
      }
      var xfer = {
        status: null, headers: null,          // set when response headers arrive
        statusConsumed: false,                // HTTP_STATUS spends the status leg
        chunks: [], bytes: 0, cap: HTTP_BUF_CAP,
        done: false, error: null, errno: null, aborted: false, paused: false,
        ac: (typeof AbortController !== 'undefined') ? new AbortController() : null,
        reader: null,
        idleMs: idleMs, hdrTimer: null, idleTimer: null,
      };
      var ho = this._makeOfd('http', { xfer: xfer });
      ho.refs++;
      var hfd = 0;
      while (pcb.fds.has(hfd)) hfd++;
      pcb.fds.set(hfd, ho.id);
      this._httpStart(xfer, method, url, hdrs, body, headersMs);
      this._respond(pcb, { fd: hfd });
      break;
    }
    case OP.HTTP_STATUS: {
      var sid = pcb.fds.get(req.fd | 0);
      var so = sid === undefined ? null : this._ofds.get(sid);
      if (!so || so.kind !== 'http') { this._respond(pcb, { errno: 'EBADF' }); break; }
      var xs = so.xfer;
      if (xs.error !== null && xs.status === null) {
        this._respond(pcb, { errno: xs.errno || 'EIO', error: xs.error }); break;
      }
      if (xs.status !== null) {
        // Spend the status leg of readability. Without this bit,
        // headers-arrived is permanent and a caller waiting for the first
        // body byte would find the fd readable forever (todos/0417).
        xs.statusConsumed = true;
        this._respond(pcb, { status: xs.status, headers: xs.headers || '' }); break;
      }
      this._respond(pcb, { errno: 'EAGAIN' });   // not yet — WAIT on the fd
      break;
    }
    case OP.HTTP_ERROR: {
      // The error-TEXT peek (#392): hand the transfer's recorded failure
      // text to the process. Non-consuming and stateless — callable before,
      // during and after HTTP_STATUS/FS_READ have reported the errno — so a
      // consumer can always enrich its errno with the transport's own words
      // (CURLOPT_ERRORBUFFER is the first customer). '' while healthy.
      var eid = pcb.fds.get(req.fd | 0);
      var eo = eid === undefined ? null : this._ofds.get(eid);
      if (!eo || eo.kind !== 'http') { this._respond(pcb, { errno: 'EBADF' }); break; }
      var ex = eo.xfer;
      // {error} only — the caller already holds the errno from the failing
      // HTTP_STATUS/FS_READ, and an errno key here would read as an RPC
      // failure to the host-side hook plumbing.
      this._respond(pcb, { error: ex.error !== null ? ex.error : '' });
      break;
    }
    default:
      this._respond(pcb, { errno: 'ENOSYS' });
  }
};

/* Compose a fetch rejection's honest text (#392). Node's fetch buries the
 * useful part (connect ECONNREFUSED host:port, ENOTFOUND, a TLS verdict) in
 * err.cause and rejects with a bare "fetch failed" on top — surface both,
 * skipping the cause when the top-level message already carries it (the
 * net-bridge wrapper digs its own cause out; ticket #393). */
function _fetchErrorText(err) {
  var msg = (err && err.message) ? (err.message + '') : 'fetch failed';
  var cause = err && err.cause && err.cause.message ? (err.cause.message + '') : '';
  if (cause && msg.indexOf(cause) < 0) msg += ' (' + cause + ')';
  return msg;
}

/* Flatten a fetch Headers object into a capped "name: value\n" blob. Order
 * and casing are whatever fetch yields (not wire-faithful — documented).
 * A server-sent `x-guc-final-url` is dropped: that name is the transport's
 * synthetic final-URL line (#359, prepended in _httpStart), and an upstream
 * copy in the same blob would make it ambiguous. This is the one choke
 * point both modes flatten through (bridge pairs arrive via the wrapper's
 * forEach shim), so the filter covers direct and bridge alike. */
Kernel.prototype._httpFlattenHeaders = function (headers) {
  var out = '';
  try {
    headers.forEach(function (v, k) {
      if ((k + '').toLowerCase() === 'x-guc-final-url') return;
      if (out.length < 64 * 1024) out += k + ': ' + v + '\n';
    });
  } catch (e) {}
  return out;
};

/* Kick off the fetch. Resolves headers (or a pre-body error) then streams the
 * body through the reader under backpressure. Aborted transfers drop silently
 * (close / process teardown already reclaimed them); a deadline-expired
 * transfer keeps its ETIMEDOUT (the error guard on both handlers — the
 * AbortError rejection the expiry provokes must not overwrite it). Every
 * state change that adds a consumable ends in _recheckSelects, which is the
 * whole wake path now: nothing parks on a transfer, only on the fd. */
Kernel.prototype._httpStart = function (xfer, method, url, headerList, body, headersMs) {
  var self = this;
  var pairs = [];
  for (var i = 0; i < headerList.length; i++) {
    var line = headerList[i] + '';
    var c = line.indexOf(':');
    if (c > 0) pairs.push([line.slice(0, c).trim(), line.slice(c + 1).trim()]);
  }
  var init = { method: method, headers: pairs, redirect: 'follow' };
  if (xfer.ac) init.signal = xfer.ac.signal;
  if (body && body.length) init.body = body;
  if (headersMs > 0) {
    xfer.hdrTimer = setTimeout(function () {
      xfer.hdrTimer = null;
      self._httpExpire(xfer, 'response headers deadline expired (' + headersMs + 'ms)');
    }, headersMs);
  }
  var p;
  try { p = Promise.resolve(this._fetch(url, init)); }
  catch (e) { p = Promise.reject(e); }        // synchronous throw (bad URL)
  p.then(function (resp) {
    if (xfer.aborted || xfer.error !== null) return;
    if (xfer.hdrTimer) { clearTimeout(xfer.hdrTimer); xfer.hdrTimer = null; }
    xfer.status = resp.status;
    // #359: surface the post-redirect FINAL URL as one synthetic header
    // line. Direct mode reads the real Response.url; the bridge wrapper
    // mirrors it as a .url property on its synthetic response. Absent
    // either (a bare test fetch), the request url is the honest answer.
    // PREPENDED so the line always survives the 64 KB flatten cap; the
    // intermediate hops stay unknowable — platform fetch follows
    // redirects opaquely in both modes (permanent ceiling, documented).
    var finalUrl = (typeof resp.url === 'string' && resp.url) ? resp.url : url;
    xfer.headers = 'x-guc-final-url: ' + finalUrl + '\n'
      + self._httpFlattenHeaders(resp.headers);
    xfer.reader = (resp.body && typeof resp.body.getReader === 'function') ? resp.body.getReader() : null;
    if (!xfer.reader) {                        // no streamable body (HEAD, empty)
      xfer.done = true; self._recheckSelects(); return;
    }
    self._httpIdleArm(xfer);
    self._httpPump(xfer);
    self._recheckSelects();
  }, function (err) {
    if (xfer.aborted || xfer.error !== null) return;
    if (xfer.hdrTimer) { clearTimeout(xfer.hdrTimer); xfer.hdrTimer = null; }
    xfer.error = _fetchErrorText(err);
    // An embedder fetch WRAPPER may pin a POSIX errno NAME on its rejection
    // (err.errno, a string) — the net-bridge wrapper tags a configured-but-
    // unreachable bridge ENETUNREACH (ticket #349; ruling in NETWORK.md
    // Tier 2.5). The typeof check keeps Node system errors out: their
    // .errno is a NUMBER, and their EIO mapping is documented behavior.
    xfer.errno = (err && typeof err.errno === 'string') ? err.errno : 'EIO';
    self._recheckSelects();
  });
};

/* A deadline fired: fail the transfer with ETIMEDOUT — distinguishable from
 * a connect error (EIO) and from clean EOF — and abort the fetch. The fd
 * stays open: the expiry is a CONSUMABLE (the error leg of readability), so
 * a parked FS_WAIT wakes and the reader collects it. */
Kernel.prototype._httpExpire = function (xfer, msg) {
  if (xfer.aborted || xfer.done || xfer.error !== null) return;
  xfer.error = msg;
  xfer.errno = 'ETIMEDOUT';
  if (xfer.idleTimer) { clearTimeout(xfer.idleTimer); xfer.idleTimer = null; }
  if (xfer.ac) { try { xfer.ac.abort(); } catch (e) {} }
  if (xfer.reader) {
    try { var cp = xfer.reader.cancel(); if (cp && cp.catch) cp.catch(function () {}); }
    catch (e) {}
  }
  this._recheckSelects();
};

/* (Re-)arm the idle deadline: the body must deliver a byte within it. Runs
 * only while the kernel is actually waiting on the network — a backpressure
 * pause CLEARS it (that gap is the consumer's, not the server's) and the
 * resume re-arms. idleMs 0 = disabled (HTTP_OPEN idleMs < 0). */
Kernel.prototype._httpIdleArm = function (xfer) {
  var self = this;
  if (xfer.idleTimer) { clearTimeout(xfer.idleTimer); xfer.idleTimer = null; }
  if (!xfer.idleMs || xfer.aborted || xfer.done || xfer.error !== null) return;
  xfer.idleTimer = setTimeout(function () {
    xfer.idleTimer = null;
    self._httpExpire(xfer, 'body idle deadline expired (' + xfer.idleMs + 'ms)');
  }, xfer.idleMs);
};

/* Read one chunk under backpressure: pause past cap (an FS_READ drain
 * resumes us), else pull, queue, wake parked waiters, and continue. */
Kernel.prototype._httpPump = function (xfer) {
  var self = this;
  if (xfer.aborted || xfer.done || xfer.error !== null) return;
  if (xfer.bytes >= xfer.cap) {
    // Backpressure pause: the coming gap is the consumer's, not the
    // server's — the idle clock stops; the drain that resumes us re-arms.
    xfer.paused = true;
    if (xfer.idleTimer) { clearTimeout(xfer.idleTimer); xfer.idleTimer = null; }
    return;
  }
  if (xfer.paused) { xfer.paused = false; this._httpIdleArm(xfer); }
  xfer.reader.read().then(function (r) {
    if (xfer.aborted || xfer.error !== null) return;
    if (r.done) {
      xfer.done = true;
      if (xfer.idleTimer) { clearTimeout(xfer.idleTimer); xfer.idleTimer = null; }
      self._recheckSelects();
      return;
    }
    var chunk = r.value;                       // Uint8Array
    if (chunk && chunk.length) {
      xfer.chunks.push(chunk); xfer.bytes += chunk.length;
      self._httpIdleArm(xfer);                 // a byte arrived: restart the clock
    }
    self._recheckSelects();
    self._httpPump(xfer);
  }, function (err) {
    if (xfer.aborted || xfer.error !== null) return;
    xfer.error = (err && err.message) ? _fetchErrorText(err) : 'stream read failed';
    xfer.errno = 'EIO';
    if (xfer.idleTimer) { clearTimeout(xfer.idleTimer); xfer.idleTimer = null; }
    self._recheckSelects();
  });
};

/* Pull up to `count` bytes off the chunk queue (clamped to the page payload).
 * Slices the head chunk when it straddles the boundary — no per-byte copies. */
Kernel.prototype._httpDrain = function (xfer, count) {
  var want = Math.min(count, KP_PAYLOAD_CAP, xfer.bytes);
  var out = new Uint8Array(want), o = 0;
  while (o < want && xfer.chunks.length) {
    var head = xfer.chunks[0];
    var take = Math.min(head.length, want - o);
    out.set(head.subarray(0, take), o); o += take;
    if (take === head.length) xfer.chunks.shift();
    else xfer.chunks[0] = head.subarray(take);
    xfer.bytes -= take;
  }
  return out;
};

/* Abort + free a transfer — the http OFD's last-release action (_ofdUnref:
 * FS_CLOSE, a dup'd twin's death, or _exitProcess's fd sweep). Never
 * wedges: aborting is idempotent, and nothing ever parks ON a transfer
 * (http fds never park), so there is no waiter to strand. */
Kernel.prototype._httpDestroy = function (xfer) {
  xfer.aborted = true;
  if (xfer.hdrTimer) { clearTimeout(xfer.hdrTimer); xfer.hdrTimer = null; }
  if (xfer.idleTimer) { clearTimeout(xfer.idleTimer); xfer.idleTimer = null; }
  if (xfer.ac) { try { xfer.ac.abort(); } catch (e) {} }
  // cancel() returns a promise that REJECTS when the stream already errored
  // (e.g. a mid-stream drop) — swallow it, or it surfaces as an unhandled
  // rejection and crashes the embedder. The sync try/catch can't catch the
  // async rejection, so attach a .catch.
  if (xfer.reader) {
    try { var cp = xfer.reader.cancel(); if (cp && cp.catch) cp.catch(function () {}); }
    catch (e) {}
  }
};

/* ---- vDSO block (todos/0179) ----
 * Publish the kernel-written, process-read words on a pcb's page under the
 * seqlock (odd = write in progress). The kernel event loop is the single
 * writer by construction, so two Atomics.add bumps are the whole protocol;
 * the seqlock only protects READERS on the process thread from a torn
 * multi-word view. Call after ANY mutation of a published field. */
Kernel.prototype._vdsoPublish = function (pcb) {
  var i32 = pcb.i32;
  if (!i32) return;
  Atomics.add(i32, KP_VD_SEQ, 1);          // odd: readers back off
  Atomics.store(i32, KP_VD_PID, pcb.pid);
  Atomics.store(i32, KP_VD_PPID, pcb.ppid);
  Atomics.store(i32, KP_VD_PGID, pcb.pgid);
  Atomics.store(i32, KP_VD_SID, pcb.sid);
  Atomics.store(i32, KP_VD_BOOT_LO, this._bootMs >>> 0);
  Atomics.store(i32, KP_VD_BOOT_HI, Math.floor(this._bootMs / 4294967296));
  Atomics.store(i32, KP_VD_SCREEN_W, this._wmScreen.w);
  Atomics.store(i32, KP_VD_SCREEN_H, this._wmScreen.h);
  Atomics.add(i32, KP_VD_SEQ, 1);          // even: stable
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
  this._vdsoPublish(t);
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
  // SPSC rings (todos/0181): drop the parked-peer flags this wait raised.
  // Every wake path funnels here (serve, EINTR, timeout, exit), so a flag
  // can't outlive its waiter; a fast peer that already read it just sends
  // one redundant PIPE_KICK.
  this._clearFlags(w);
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
  if (pcb.trace) this._traceExit(pcb, status);   // strace (0046): final lines + EOF
  this._cancelWaiter(pcb);
  this._itimerClear(pcb);        // interval timers die with the process (0044)
  if (pcb.worker) { try { pcb.worker.terminate(); } catch (e) {} }
  pcb.worker = null;
  // Release every fd — this is what makes SIGKILL leak-free under the
  // brokered fs: the kernel, not the dead worker, owns the descriptions,
  // so unlink-while-open lifetimes complete even on a hard kill.
  var self0 = this;
  pcb.fds.forEach(function (ofdId) { self0._ofdUnref(ofdId, pcb.pid); });
  pcb.fds.clear();
  // Parked readdir cursors (todos/0241): a client that died mid-pagination
  // must not leak the backend dir handle — same discipline as fds.
  if (pcb.dirRpc !== null) {
    pcb.dirRpc.forEach(function (d) { self0._fs.closedir(d.dh); });
    pcb.dirRpc = null;
  }
  // Reclaim WM surfaces (same discipline as fds: the kernel, not the dead
  // worker, owns the scene — SIGKILL leaves no ghost windows).
  if (pcb.surfaces.size) {
    Array.from(pcb.surfaces).forEach(function (sid) { self0._wmDestroySurface(sid); });
  }
  pcb.wmRing = null;
  pcb._wmPendingFb = null;
  pcb.wantFrame = false;   // a dead app must not pin the compositor (0169)
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
  // HTTP transfers are fds (todos/0417): the fd sweep above already
  // aborted every live fetch — no dedicated transfer sweep exists.
  pcb._httpStage = null;

  var self = this;
  // Reparent children (running AND zombie) to init.
  var init = this._procs.get(1);
  pcb.children.forEach(function (cpid) {
    var c = self._procs.get(cpid);
    if (!c) return;
    c.ppid = 1;
    self._vdsoPublish(c);        // getppid tracks the reparent (todos/0179)
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
  // Signal 0 is the POSIX existence probe: route + error-check only,
  // deliver nothing (kill(2) — hush's `kill -0 PID` rides on it).
  if (!(sig >= 0 && sig < NSIG)) return { errno: 'EINVAL' };
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
  if (sig === 0) return {};
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
  if (sig === 0) return targets.length;           // probe: count, deliver nothing
  for (var i = 0; i < targets.length; i++) this._deliver(targets[i], sig);
  return targets.length;
};

Kernel.prototype._deliver = function (pcb, sig) {
  // strace (0046): signal arrivals interleave with the RPC lines.
  if (pcb.trace) this._traceLine(pcb, '--- ' + (SIG_NAMES[sig] || 'signal ' + sig) + ' ---');
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

/* ---- interval timers (todos/0044) ----
 * One kernel-side ITIMER_REAL per process; expiry posts SIGALRM through
 * _deliver (so disposition, blocking, and the DFL-terminate action all
 * behave exactly like any other signal — the acceptance "no handler
 * installed terminates" falls out of the disposition mirror). Delivery is
 * cooperative like all signals: a pure-compute loop observes SIGALRM only
 * at its next safe point (settled 0001 caveat). Wall-clock, so a STOPPED
 * process's timer keeps running (POSIX ITIMER_REAL is real time); the
 * pending bit then delivers after SIGCONT. it_interval reloads from "now"
 * at each expiry (setTimeout latency doesn't accumulate into a backlog of
 * SIGALRMs — one pending bit is all the SAB can represent anyway). */

Kernel.prototype._setitimer = function (pcb, which, valueMs, intervalMs) {
  if (which !== ITIMER_REAL) return { errno: 'EINVAL' };
  var old = this._itimerRemaining(pcb);
  this._itimerClear(pcb);
  if (valueMs > 0) this._itimerArm(pcb, valueMs, Math.max(0, intervalMs));
  return old;
};

Kernel.prototype._itimerRemaining = function (pcb) {
  if (!pcb.itimer) return { valueMs: 0, intervalMs: 0 };
  return {
    valueMs: Math.max(1, pcb.itimer.expiresAt - Date.now()),  // armed reads >0 (POSIX: 0 means disarmed)
    intervalMs: pcb.itimer.intervalMs,
  };
};

Kernel.prototype._itimerArm = function (pcb, valueMs, intervalMs) {
  var self = this;
  pcb.itimer = {
    expiresAt: Date.now() + valueMs,
    intervalMs: intervalMs,
    timer: setTimeout(function () { self._itimerFire(pcb); }, valueMs),
  };
};

Kernel.prototype._itimerFire = function (pcb) {
  if (pcb.state === STATE_ZOMBIE || !pcb.itimer) return;   // raced an exit/cancel
  var interval = pcb.itimer.intervalMs;
  // Re-arm BEFORE delivering: a handler's getitimer sees the reloaded
  // value, and if delivery terminates the process (DFL) _exitProcess
  // clears the fresh timer along with everything else.
  if (interval > 0) this._itimerArm(pcb, interval, interval);
  else pcb.itimer = null;
  this._deliver(pcb, SIG.ALRM);
};

Kernel.prototype._itimerClear = function (pcb) {
  if (!pcb.itimer) return;
  clearTimeout(pcb.itimer.timer);
  pcb.itimer = null;
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
  // A read parked across the stop was deliberately skipped by the serve
  // loops (#647: a stopped process is parked, not a consumer) — re-run the
  // stream's notify now so data or EOF that arrived during the stop is
  // served at resume. Without this a resumed pipe reader hangs forever on
  // bytes already sitting in the buffer (a tty self-heals on the next
  // keystroke; a pipe has no such heartbeat).
  var w = pcb.waiter;
  if (w) {
    if (w.op === 'piperead' || w.op === 'pipewrite') this._pipeNotify(w.pipe);
    else if (w.op === 'ttyread') this._ttyNotify(w.tty);
  }
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
 *
 * Process-side read-only volume (todos/0180): with opts.roFs (a LOCAL
 * BlockFS over the kernel-shipped system-image SAB, createV4 readonly) +
 * opts.roPrefix, absolute paths that lexically resolve under the prefix
 * are served IN-PROCESS — zero RPCs for the chattiest startup traffic
 * (fonts, configs, assets under /usr/share). Correctness rules:
 * - A symlink escaping the sealed volume (the /usr/local -> /var/local
 *   class) aborts the local walk (__mountEscape via the MountFS hooks) and
 *   the op retries brokered — the fast path only serves walks that stay
 *   inside the sealed volume. Local errors otherwise are FINAL (the sealed
 *   volume is complete: ENOENT under /usr is real).
 * - Write-intent opens and all path mutators stay brokered: the kernel's
 *   walk owns the EROFS-after-walk rule (todos/0040).
 * - Relative paths stay brokered (the kernel owns the cwd).
 * - Local fds live at RO_FD_BASE+ so they can't collide with kernel fds;
 *   the kernel never sees them. The two places one must become
 *   kernel-visible — dup2 to a low fd, spawn DUP2 file-actions (hush's
 *   `cmd < /usr/...` redirect journal) — promote it: a temporary brokered
 *   O_RDONLY twin of the same file at the same offset (_roPromote).
 * - Documented limits: a local fd not named in any spawn action behaves
 *   as if close-on-exec (children inherit kernel fds only); select/WAIT
 *   can't name a local fd (the fd number exceeds FD_SETSIZE — regular
 *   files are always ready anyway). dup/dup2 within the local space share
 *   the offset like kernel OFDs (BlockFS _dupEntry reuses the entry).
 * ============================================================ */
var RO_FD_BASE = 0x100000;   // local (process-served) fd/dir-handle space

/* Lexical collapse of an ABSOLUTE path (the MountFS._resolvePath algorithm
 * without a cwd — relative paths never reach the fast path). */
function roNormalize(path) {
  var parts = path.split('/'), out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (p === '' || p === '.') continue;
    if (p === '..') { out.pop(); continue; }
    out.push(p);
  }
  return '/' + out.join('/');
}

function RemoteFS(client, opts) {
  this._c = client;
  this._lastError = null;
  // Presence markers for kernel fds ({type:'remote'}, set as fds are handed
  // out). fds 0-2 need NO entry: toWasmEnv's console fast path is gated on
  // the POSITIVE `console` capability only BlockFS's own default entries
  // carry (code-debt CD27), so stdio here falls through to this.write /
  // this.read — the FS_WRITE/FS_READ RPCs — with no decoy to plant.
  this._fdTable = [];
  this._dirs = [];              // opendir snapshots: {entries, pos}
  // Read (as an always-null guard) by toWasmEnv's tty imports over this
  // object (__tcsetattr, isatty pre-override) — stdin flows via FS_READ
  // RPCs, so no ring path may ever engage (todos/0011).
  this._stdinSab = null;
  this._stdinCtrl = null;       // winsize words only (TIOCGWINSZ)
  this._pipes = new Map();      // fd -> ring views {i32,u8,cap,sab,end} (todos/0181)
  // The read-only fast path (todos/0180; header comment above).
  this._ro = null;
  if (opts && opts.roFs && opts.roPrefix) {
    var roFs = opts.roFs, prefix = opts.roPrefix;
    var owns = function (full) {
      if (full === prefix) return '/';
      if (full.lastIndexOf(prefix + '/', 0) === 0) return full.slice(prefix.length);
      return null;
    };
    // Mount hooks (the MountFS wiring, todos/0026): in-volume symlink
    // targets resolve in the FULL namespace; foreign ones throw
    // __mountEscape, which _roLocal turns into the brokered fallback.
    roFs._mountPrefix = prefix;
    roFs._mountOwns = owns;
    this._ro = { fs: roFs, prefix: prefix, owns: owns,
                 fds: new Map() };   // localFd -> { path } (full-namespace)
  }
}

/* The fast-path gate: volume-relative path when `path` is absolute and
 * lexically under the prefix, else null (brokered). A '..' climbing out
 * ('/usr/../etc') collapses first and correctly fails the prefix test. */
RemoteFS.prototype._roRel = function (path) {
  if (this._ro === null || typeof path !== 'string' || path.charAt(0) !== '/') return null;
  return this._ro.owns(roNormalize(path));
};

RemoteFS.prototype._roFd = function (fd) {
  return this._ro !== null && this._ro.fds.has(fd);
};

/* Run a local-volume path op; a cross-volume symlink escape retries
 * brokered. Local errors are final — propagate via _lastError. */
RemoteFS.prototype._roLocal = function (fn, brokered) {
  try {
    var r = fn();
    if (r === null) this._lastError = this._ro.fs._lastError || 'EIO';
    return r;
  } catch (e) {
    if (e && e.__mountEscape) return brokered();
    throw e;
  }
};

/* Dispatch a path op: local when the path gates in, else brokered. */
RemoteFS.prototype._roPath = function (path, localFn, brokeredFn) {
  var rel = this._roRel(path);
  if (rel === null) return brokeredFn();
  var self = this;
  return this._roLocal(function () { return localFn(self._ro.fs, rel); }, brokeredFn);
};

/* Materialize a kernel-side twin of a local fd (same file, same offset) —
 * the one place a local fd becomes kernel-visible (dup2 to a low fd, spawn
 * DUP2 file-actions). O_RDONLY re-open of the recorded full-namespace
 * path: the volume is immutable, so the twin is the same file by
 * construction. Caller closes the twin when done. */
RemoteFS.prototype._roPromote = function (fd) {
  var meta = this._ro.fds.get(fd);
  var pos = this._ro.fs.lseek(fd - RO_FD_BASE, 0, 1 /* SEEK_CUR */);
  var r = this._ok(this._c.call(OP.FS_OPEN, { path: meta.path, flags: 0, mode: 0 }));
  if (r === null) return null;
  this._fdTable[r.fd] = { type: 'remote' };
  if (pos) {
    var s = this._ok(this._c.call(OP.FS_LSEEK, { fd: r.fd, offset: pos, whence: 0 }));
    if (s === null) { this.close(r.fd); return null; }
  }
  return r.fd;
};

/* Wrap the spawnHooks spawn() so DUP2 file-actions whose SOURCE is a local
 * fd (hush's `cmd < /usr/...` redirect journal — pv_open3 really opened in
 * the parent, locally) cross into the kernel's fd table: each such fd gets
 * a temporary brokered twin the child inherits, the action is rewritten to
 * name it, and the parent closes the twin after the spawn returns (the
 * child holds its own refs). The twin is also closed CHILD-side by an
 * appended CLOSE action — unless some action already targets that fd
 * number, in which case the fd there is no longer the twin and closing it
 * would destroy the caller's redirect. Identity without the RO volume. */
RemoteFS.prototype.wrapSpawnHooks = function (hooks) {
  if (this._ro === null) return hooks;
  var self = this;
  var inner = hooks.spawn;
  hooks.spawn = function (spec) {
    var actions = spec.actions || [];
    if (self._ro.fds.size === 0 || actions.length === 0) return inner(spec);
    var temps = null;   // localFd -> kernel twin
    for (var i = 0; i < actions.length; i++) {
      var a = actions[i];
      if (a.op !== 0 || !self._roFd(a.arg)) continue;
      if (temps === null) temps = new Map();
      var k = temps.get(a.arg);
      if (k === undefined) {
        k = self._roPromote(a.arg);
        if (k === null) {
          var err = self._lastError || 'EBADF';
          temps.forEach(function (tfd) { self.close(tfd); });
          return { errno: err };
        }
        temps.set(a.arg, k);
      }
      actions[i] = { op: a.op, fd: a.fd, arg: k, path: a.path, mode: a.mode };
    }
    if (temps !== null) {
      temps.forEach(function (tfd) {
        var taken = actions.some(function (a) {
          return (a.op === 0 || a.op === 1) && a.fd === tfd;
        });
        if (!taken) actions.push({ op: 2, fd: tfd, arg: 0, path: null, mode: 0 });
      });
    }
    var r = inner(spec);
    if (temps !== null) temps.forEach(function (tfd) { self.close(tfd); });
    return r;
  };
  return hooks;
};

RemoteFS.prototype._setErr = function (name) { this._lastError = name; return null; };
RemoteFS.prototype._ok = function (resp) {
  return (resp && resp.errno) ? this._setErr(resp.errno) : resp;
};
/* Winsize-only wiring: keep _stdinSab null so no ring path ever engages. */
RemoteFS.prototype.setStdinSab = function (sab) {
  this._stdinCtrl = sab ? new Int32Array(sab, 0, 8) : null;
};

RemoteFS.prototype.open = function (path, flags, mode) {
  // RO fast path (todos/0180): read-only opens of paths under the sealed
  // volume open locally. Write intent — access mode, O_CREAT|O_TRUNC|
  // O_APPEND (0x640) — stays brokered: the kernel's walk owns the
  // EROFS-after-walk rule and the /usr/local escape (todos/0040).
  var rel = this._roRel(path);
  if (rel !== null && (flags & 3) === 0 && (flags & 0x640) === 0) {
    var self = this;
    return this._roLocal(function () {
      var volFd = self._ro.fs.open(rel, flags, mode);
      if (volFd === null) return null;
      self._ro.fds.set(RO_FD_BASE + volFd,
        { path: self._ro.prefix + (rel === '/' ? '' : rel) });
      return RO_FD_BASE + volFd;
    }, function () { return self._openBrokered(path, flags, mode); });
  }
  return this._openBrokered(path, flags, mode);
};
RemoteFS.prototype._openBrokered = function (path, flags, mode) {
  var r = this._ok(this._c.call(OP.FS_OPEN, { path: path, flags: flags, mode: mode }));
  if (r === null) return null;
  this._fdTable[r.fd] = { type: 'remote' };
  return r.fd;
};
RemoteFS.prototype.close = function (fd) {
  if (this._roFd(fd)) {
    this._ro.fds.delete(fd);
    var lr = this._ro.fs.close(fd - RO_FD_BASE);
    if (lr === null) return this._setErr(this._ro.fs._lastError || 'EIO');
    return 0;
  }
  var r = this._ok(this._c.call(OP.FS_CLOSE, { fd: fd }));
  if (r === null) return null;
  delete this._fdTable[fd];
  this._pipes.delete(fd);
  return 0;
};
RemoteFS.prototype.read = function (fd, buf, count) {
  if (this._roFd(fd)) {
    // Local regular-file read: whole count in one shot (no RPC chunk cap),
    // never parks (no EINTR concern — imports return promptly and the
    // env-import probe stays the signal safe point).
    var n0 = this._ro.fs.read(fd - RO_FD_BASE, buf, count);
    if (n0 === null) return this._setErr(this._ro.fs._lastError || 'EIO');
    return n0;
  }
  // SPSC fast path (todos/0181): consume the shared ring locally while the
  // kernel says FAST. Drain-before-EOF (POSIX); empty parks in FS_WAIT.
  var pr = this._pipes.get(fd);
  if (pr && pr.end === 'read') {
    while (Atomics.load(pr.i32, PR_MODE) === PR_FAST) {
      var avail = pipeRingAvail(pr);
      if (avail > 0) {
        var rn = Math.min(count, avail);
        pipeRingTakeInto(pr, buf, rn);
        if (Atomics.load(pr.i32, PR_WWAIT)) this._c.call(OP.PIPE_KICK, { fd: fd });
        return rn;
      }
      if (Atomics.load(pr.i32, PR_FLAGS) & PRF_WGONE) return 0;   // EOF
      var rw = this._c.call(OP.FS_WAIT, { r: [fd], timeoutMs: null }, true);
      if (rw.errno) return this._setErr(rw.errno);   // EINTR: libc retries post-dispatch
    }
    // Demoted mid-stream (or never promoted): fall through brokered — the
    // kernel serves the very same ring, so nothing is lost.
  }
  // Interruptible: a tty read defers kernel-side; a posted signal turns it
  // into EINTR (regular files respond immediately, so it never fires).
  var r = this._c.call(OP.FS_READ, { fd: fd, count: Math.min(count, KP_FS_CHUNK) }, true);
  if (r.errno) {
    // The C surface only sees errno; keep the transport's real error text
    // visible (the ticket-#78 rule — http transfer failures carry one).
    if (r.error) console.error('read(fd ' + fd + '): ' + r.errno + ': ' + r.error);
    return this._setErr(r.errno);
  }
  if (!r.raw) return this._setErr('EIO');
  buf.set(r.raw);
  var got = r.raw.length;
  // Regular-file fill (todos/0140): a single guest read() of a regular file
  // must return min(count, bytes-to-EOF) in ONE call — matching native/Node's
  // fs.readSync and the RO-volume fast path above — NOT one KP_FS_CHUNK-capped
  // chunk. Each FS_READ reply is bounded by the transport payload, so a
  // >KP_FS_CHUNK request came back short; we loop the RPC until the caller's
  // count is satisfied or EOF. Programs that trust a regular-file read to fill
  // (mGBA's unlooped 16 MB ROM load was the first victim — the zero-tailed ROM
  // derailed the emulated CPU) were silently truncated. SCOPE: regular files
  // ONLY — ttys/pipes/sockets/char-devices keep POSIX short-read semantics
  // (looping them would block on data that may never come), so we only fill
  // when the first chunk came back FULL (a short first chunk is already EOF)
  // and fstat confirms S_IFREG. The classification (one extra RPC) is paid
  // only on the rare >KP_FS_CHUNK read whose first chunk filled — ordinary
  // small reads never reach it.
  if (got < count && got === KP_FS_CHUNK && this._isRegularFd(fd)) {
    while (got < count) {
      var want = Math.min(count - got, KP_FS_CHUNK);
      var rr = this._c.call(OP.FS_READ, { fd: fd, count: want }, true);
      if (rr.errno) return got > 0 ? got : this._setErr(rr.errno);
      if (!rr.raw || rr.raw.length === 0) break;   // EOF
      buf.set(rr.raw, got);
      got += rr.raw.length;
      if (rr.raw.length < want) break;             // short chunk = EOF, done
    }
  }
  return got;
};
/* Regular-file test for read-fill scoping (todos/0140): fstat the fd and
 * check S_IFREG. Every path-opened brokered fd is a 'file' OFD kernel-side,
 * but inherited/dup'd fds carry no process-side kind, so we ask the kernel. */
RemoteFS.prototype._isRegularFd = function (fd) {
  var r = this._ok(this._c.call(OP.FS_FSTAT, { fd: fd }));
  return !!(r && r.st && (r.st.mode & 0xF000) === 0x8000);
};
RemoteFS.prototype.write = function (fd, buf, count) {
  if (this._roFd(fd)) {
    // Same volume class the kernel serves for /usr fds: EROFS.
    var lw = this._ro.fs.write(fd - RO_FD_BASE, buf, count);
    if (lw === null) return this._setErr(this._ro.fs._lastError || 'EIO');
    return lw;
  }
  // SPSC fast path (todos/0181): produce into the shared ring while FAST.
  // Whole-or-block for PIPE_ATOMIC-small writes (POSIX PIPE_BUF), partial
  // landings above it — the brokered _streamWrite rules, verbatim.
  var pw = this._pipes.get(fd);
  if (pw && pw.end === 'write') {
    // Zero-length write: 0 immediately — the _streamWrite rule (Linux
    // "null write succeeds"): never FS_WAIT on a full ring, never
    // EPIPE/SIGPIPE a gone reader. (#644)
    if (count === 0) return 0;
    while (Atomics.load(pw.i32, PR_MODE) === PR_FAST) {
      if (Atomics.load(pw.i32, PR_FLAGS) & PRF_RGONE) {
        // Reader gone: EPIPE, and the kernel deals us our SIGPIPE (the
        // {epipe:1} kick) so default-action death matches brokered runs.
        this._c.call(OP.PIPE_KICK, { fd: fd, epipe: 1 });
        return this._setErr('EPIPE');
      }
      var free = pw.cap - pipeRingAvail(pw);
      if (free === 0 || (count <= PIPE_ATOMIC && count > free)) {
        var ww = this._c.call(OP.FS_WAIT, { w: [fd], timeoutMs: null }, true);
        if (ww.errno) return this._setErr(ww.errno);
        continue;
      }
      var wn = Math.min(free, count);
      pipeRingPut(pw, buf.subarray(0, wn));
      if (Atomics.load(pw.i32, PR_RWAIT)) this._c.call(OP.PIPE_KICK, { fd: fd });
      return wn;
    }
  }
  var n = Math.min(count, KP_FS_CHUNK);
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
  if (this._roFd(fd)) {
    var lr = this._ro.fs.lseek(fd - RO_FD_BASE, offset, whence);
    if (lr === null) return this._setErr(this._ro.fs._lastError || 'EIO');
    return lr;
  }
  var r = this._ok(this._c.call(OP.FS_LSEEK, { fd: fd, offset: offset, whence: whence }));
  return r === null ? null : r.offset;
};
RemoteFS.prototype.stat = function (p) {
  var self = this;
  return this._roPath(p,
    function (fs, rel) { return fs.stat(rel); },
    function () { var r = self._ok(self._c.call(OP.FS_STAT, { path: p })); return r && r.st; });
};
RemoteFS.prototype.lstat = function (p) {
  var self = this;
  return this._roPath(p,
    function (fs, rel) { return fs.lstat(rel); },
    function () { var r = self._ok(self._c.call(OP.FS_LSTAT, { path: p })); return r && r.st; });
};
RemoteFS.prototype.fstat = function (fd) {
  if (this._roFd(fd)) {
    var lr = this._ro.fs.fstat(fd - RO_FD_BASE);
    if (lr === null) return this._setErr(this._ro.fs._lastError || 'EIO');
    return lr;
  }
  var r = this._ok(this._c.call(OP.FS_FSTAT, { fd: fd })); return r && r.st;
};
RemoteFS.prototype.access = function (p, mode) {
  var self = this;
  return this._roPath(p,
    function (fs, rel) { return fs.access(rel, mode); },
    function () { return self._ok(self._c.call(OP.FS_ACCESS, { path: p, mode: mode })) && 0; });
};
RemoteFS.prototype.unlink = function (p) { return this._ok(this._c.call(OP.FS_UNLINK, { path: p })) && 0; };
RemoteFS.prototype.rename = function (a, b) { return this._ok(this._c.call(OP.FS_RENAME, { from: a, to: b })) && 0; };
RemoteFS.prototype.mkdir = function (p, mode) { return this._ok(this._c.call(OP.FS_MKDIR, { path: p, mode: mode })) && 0; };
RemoteFS.prototype.rmdir = function (p) { return this._ok(this._c.call(OP.FS_RMDIR, { path: p })) && 0; };
RemoteFS.prototype.link = function (a, b) { return this._ok(this._c.call(OP.FS_LINK, { from: a, to: b })) && 0; };
RemoteFS.prototype.symlink = function (target, p) { return this._ok(this._c.call(OP.FS_SYMLINK, { target: target, path: p })) && 0; };
/* Buffer-style like BlockFS.readlink — toWasmEnv is reused over RemoteFS,
 * so the signatures must match (the RPC itself carries a string). */
RemoteFS.prototype.readlink = function (p, buf, bufsize) {
  var self = this;
  return this._roPath(p,
    function (fs, rel) { return fs.readlink(rel, buf, bufsize); },
    function () {
      var r = self._ok(self._c.call(OP.FS_READLINK, { path: p }));
      if (r === null) return null;
      var bytes = new TextEncoder().encode(r.target);
      var n = Math.min(bytes.length, bufsize);
      for (var i = 0; i < n; i++) buf[i] = bytes[i];
      return n;
    });
};
RemoteFS.prototype.ftruncate = function (fd, size) {
  if (this._roFd(fd)) {   // same volume class the kernel serves: EROFS
    var lr = this._ro.fs.ftruncate(fd - RO_FD_BASE, size);
    return lr === null ? this._setErr(this._ro.fs._lastError || 'EIO') : 0;
  }
  return this._ok(this._c.call(OP.FS_FTRUNCATE, { fd: fd, size: size })) && 0;
};
RemoteFS.prototype.fsync = function (fd) {
  if (this._roFd(fd)) return 0;   // read-only volume: nothing to flush
  return this._ok(this._c.call(OP.FS_FSYNC, { fd: fd })) && 0;
};
RemoteFS.prototype.chmod = function (p, mode) { return this._ok(this._c.call(OP.FS_CHMOD, { path: p, mode: mode })) && 0; };
RemoteFS.prototype.fchmod = function (fd, mode) {
  if (this._roFd(fd)) {
    var lr = this._ro.fs.fchmod(fd - RO_FD_BASE, mode);
    return lr === null ? this._setErr(this._ro.fs._lastError || 'EIO') : 0;
  }
  return this._ok(this._c.call(OP.FS_FCHMOD, { fd: fd, mode: mode })) && 0;
};
RemoteFS.prototype.utime = function (p, a, m) { return this._ok(this._c.call(OP.FS_UTIME, { path: p, atime: a, mtime: m })) && 0; };
RemoteFS.prototype.futime = function (fd, a, m) {
  if (this._roFd(fd)) {
    var lr = this._ro.fs.futime(fd - RO_FD_BASE, a, m);
    return lr === null ? this._setErr(this._ro.fs._lastError || 'EIO') : 0;
  }
  return this._ok(this._c.call(OP.FS_FUTIME, { fd: fd, atime: a, mtime: m })) && 0;
};
RemoteFS.prototype.chdir = function (p) { return this._ok(this._c.call(OP.FS_CHDIR, { path: p })) && 0; };
RemoteFS.prototype.getcwd = function () {
  var r = this._ok(this._c.call(OP.FS_GETCWD, {}));
  return r === null ? null : r.cwd;
};
RemoteFS.prototype.dup = function (fd) {
  if (this._roFd(fd)) {
    var meta = this._ro.fds.get(fd);
    var nf = this._ro.fs.dup(fd - RO_FD_BASE);
    if (nf === null) return this._setErr(this._ro.fs._lastError || 'EIO');
    this._ro.fds.set(RO_FD_BASE + nf, { path: meta.path });
    return RO_FD_BASE + nf;
  }
  var r = this._ok(this._c.call(OP.FS_DUP, { fd: fd }));
  if (r === null) return null;
  this._fdTable[r.fd] = { type: 'remote' };
  var dupRing = this._pipes.get(fd);
  if (dupRing) this._pipes.set(r.fd, dupRing);   // same end, same ring (todos/0181)
  return r.fd;
};
RemoteFS.prototype.dup2 = function (oldfd, newfd) {
  if (this._roFd(oldfd)) {
    if (newfd === oldfd) return newfd;
    if (newfd >= RO_FD_BASE) {   // stays in the local space
      if (this._roFd(newfd)) this._ro.fds.delete(newfd);   // implicit close
      var ln = this._ro.fs.dup2(oldfd - RO_FD_BASE, newfd - RO_FD_BASE);
      if (ln === null) return this._setErr(this._ro.fs._lastError || 'EIO');
      this._ro.fds.set(newfd, { path: this._ro.fds.get(oldfd).path });
      return newfd;
    }
    // Crossing into the kernel fd space (redirect onto stdio & co): promote
    // a brokered twin, land it at newfd, drop the twin.
    var k = this._roPromote(oldfd);
    if (k === null) return null;
    var pr = this._ok(this._c.call(OP.FS_DUP2, { fd: k, newfd: newfd }));
    this._ok(this._c.call(OP.FS_CLOSE, { fd: k }));
    delete this._fdTable[k];
    if (pr === null) return null;
    this._fdTable[pr.fd] = { type: 'remote' };
    this._pipes.delete(newfd);   // newfd is the promoted file now (todos/0181)
    return pr.fd;
  }
  if (this._roFd(newfd)) {   // remote source lands on a local number
    this.close(newfd);       // POSIX implicit close of newfd
  }
  var r = this._ok(this._c.call(OP.FS_DUP2, { fd: oldfd, newfd: newfd }));
  if (r === null) return null;
  this._fdTable[r.fd] = { type: 'remote' };
  // Pipe-ring bookkeeping (todos/0181): newfd now names oldfd's OFD.
  if (oldfd !== newfd) {
    var d2Ring = this._pipes.get(oldfd);
    if (d2Ring) this._pipes.set(newfd, d2Ring);
    else this._pipes.delete(newfd);
  }
  return r.fd;
};
RemoteFS.prototype.fcntl_dupfd = function (fd, min) {
  if (this._roFd(fd)) {
    var meta = this._ro.fds.get(fd);
    var nf = this._ro.fs.fcntl_dupfd(fd - RO_FD_BASE, Math.max(0, min - RO_FD_BASE));
    if (nf === null) return this._setErr(this._ro.fs._lastError || 'EIO');
    this._ro.fds.set(RO_FD_BASE + nf, { path: meta.path });
    return RO_FD_BASE + nf;
  }
  var r = this._ok(this._c.call(OP.FS_FCNTL_DUPFD, { fd: fd, min: min }));
  if (r === null) return null;
  this._fdTable[r.fd] = { type: 'remote' };
  var fdRing = this._pipes.get(fd);
  if (fdRing) this._pipes.set(r.fd, fdRing);     // same end, same ring (todos/0181)
  return r.fd;
};
RemoteFS.prototype.opendir = function (p) {
  // Local dir handles share the RO_FD_BASE offset discipline (the volume's
  // own handle table allocates small ints, remote snapshots index _dirs).
  var rel = this._roRel(p);
  if (rel !== null) {
    var self = this;
    return this._roLocal(function () {
      var h = self._ro.fs.opendir(rel);
      return h === null ? null : RO_FD_BASE + h;
    }, function () { return self._opendirBrokered(p); });
  }
  return this._opendirBrokered(p);
};
RemoteFS.prototype._opendirBrokered = function (p) {
  var r = this._ok(this._c.call(OP.FS_OPENDIR, { path: p }));
  if (r === null) return null;
  var entries = r.entries;
  // Big-dir pagination (todos/0241): a `more` cursor means the kernel
  // parked the open handle — drain it page by page before snapshotting,
  // so readdir/closedir/pos semantics are unchanged for every caller.
  while (r.more !== undefined) {
    r = this._ok(this._c.call(OP.FS_READDIR, { dir: r.more }));
    if (r === null) return null;
    for (var i = 0; i < r.entries.length; i++) entries.push(r.entries[i]);
  }
  this._dirs.push({ entries: entries, pos: 0 });
  return this._dirs.length - 1;
};
RemoteFS.prototype.readdir = function (h) {
  if (this._ro !== null && h >= RO_FD_BASE) return this._ro.fs.readdir(h - RO_FD_BASE);
  var d = this._dirs[h];
  if (!d || d.pos >= d.entries.length) return null;
  return d.entries[d.pos++];
};
RemoteFS.prototype.closedir = function (h) {
  if (this._ro !== null && h >= RO_FD_BASE) { this._ro.fs.closedir(h - RO_FD_BASE); return 0; }
  this._dirs[h] = undefined; return 0;
};
RemoteFS.prototype._resolvePath = function (p) {
  var r = this._c.call(OP.FS_REALPATH, { path: p });
  return r.errno ? p : r.path;   // best effort, like the lexical resolver
};
/* realpath(3) — the FS_REALPATH RPC now resolves symlinks PHYSICALLY
 * kernel-side (todos/0263). Unlike _resolvePath above (best-effort, swallows
 * errors for lexical callers), this surfaces the failure: null + _lastError so
 * the toWasmEnv realpath import can return NULL like glibc/the standalone
 * flavor. One RPC — the per-component walk stays inside the kernel. */
RemoteFS.prototype.realpathPhysical = function (p) {
  var r = this._c.call(OP.FS_REALPATH, { path: p });
  return r.errno ? this._setErr(r.errno) : r.path;
};
RemoteFS.prototype.isatty = function (fd) {
  if (this._roFd(fd)) return 0;   // a sealed-volume regular file
  var r = this._c.call(OP.FS_ISATTY, { fd: fd });
  return r.errno ? 0 : r.tty;
};
/* SPSC pipe fast path (todos/0181) — the process side.
 *
 * pipe() allocates the ring SAB and posts it ahead of PIPE_CREATE (the
 * audio-sab handshake); inherited fds arrive pre-registered via
 * procSpec.pipeRings. Every data op gates on the ring's PR_MODE word:
 * FAST (the kernel promoted — both ends single-holder) means read/write
 * are a local memcpy + index commit, ZERO RPCs in steady state; anything
 * else falls through to the brokered RPC, which the kernel serves FROM
 * THE SAME RING, so a stale mode read is never wrong, only slower.
 * Blocking rides the 0178 unified FS_WAIT naming this fd (no bespoke
 * park); after a commit the peer's PR_RWAIT/PR_WWAIT flag says whether to
 * ring the PIPE_KICK doorbell. Reader-gone EPIPE raises SIGPIPE through
 * PIPE_KICK{epipe:1} — the kernel delivers to the caller, matching the
 * brokered write's EPIPE+signal ordering. */
RemoteFS.prototype.registerPipeRing = function (fd, end, sab) {
  var v = pipeRingViews(sab);
  v.end = end;
  this._pipes.set(fd, v);
  if (!this._fdTable[fd]) this._fdTable[fd] = { type: 'remote' };
};
RemoteFS.prototype.pipe = function () {
  var sab = null;
  try { sab = new SharedArrayBuffer(PIPE_RING_BYTES); } catch (e) { sab = null; }
  if (sab) this._c._post({ type: 'pipe-sab', sab: sab });
  var r = this._ok(this._c.call(OP.PIPE_CREATE, {}));
  if (r === null) return null;
  this._fdTable[r.rfd] = { type: 'remote' };
  this._fdTable[r.wfd] = { type: 'remote' };
  if (sab) {
    this.registerPipeRing(r.rfd, 'read', sab);
    this.registerPipeRing(r.wfd, 'write', sab);
  }
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
/* FS_WATCH (ticket #75): a path-keyed watch fd. mask 0 = the kernel's
 * settled default; flags reserved (EINVAL when nonzero). The fd reads
 * packed fsw_event records (os/fswatch.h), EAGAIN when dry, and is
 * readable in select()/__wait like any other fd. Close removes the watch. */
RemoteFS.prototype.fsWatch = function (path, mask, flags) {
  var r = this._ok(this._c.call(OP.FS_WATCH_OPEN, { path: path, mask: mask | 0, flags: flags | 0 }));
  if (r === null) return null;
  this._fdTable[r.fd] = { type: 'remote' };
  return r.fd;
};

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
  "// The KERNEL owns this worker's lifetime — every process end path goes",
  "// through _exitProcess -> worker.terminate() (exit handshake, SIGKILL,",
  "// crash) — so an empty event loop must not end it. Node exits a worker",
  "// whose loop drains, and a pending Atomics.waitAsync holds no ref, so a",
  "// process parked in vsyncWait (the ONE async parker: every other wait is",
  "// a synchronous Atomics.wait that blocks the thread with the loop still",
  "// owing nothing) would die mid-park as a silent channel-death SIGSEGV.",
  "// Browser workers idle on an empty loop; this pins the Node twin to the",
  "// same semantics. First exposed by boot.js --vsync (#424).",
  "setInterval(function () {}, 0x7fffffff);",
  "var fsFactory;",
  "var rfs = null;",
  "if (wd.brokered) {",
  "  // The brokered filesystem: the kernel serves every fs syscall; the env",
  "  // is toWasmEnv REUSED over a RemoteFS (same method surface), with the",
  "  // two in-process-state entries overridden. wd.ro (todos/0180) is the",
  "  // sealed system image as an SAB — mounted locally so reads under its",
  "  // prefix never RPC.",
  "  var roFs = wd.ro",
  "    ? BLOCK_FS.createV4(new BLOCK_FS.SabByteStore(wd.ro.sab), { readonly: true })",
  "    : null;",
  "  rfs = new K.RemoteFS(client, roFs ? { roFs: roFs, roPrefix: wd.ro.prefix } : null);",
  "  // SPSC pipe rings for inherited fds (todos/0181): fast ops gate on the",
  "  // ring's PR_MODE word, so registering a still-brokered ring is free.",
  "  (wd.pipeRings || []).forEach(function (p) { rfs.registerPipeRing(p.fd, p.end, p.sab); });",
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
  "  bytes: wd.image || undefined,",
  "  module: wd.module || undefined,   // pre-compiled Module (todos/0037)",
  "  args: wd.argv,",
  "  env: envObj(wd.envp),",
  "  stdinSab: wd.ttySab || undefined,",
  "  blockFsFactory: fsFactory,",
  "  writeOut: ship(1),",
  "  writeErr: ship(2),",
  "  // rfs wraps spawn() so DUP2 file-actions naming local /usr fds promote",
  "  // to kernel twins (todos/0180); identity when the RO volume is off.",
  "  spawnHooks: rfs ? rfs.wrapSpawnHooks(client.spawnHooks()) : client.spawnHooks(),",
  "  pid: wd.pid,",
  "  ppid: wd.ppid,",
  "  // Live ppid off the vDSO page (todos/0179): tracks reparent-to-init.",
  "  getppid: function () { return client.getppid(); },",
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
    // never transfer). The kernel page crosses as the SAB it is. On a module-
    // cache hit (todos/0037) the image is null and the compiled Module
    // structured-clones instead — sharing the engine's compiled code.
    var image = procSpec.image;
    var imageBuf = image == null ? null
      : image instanceof Uint8Array
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
        module: procSpec.module || null,
        kernelPage: procSpec.kernelPage,
        ttySab: procSpec.ttySab || null,
        brokered: !!procSpec.brokered,
        // Read-only volume (todos/0180): { prefix, sab } — the SAB shares.
        ro: procSpec.ro || null,
        // SPSC pipe rings (todos/0181): [{fd, end, sab}] — the SABs share.
        pipeRings: procSpec.pipeRings || null,
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

/* ============================================================
 * ProcFS (todos/0043) — a synthetic /proc volume.
 *
 * Implements exactly the fs-op surface MountFS routes to (open/read/stat/
 * readdir/…), generating Linux-format content from the LIVE kernel process
 * table so busybox ps/top/pgrep/pkill/uptime/free parse it unmodified. No
 * BlockFS backing, no on-disk format, nothing for fsck to check. Mount it
 * as `'/proc': new ProcFS()` in the MountFS table handed to Kernel({fs}) —
 * the Kernel constructor scans the mount table and binds itself (until a
 * kernel is bound the volume is an empty read-only tree).
 *
 * Semantics:
 * - Snapshot at open, like Linux: open() renders the whole file into a
 *   buffer; reads/lseek work that buffer. read_to_buf-style single-read
 *   consumers and fstat-then-read consumers both work (sizes are real,
 *   unlike Linux's size-0 procfs — host-side readFileBytes sizes via
 *   fstat).
 * - Read-only: every mutator answers EROFS (the 0040 convention); opens
 *   for writing answer EACCES like Linux procfs.
 * - What exists: /proc/<pid>/{stat,status,cmdline,comm} for every pcb in
 *   the table (zombies included, like Linux), plus uptime, loadavg,
 *   meminfo, stat, version. No /proc/self: the fs layer has no caller
 *   identity (fs ops carry a path, not a pid), and nothing shipped needs
 *   it (CONFIG_BUSYBOX_EXEC_PATH is hand-patched to /bin/sh).
 * - What's synthetic: per-process CPU time is not tracked (workers run on
 *   their own OS threads) — utime/stime are 0 and top's %CPU column is
 *   boring by design. VmSize/VmRSS are nominal constants (the kernel
 *   can't see worker heaps); meminfo is a fixed plausible table. Real:
 *   pids, ppid/pgid/sid, state (R running / S parked-in-RPC / T stopped /
 *   Z zombie), comm/cmdline from spawn argv, start_time and uptime from
 *   the kernel clock, loadavg's running/total counts and last-pid.
 * ============================================================ */

var PROC_HZ = 100;                 // jiffies/sec — matches bb_clk_tck()'s 100
var PROC_VMSIZE_KB = 4096;         // nominal VmSize (worker heaps invisible)
var PROC_VMRSS_KB = 1024;          // nominal VmRSS; 16 pages of 64KiB
var PROC_ROOT_FILES = ['loadavg', 'meminfo', 'stat', 'uptime', 'version'];
var PROC_PID_FILES = ['cmdline', 'comm', 'stat', 'status'];

function ProcFS() {
  this._kernel = null;             // bound by Kernel's mount-table scan
  this._lastError = '';
  this._fdTable = [];              // fd -> { buf, pos, ino } (dup shares)
  this._dirTable = [];             // handle -> { entries, pos, dotState }
  this._inos = new Map();          // path -> synthetic ino, stable per mount
  this._nextIno = 1;
}

ProcFS.prototype._setErr = function (name) {
  this._lastError = name;
  return null;
};

ProcFS.prototype._ino = function (path) {
  var ino = this._inos.get(path);
  if (!ino) { ino = this._nextIno++; this._inos.set(path, ino); }
  return ino;
};

/* Resolve a volume-relative path (MountFS hands them normalized) to
 * { dir: 'root' } | { dir: 'pid', pcb } | { file, pcb? } | null. */
ProcFS.prototype._lookup = function (path) {
  var parts = String(path).split('/').filter(function (p) { return p && p !== '.'; });
  if (parts.length === 0) return { dir: 'root' };
  var k = this._kernel;
  if (parts.length === 1) {
    if (PROC_ROOT_FILES.indexOf(parts[0]) >= 0) return { file: parts[0] };
    var pcb = /^\d+$/.test(parts[0]) && k ? k._procs.get(parts[0] | 0) : null;
    return pcb ? { dir: 'pid', pcb: pcb } : null;
  }
  if (parts.length === 2 && PROC_PID_FILES.indexOf(parts[1]) >= 0) {
    var pcb2 = /^\d+$/.test(parts[0]) && k ? k._procs.get(parts[0] | 0) : null;
    return pcb2 ? { file: parts[1], pcb: pcb2 } : null;
  }
  return null;
};

/* ---- content generators (Linux formats — see proc(5)) ---- */

ProcFS.prototype._comm = function (pcb) {
  var a0 = (pcb.argv && pcb.argv[0]) || pcb.path || '?';
  // A leading '-' is the login-shell argv[0] convention (todos/0174 spawns
  // pid 1 / term shells as "-sh"), not part of the name: Linux comm comes
  // from the exec'd FILE, so a login sh still reads "sh" (and pgrep/pkill
  // by name keep matching).
  if (a0.charCodeAt(0) === 45 && a0.length > 1) a0 = a0.slice(1);
  var base = a0.slice(a0.lastIndexOf('/') + 1);
  return base.slice(0, 15) || '?';
};

ProcFS.prototype._stateChar = function (pcb) {
  if (pcb.state === STATE_ZOMBIE) return 'Z';
  if (pcb.state === STATE_STOPPED) return 'T';
  return pcb.waiter ? 'S' : 'R';
};

ProcFS.prototype._uptimeSec = function () {
  var k = this._kernel;
  return k ? Math.max(0, (Date.now() - k._bootMs) / 1000) : 0;
};

ProcFS.prototype._counts = function () {
  var running = 0, total = 0;
  this._kernel._procs.forEach(function (p) {
    if (p.state === STATE_ZOMBIE) return;
    total++;
    if (p.state === STATE_RUNNING && !p.waiter) running++;
  });
  return { running: running || 1, total: total };
};

ProcFS.prototype._render = function (hit) {
  var k = this._kernel, pcb = hit.pcb;
  if (pcb) return this._renderPid(hit.file, pcb);
  switch (hit.file) {
    case 'uptime': {
      var up = this._uptimeSec().toFixed(2);
      return up + ' ' + up + '\n';
    }
    case 'loadavg': {
      // Cooperative single-runqueue system: the load numbers stay 0.00;
      // running/total and last-pid are real.
      if (!k) return '0.00 0.00 0.00 0/0 0\n';
      var c = this._counts();
      return '0.00 0.00 0.00 ' + c.running + '/' + c.total + ' ' + (k._nextPid - 1) + '\n';
    }
    case 'meminfo':
      // Fixed plausible table (kB): the kernel can't see worker heaps.
      // SReclaimable/MemAvailable/Shmem are what busybox free reads;
      // MemTotal MUST stay nonzero (top divides by it).
      return 'MemTotal:        1048576 kB\n' +
        'MemFree:          786432 kB\n' +
        'MemAvailable:     786432 kB\n' +
        'Buffers:               0 kB\n' +
        'Cached:                0 kB\n' +
        'SwapCached:            0 kB\n' +
        'Shmem:                 0 kB\n' +
        'SwapTotal:             0 kB\n' +
        'SwapFree:              0 kB\n' +
        'Dirty:                 0 kB\n' +
        'Writeback:             0 kB\n' +
        'AnonPages:             0 kB\n' +
        'Mapped:                0 kB\n' +
        'Slab:                  0 kB\n' +
        'SReclaimable:          0 kB\n';
    case 'stat': {
      // One aggregate cpu line (idle accrues with the clock so interval
      // deltas divide cleanly), then the bookkeeping lines top ignores.
      var idle = Math.floor(this._uptimeSec() * PROC_HZ);
      var c2 = k ? this._counts() : { running: 0, total: 0 };
      if (!k) k = { _bootMs: Date.now(), _nextPid: 1 };   // unbound: zeros
      return 'cpu  0 0 0 ' + idle + ' 0 0 0 0\n' +
        'cpu0 0 0 0 ' + idle + ' 0 0 0 0\n' +
        'intr 0\n' +
        'ctxt 0\n' +
        'btime ' + Math.floor(k._bootMs / 1000) + '\n' +
        'processes ' + (k._nextPid - 1) + '\n' +
        'procs_running ' + c2.running + '\n' +
        'procs_blocked 0\n';
    }
    case 'version':
      return 'Linux version 6.6.0-wasm (root@localhost) (cc gucos) #1 ' +
        'almost-POSIX on WebAssembly\n';
  }
  return null;
};

/* /proc/<pid>/<file>. */
ProcFS.prototype._renderPid = function (file, pcb) {
  switch (file) {
    case 'cmdline': {
      // argv NUL-joined with a trailing NUL; empty for zombies, so
      // busybox's read_cmdline falls back to "[comm]" — like Linux.
      if (pcb.state === STATE_ZOMBIE) return '';
      var argv = (pcb.argv && pcb.argv.length) ? pcb.argv : [pcb.path || '?'];
      return argv.join('\0') + '\0';
    }
    case 'comm':
      return this._comm(pcb) + '\n';
    case 'status': {
      var sc = this._stateChar(pcb);
      var word = { R: 'running', S: 'sleeping', T: 'stopped (signal)', Z: 'zombie' }[sc];
      return 'Name:\t' + this._comm(pcb) + '\n' +
        'State:\t' + sc + ' (' + word + ')\n' +
        'Tgid:\t' + pcb.pid + '\n' +
        'Pid:\t' + pcb.pid + '\n' +
        'PPid:\t' + pcb.ppid + '\n' +
        'TracerPid:\t0\n' +
        'Uid:\t0\t0\t0\t0\n' +
        'Gid:\t0\t0\t0\t0\n' +
        'FDSize:\t' + (pcb.fds ? pcb.fds.size : 0) + '\n' +
        'Groups:\t0\n' +
        'NSpgid:\t' + pcb.pgid + '\n' +
        'NSsid:\t' + pcb.sid + '\n' +
        'VmSize:\t' + PROC_VMSIZE_KB + ' kB\n' +
        'VmRSS:\t' + PROC_VMRSS_KB + ' kB\n' +
        'Threads:\t1\n';
    }
    case 'stat': {
      // proc(5) field order; parsers key on the ')' before the state char,
      // so a comm with spaces/parens stays parseable the same way Linux's
      // does. Fields 14/15 (utime/stime) are 0 by design; field 22
      // (starttime, jiffies since boot) and 7 (tty_nr) are real.
      var ttyNr = pcb.tty ? ((4 << 8) | 1) : 0;             // tty1, or none
      var tpgid = pcb.tty && pcb.tty.fgPgid > 0 ? pcb.tty.fgPgid : -1;
      var startJiffies = Math.max(0,
        Math.floor(((pcb.startMs || this._kernel._bootMs) - this._kernel._bootMs) / (1000 / PROC_HZ)));
      var vsizeBytes = PROC_VMSIZE_KB * 1024;
      var rssPages = 16;                                    // ×64KiB pages = VmRSS
      return pcb.pid + ' (' + this._comm(pcb) + ') ' + this._stateChar(pcb) +
        ' ' + pcb.ppid + ' ' + pcb.pgid + ' ' + pcb.sid +
        ' ' + ttyNr + ' ' + tpgid +
        ' 0 0 0 0 0' +                                      // flags, faults
        ' 0 0 0 0' +                                        // utime stime cutime cstime
        ' 20 0 1 0' +                                       // priority nice threads itreal
        ' ' + startJiffies +
        ' ' + vsizeBytes + ' ' + rssPages +
        ' 4194304 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n'; // rsslim + cruft
      }
  }
  return null;
};

/* Render a file to bytes, or null (ENOENT). */
ProcFS.prototype._genBytes = function (hit) {
  var text = this._render(hit);
  if (text === null || text === undefined) return null;
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
  var out = new Uint8Array(text.length);   // ASCII-only fallback: /proc content
  for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;  // is pure ASCII; TextEncoder-less envs only
  return out;
};

ProcFS.prototype._statObj = function (path, hit) {
  var now = Math.floor(Date.now() / 1000);
  if (hit.dir) {
    return { ino: this._ino(path), mode: 0x4000 | 0o555, nlink: 2, size: 0,
      atime: now, mtime: now, ctime: now, rdev: 0 };
  }
  var bytes = this._genBytes(hit);
  return { ino: this._ino(path), mode: 0x8000 | 0o444, nlink: 1,
    size: bytes ? bytes.length : 0, atime: now, mtime: now, ctime: now, rdev: 0 };
};

/* ---- path operations ---- */

ProcFS.prototype.open = function (path, flags, mode) {
  var hit = this._lookup(path);
  if (!hit) return this._setErr((flags & 0x40) ? 'EROFS' : 'ENOENT'); // O_CREAT
  if (hit.dir) return this._setErr('EISDIR');
  if ((flags & 3) !== 0 || (flags & 0x200)) return this._setErr('EACCES'); // write / O_TRUNC
  var buf = this._genBytes(hit);
  if (!buf) return this._setErr('ENOENT');
  var entry = { buf: buf, pos: 0, ino: this._ino(path) };
  for (var i = 0; i < this._fdTable.length; i++) {
    if (this._fdTable[i] === null) { this._fdTable[i] = entry; return i; }
  }
  this._fdTable.push(entry);
  return this._fdTable.length - 1;
};

ProcFS.prototype.stat = function (path) {
  var hit = this._lookup(path);
  return hit ? this._statObj(path, hit) : this._setErr('ENOENT');
};
ProcFS.prototype.lstat = ProcFS.prototype.stat;   // no symlinks in this tree

ProcFS.prototype.access = function (path, mode) {
  var hit = this._lookup(path);
  if (!hit) return this._setErr('ENOENT');
  if (mode & 2) return this._setErr('EROFS');     // W_OK
  return 0;
};

ProcFS.prototype.readlink = function (path) {
  return this._setErr(this._lookup(path) ? 'EINVAL' : 'ENOENT');
};

ProcFS.prototype.opendir = function (path) {
  var hit = this._lookup(path);
  if (!hit) return this._setErr('ENOENT');
  if (!hit.dir) return this._setErr('ENOTDIR');
  var self = this;
  var entries = [];
  if (hit.dir === 'root') {
    PROC_ROOT_FILES.forEach(function (n) {
      entries.push({ ino: self._ino('/' + n), type: 8, name: n });
    });
    if (this._kernel) {
      var pids = [];
      this._kernel._procs.forEach(function (p, pid) { pids.push(pid); });
      pids.sort(function (a, b) { return a - b; });
      pids.forEach(function (pid) {
        entries.push({ ino: self._ino('/' + pid), type: 4, name: String(pid) });
      });
    }
  } else {
    PROC_PID_FILES.forEach(function (n) {
      entries.push({ ino: self._ino('/' + hit.pcb.pid + '/' + n), type: 8, name: n });
    });
  }
  var d = { entries: entries, pos: 0, dotState: 0 };
  for (var i = 0; i < this._dirTable.length; i++) {
    if (this._dirTable[i] === null) { this._dirTable[i] = d; return i; }
  }
  this._dirTable.push(d);
  return this._dirTable.length - 1;
};

ProcFS.prototype.readdir = function (handle) {
  var d = (handle >= 0 && handle < this._dirTable.length) ? this._dirTable[handle] : null;
  if (!d) return this._setErr('EBADF');
  if (d.dotState < 2) {                            // '.' / '..' like BlockFS
    var dotName = d.dotState === 0 ? '.' : '..';
    d.dotState++;
    return { ino: 0, type: 4, name: dotName };
  }
  if (d.pos >= d.entries.length) return null;
  return d.entries[d.pos++];
};

ProcFS.prototype.closedir = function (handle) {
  var d = (handle >= 0 && handle < this._dirTable.length) ? this._dirTable[handle] : null;
  if (!d) return this._setErr('EBADF');
  this._dirTable[handle] = null;
  return 0;
};

/* ---- mutators: a read-only synthetic tree (0040 EROFS convention) ---- */

ProcFS.prototype._erofs = function () { return this._setErr('EROFS'); };
ProcFS.prototype.chmod = ProcFS.prototype._erofs;
ProcFS.prototype.utime = ProcFS.prototype._erofs;
ProcFS.prototype.mkdir = ProcFS.prototype._erofs;
ProcFS.prototype.mknod = ProcFS.prototype._erofs;
ProcFS.prototype.unlink = ProcFS.prototype._erofs;
ProcFS.prototype.remove = ProcFS.prototype._erofs;
ProcFS.prototype.rmdir = ProcFS.prototype._erofs;
ProcFS.prototype.rename = ProcFS.prototype._erofs;
ProcFS.prototype.link = ProcFS.prototype._erofs;
ProcFS.prototype.symlink = ProcFS.prototype._erofs;
ProcFS.prototype.ftruncate = ProcFS.prototype._erofs;
ProcFS.prototype.fchmod = ProcFS.prototype._erofs;
ProcFS.prototype.futime = ProcFS.prototype._erofs;

/* ---- fd operations ---- */

ProcFS.prototype._fdEntry = function (fd) {
  return (fd >= 0 && fd < this._fdTable.length) ? this._fdTable[fd] : null;
};

ProcFS.prototype.read = function (fd, buf, count) {
  var e = this._fdEntry(fd);
  if (!e) return this._setErr('EBADF');
  var n = Math.min(count | 0, buf.length, e.buf.length - e.pos);
  if (n <= 0) return 0;
  buf.set(e.buf.subarray(e.pos, e.pos + n));
  e.pos += n;
  return n;
};

ProcFS.prototype.write = function (fd, buf, count) {
  // Opens are read-only (open() refuses write modes), so any write is EBADF.
  return this._setErr('EBADF');
};

ProcFS.prototype.lseek = function (fd, offset, whence) {
  var e = this._fdEntry(fd);
  if (!e) return this._setErr('EBADF');
  var base = whence === 1 ? e.pos : whence === 2 ? e.buf.length : 0;
  var pos = base + (offset | 0);
  if (pos < 0) return this._setErr('EINVAL');
  e.pos = pos;
  return pos;
};

ProcFS.prototype.fstat = function (fd) {
  var e = this._fdEntry(fd);
  if (!e) return this._setErr('EBADF');
  var now = Math.floor(Date.now() / 1000);
  return { ino: e.ino, mode: 0x8000 | 0o444, nlink: 1, size: e.buf.length,
    atime: now, mtime: now, ctime: now, rdev: 0 };
};

ProcFS.prototype.fsync = function (fd) {
  return this._fdEntry(fd) ? 0 : this._setErr('EBADF');
};

ProcFS.prototype.close = function (fd) {
  if (!this._fdEntry(fd)) return this._setErr('EBADF');
  this._fdTable[fd] = null;
  return 0;
};

ProcFS.prototype.dup = function (fd) {
  var e = this._fdEntry(fd);
  if (!e) return this._setErr('EBADF');
  for (var i = 0; i < this._fdTable.length; i++) {
    if (this._fdTable[i] === null) { this._fdTable[i] = e; return i; }
  }
  this._fdTable.push(e);                           // shared entry = shared offset
  return this._fdTable.length - 1;
};

/* ---- environment exports (host.js discipline) ---- */
var KERNEL_EXPORTS = {
  Kernel: Kernel,
  ProcFS: ProcFS,
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
  KP_VSYNC_EN: KP_VSYNC_EN,
  KP_VSYNC_SEQ: KP_VSYNC_SEQ,
  KP_VSYNC_ARMED: KP_VSYNC_ARMED,
  KP_COMP_PARKED: KP_COMP_PARKED,
  KP_PAYLOAD_CAP: KP_PAYLOAD_CAP,
  KP_FS_CHUNK: KP_FS_CHUNK,       // bulk-lane chunks, derived (todos/0235)
  KP_HOOK_CHUNK: KP_HOOK_CHUNK,
  // vDSO block (todos/0179) — seqlock-published kernel state.
  KP_VD_SEQ: KP_VD_SEQ, KP_VD_PID: KP_VD_PID, KP_VD_PPID: KP_VD_PPID,
  KP_VD_PGID: KP_VD_PGID, KP_VD_SID: KP_VD_SID,
  KP_VD_BOOT_LO: KP_VD_BOOT_LO, KP_VD_BOOT_HI: KP_VD_BOOT_HI,
  KP_VD_SCREEN_W: KP_VD_SCREEN_W, KP_VD_SCREEN_H: KP_VD_SCREEN_H,
  RO_FD_BASE: RO_FD_BASE,   // process-served read-only fd space (todos/0180)
  // SPSC pipe rings (todos/0181) — header layout + mode ladder for tests.
  PIPE_RING_HDR: PIPE_RING_HDR, PIPE_RING_BYTES: PIPE_RING_BYTES,
  PR_MODE: PR_MODE, PR_HEAD: PR_HEAD, PR_TAIL: PR_TAIL, PR_FLAGS: PR_FLAGS,
  PR_RWAIT: PR_RWAIT, PR_WWAIT: PR_WWAIT,
  PR_LATENT: PR_LATENT, PR_FAST: PR_FAST, PR_DEMOTED: PR_DEMOTED,
  PRF_RGONE: PRF_RGONE, PRF_WGONE: PRF_WGONE,
  pipeRingViews: pipeRingViews, pipeRingAvail: pipeRingAvail,
  pipeRingPut: pipeRingPut, pipeRingTake: pipeRingTake,
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
  WM_SAB_LAYOUT: WM_SAB_LAYOUT,   // the published copy host.js checks (CD26)
  WM_TITLE_H: WM_TITLE_H, WM_CLOSE_W: WM_CLOSE_W, WM_CLOSE_PAD: WM_CLOSE_PAD,
  WM_BOX_GAP: WM_BOX_GAP, WM_LABEL_PX: WM_LABEL_PX,
  WM_BORDER: WM_BORDER, WM_GRIP: WM_GRIP, WM_MIN_SIZE: WM_MIN_SIZE,
  WM_BORDER_HIT: WM_BORDER_HIT, WM_GRIP_HIT: WM_GRIP_HIT,   // hit-only (#388)
  WM_GRIP_IN: WM_GRIP_IN,
  WM_MAP_TIMEOUT_MS: WM_MAP_TIMEOUT_MS,
  WM_ANIM_MS: WM_ANIM_MS,
  WM_COLORS: WM_COLORS,
  // The WM protocol (todos/0014) — MUST MATCH os/wm_proto.h.
  WMP: WMP, WMP_REC_BYTES: WMP_REC_BYTES, WM_SOCK_PATH: WM_SOCK_PATH,
  // Key-grab table (todos/KEYBINDING-OVERRIDE-SYSTEM.md §3): the canonical
  // modifier fold + masks (twin of os/keys.h km_from_sdl / KM_*), the reserved
  // default-table tokens, and the built-in default table — exported so the
  // mechanism + km-fold-twin tests can assert against them.
  wmKmFromSdl: wmKmFromSdl, WM_GRAB_MAX: WM_GRAB_MAX,
  KM_SHIFT: KM_SHIFT, KM_CTRL: KM_CTRL, KM_ALT: KM_ALT, KM_GUI: KM_GUI,
  WM_TOK_RESERVED: WM_TOK_RESERVED, WM_TOK_CYCLE: WM_TOK_CYCLE,
  WM_TOK_MENU: WM_TOK_MENU, WM_TOK_SNAP: WM_TOK_SNAP,
  WM_TOK_SYSMENU: WM_TOK_SYSMENU, WM_DEFAULT_GRABS: WM_DEFAULT_GRABS,
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
