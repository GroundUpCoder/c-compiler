# Deep dive 2/3: the dual-implementation libc — standalone vs brokered env divergence

Read-only investigation thread spawned from the 24h review (nomination #2,
`logs/2026-07-28/review-24h-overview.md` §6). Task: systematically diff the
env surfaces that implement the libc import contract, table every divergence
with file:line on both sides and C-observability, and answer whether libc
contracts deserve their own conformance seats. All claims verified against
the tree at `c620e889` (origin/main) in a throwaway worktree; behavioral
claims additionally verified by running throwaway probe scripts against the
worktree's `host.js` over a `MemoryByteStore` (no production code touched,
no heavy suites run).

## 1. The real topology — it's three environments, not two

The brief said "two independent implementations." The code says **three
observable environments over two independent implementations of the import
surface, plus a third method-level implementation under one of them**:

- **Env N (Node standalone)** — `createFileSystem({fs})`, host.js:110,
  imports at host.js:279–956 (+ pipe/JSPI patches :962–1015). Backed by
  Node's real `fs`. Selected by `runModule({fs})` (host.js:10989). This is
  what "bare host.js" runs — and what the **entire conformance/unit corpus
  runs by default** (tests/run-unit.js:308–331: no `config.blockFs` → `runOpts.fs = fs`).
- **Env B (in-process BlockFS)** — `BlockFS.prototype.toWasmEnv`,
  host.js:4165–4676, dispatching every op via `this.` to
  `BlockFS.prototype.*` methods (host.js:2868–3930). Selected by
  `runModule({blockFsFactory})`. Standalone browser pages keep this path
  forever; 23 of ~194 unit-test dirs opt in via `config.blockFs` (and only
  ever in-process, never brokered).
- **Env R (brokered/RemoteFS)** — the SAME toWasmEnv marshalling reused over
  `RemoteFS` (kernel.js:7467–8085; env built at kernel.js:8129 with only
  `isatty`/`__select_impl` overridden, :8130–8131), each method an RPC into
  `Kernel.prototype._fsRpc` (kernel.js:3160+) over the kernel's
  BlockFS/MountFS, plus the createSpawn overrides (termios/sleep/signals,
  host.js:5649–5729). Every gucOS process runs this. **Zero conformance
  seats exercise it** — its only guards are kernel-suite e2es.

So the 0340 `__readdir` incident was not "standalone right, brokered wrong"
at the method level — the pre-fix bug was in toWasmEnv's shared `wrap()`
(host.js:4191–4200: every null/negative return → errno from
`self._lastError || 'EIO'`), so it hit Env B *and* Env R; Env N had its own
independent, correct implementation (host.js:528–558). The fix
(host.js:4252–4281) un-wrapped the one import. The structural picture: **the
contract has one spec, three behaviors, and a test estate that measures only
the first.**

Shared plumbing worth naming: errno delivery is common (`setErrnoName`,
host.js:10714; Env N additionally maps Node exception codes via `setErrno`,
host.js:10707, unknown → EIO). The C side calls these imports raw — e.g.
`write` is `__import long write(...)` (compiler.js:25197) with no libc loop,
and `readdir()` maps `__readdir < 0` → NULL (compiler.js:28141–28146) — so
every divergence below is C-observable unless noted.

## 2. Divergence table

Every import implemented in both env objects was compared (both bodies read
in full; ~60 imports). "N" = Node env, "B" = in-process BlockFS, "R" =
brokered. **Parity** rows (same observable contract, differences only
environmental) are compressed at the end.

| # | Contract point | Env N | Env B | Env R | C-observable | Verdict |
|---|---|---|---|---|---|---|
| D1 | `open(path,O_CREAT)` where final component is a **dangling symlink** | creates the *target* file (POSIX; Node passthrough, host.js:286) | **appends a second dirent with the symlink's own name** — duplicate directory entry, on-disk corruption (host.js:2911–2953: create branch never re-checks the lexical name; verified: root listing `["dang:9","dang:8"]`) | same code kernel-side (kernel.js:3188 → fs.open) | yes: `symlink("/t","/l"); open("/l",O_CREAT)` then readdir shows the dup; `stat("/t")`=ENOENT | **BUG (P0-class), both gucOS envs** |
| D2 | fsck coverage of D1 | n/a | **`fsck_v4.js` passes a duplicate-dirent image clean** — no name-uniqueness invariant (verified: `fsck(store)` → `[]` on the corrupted image) | same image | indirectly | **BUG in the checker** |
| D3 | access-mode enforcement on fds | `read` on O_WRONLY / `write` on O_RDONLY → EBADF (host OS enforces, host.js:227/375) | **no access mode stored on the fd at all** (host.js:2958–2960); `read(O_WRONLY fd)` returns data, `write(O_RDONLY fd)` **modifies the file** (host.js:3066–3068 admits it; verified both) | same: kernel OFDs carry no accmode (kernel.js:3190), fs.write is the same BlockFS | yes: `fd=open(f,O_RDONLY); write(fd,"x",1)` → -1/EBADF vs 1-and-corrupted | **DIVERGENT + integrity hazard** |
| D4 | single `write()` > 60,000 B to a regular file | full count (fs.writeSync, host.js:375) | full count (host.js:3102) | **short write: capped at KP_FS_CHUNK = 60,000** (RemoteFS caps the RPC, kernel.js:7747; kernel writes what arrived, kernel.js:3283; no fill loop — the read side got one in todos/0140, kernel.js:7682–7706, the write side did not) | yes: `write(fd,buf,200000)` returns 200000/200000/60000 | **DIVERGENT** (POSIX-legal but the exact mirror of the 0140 read-truncation class; raw import, no libc loop) |
| D5 | `readdir()` real failure (e.g. EBADF on a closed handle) | NULL + errno=EBADF (host.js:529–531) | NULL + **errno untouched** — `BlockFS.readdir` signals EBADF via `_setErr` → null (host.js:3529–3530), and toWasmEnv's post-0340 `__readdir` treats null as clean EOF (host.js:4265); the "real failure" branch at host.js:4266–4269 requires a negative *number*, which **no implementation ever returns — dead code** | worse: `RemoteFS.readdir` bad handle → bare null, not even `_lastError` (kernel.js:7941–7943) | yes: the same `errno=0; while(readdir)…; if(errno)` idiom 0340 fixed now can't see EBADF | **DIVERGENT — 0340's inverse residual** |
| D6 | `d_type` for symlinks (and non-file/dir kinds) | DT_LNK 10 / DT_UNKNOWN (host.js:561–564) | **DT_REG for everything non-directory** — dtype is `dir?4:8` (host.js:3558; verified: symlink lists as type 8) | same entries via FS_OPENDIR snapshot (kernel.js:3486–3497 drains the same fs.readdir) | yes: `ent->d_type==DT_LNK`; CPython `os.scandir().is_symlink()` → False for real symlinks in-OS, True under bare host.js | **DIVERGENT** |
| D7 | `rename(file, empty-dir)` / `rename(dir, file)` | EISDIR / ENOTDIR (host OS) | **both succeed** — target-exists handling only special-cases non-empty dirs (host.js:3340–3349; verified: file replaced an empty dir, dir replaced a file) | same code kernel-side | yes | **DIVERGENT** |
| D8 | `fstat` on a pipe fd | error (no nativeFd → fstatSync throws, host.js:615) | **S_IFCHR 020600** — everything without an inode gets the char-dev stat (host.js:3455–3458; verified mode 020600) | **S_IFIFO** (kernel.js:3338) | yes: `S_ISFIFO(st.st_mode)` true only brokered | **THREE-WAY** |
| D9 | `fcntl(F_GETFL)` | 0 for every fd — F_GETFL falls into the catch-all `return 0` (host.js:747–763) | fd≤2 → 0; any inode-backed fd → **O_RDWR (2)** regardless of open mode; O_APPEND never reported (host.js:4656–4662) | same (toWasmEnv shared) | yes: `fcntl(fd,F_GETFL)&O_ACCMODE` | **DIVERGENT (two different fabrications)** |
| D10 | walk-error errno fidelity | real ENOTDIR/ELOOP/ENOENT | `_walkHops` returns bare null for non-dir components and dangling symlinks (host.js:2738, 2752); `stat`/`lstat` coerce everything but ELOOP to ENOENT (host.js:3426, 3447); `opendir` coerces even ELOOP (host.js:3521); verified `stat("/file/x")` → ENOENT | same | yes: ENOTDIR never observed from gucOS path walks | **DIVERGENT (errno-fidelity class)** |
| D11 | `access(path, mode)` | real W_OK/X_OK checks | **mode ignored** (host.js:3582–3586); `access("/usr/...", W_OK)` → 0 on the sealed read-only volume (verified mode-ignored) | same (kernel.js:3347 → fs.access) | yes: W_OK on /usr lies | **DIVERGENT** |
| D12 | `open(dir, O_RDONLY)` | succeeds (fd on a directory; POSIX) | **EISDIR unconditionally** (host.js:2887) | same | yes: `open(".",O_RDONLY)`; breaks the fsync-the-directory durability idiom (sqlite-class) | **DIVERGENT** |
| D13 | `isatty` | truth + errno (EBADF/ENOTTY, host.js:800–809) | **fd≤2 with any entry → 1 always** (host.js:3649) — piped stdio still "a tty"; toWasmEnv layer also returns 1 for fd≤2 whenever `_stdinSab` is wired even if the fd was dup2'd to a file (host.js:4380) | kernel truth by OFD kind, but **errno never set on 0** (kernel.js:3508–3511, kernel.js:7962–7966) | yes: `isatty(1)` under `prog > file`, and errno after isatty(badfd) | **THREE-WAY** |
| D14 | `fsync(bad fd)` | EBADF (host.js:444–447) | **0, no validation** (deliberate, host.js:3653–3660) | EBADF (kernel.js:3418–3419 — its comment "matching the in-process env's no-validation behavior" is wrong about itself) | yes | **THREE-WAY (minor)** |
| D15 | empty same-instance pipe read with live writer | blocks (JSPI, host.js:974–981) | **returns 0 = spurious EOF** — documented structural exemption (host.js:2990–2996) | blocks (kernel FS_WAIT / _streamRead kernel.js:6659–6678) | yes | DIVERGENT (documented, inherent to sync-in-one-thread) |
| D16 | pipe write semantics | never blocks, never partial, unbounded buffer (host.js:989–1001); EPIPE **without SIGPIPE** (no kernel) | same shape in-process (host.js:3060–3062) | 64 KiB ring / kernel buffer; whole-or-block only ≤ PIPE_ATOMIC = **512** (kernel.js:347, 6691; POSIX floor, Linux is 4096); partials above; EPIPE **+ SIGPIPE death** (kernel.js:6686–6688) | yes: `yes \| head` only dies in-OS; >512 B pipe writes can land partial only brokered | DIVERGENT (mostly by design; PIPE_BUF=512 vs Linux 4096 worth knowing) |
| D17 | `d_ino` in dirents | **always 0** (host.js:542, 560) — some C skips ino==0 entries | real inode ids (host.js:4273 ← :3559) | real (same) | yes | DIVERGENT (Node env is the odd one) |
| D18 | termios round-trip (`tcsetattr` → `tcgetattr`) | real per-process state (host.js:820–867) | **canned constants, set is write-only** (host.js:4388–4441) | real kernel Tty via createSpawn override (host.js:5649–5698, OP.TCGETATTR kernel.js:2896) | yes: raw-mode probe logic | THREE-WAY (Env B only) |
| D19 | `ftruncate` size width | Number(length) (host.js:428) | Number(size) (host.js:4623) | **`req.size \| 0` — 32-bit clamp kernel-side** (kernel.js:3406): >2 GiB wraps negative → EINVAL | yes, >2GiB only | DIVERGENT (edge) |
| D20 | `__fs_watch` surface | **absent from the import object entirely** → `WebAssembly.instantiate` LinkError (no missing-import filler exists in host.js) | ENOSYS (host.js:3624, 4364) | real (kernel.js:8043) | program using os/fswatch.h won't even load under Env N | DIVERGENT (surface, not behavior) |
| D21 | errno ordering on RO volume | n/a | `fchmod`/`futime` check EROFS **before** EBADF (host.js:3714, 3744) — fchmod(badfd) on an RO mount → EROFS | same | yes (minor) | DIVERGENT (minor) |
| D22 | `futime` on fd 0–2 | works (host OS) | EINVAL (host.js:3748) | EBADF (kernel.js:3438: non-'file' OFD) | yes (minor) | THREE-WAY (minor) |

**Parity found (contract matches where it matters):** `close` (std-fd
no-op semantics, host.js:308–334 vs 2964–2975), zero-length `read` returns 0
immediately in all three (host.js:213, :971; host.js:3250 / kernel.js:6664),
regular-file read fills to min(count, EOF) in all three — brokered via the
0140 fill loop (kernel.js:7677–7707), `lseek` whence/EINVAL/ESPIPE
(host.js:384–414 vs 3105–3125 vs kernel.js:3321–3327), O_APPEND positioning
(host.js:292–305/358–372 vs 2871/2956/3073), `mkdir`/`rmdir`
(ENOTEMPTY)/`unlink` (EPERM-on-dir)/`link`/`symlink` (EEXIST)/`readlink`
(truncating, no NUL)/`chmod`/`utime`, hole zero-fill on write-past-EOF
(host.js:3088–3091), `getcwd` ERANGE→0, `realpath` NULL-buf EINVAL + physical
resolution (host.js:479–495 vs 4610–4621 + 3867–3895, one FS_REALPATH RPC
kernel.js:3499), `dup`/`dup2`/`F_DUPFD` shared-offset semantics, select's
64-fd window and never-set exceptfds in all three (host.js:908 / 4491 /
kernel.js:8061), umask 022 net effect (host.js:2927 vs host umask).
`sleep`/`usleep`/`select` EINTR exists only where signals exist (Env R,
host.js:5703–5729, 4537–4549) — environmental, not a defect.

## 3. Ranked findings

**F1 (file as P0): `open(O_CREAT)` through a dangling symlink corrupts the
directory** — D1/D2. Both gucOS envs; POSIX says create the target.
BlockFS's create branch inserts a dirent for the *lexical* name without
checking that a (symlink) dirent of that name already exists
(host.js:2911–2953). Result verified: two `dang` entries with different
inodes; `unlink` then removes only the first (the new file), resurrecting
the symlink. `tar -x`, `cp -a`, or a package restore over pre-seeded
symlinks is the natural trigger. Companion defects: fsck_v4 has no
duplicate-name invariant (passes the image clean), so `tests/blockfs/test_fsck_v4.js`
can't see it either.

**F2 (file as P0 or explicitly waive): no access-mode enforcement on gucOS
fds** — D3. `write()` on an O_RDONLY fd silently mutates the file in both
gucOS envs. This is the corruption-capable half; the read-on-O_WRONLY half
is disclosure-only. Cheap fix shape (not done here, read-only thread): store
`flags&3` on the fd entry at open, check in read/write; kernel OFDs likewise.

**F3: brokered `write()` short-writes at 60,000 B** — D4. The exact mirror
of the 0140 read bug the estate already paid for once (mGBA's unlooped ROM
read), still open on the write side. Any unlooped `write()` >60,000 B works
under Env N and Env B and silently truncates in-OS. Either loop-fill
regular-file writes in RemoteFS.write (symmetry with read) or document the
short-write as contract and prove stdio loops.

**F4: readdir error-vs-EOF conflation, inverted** — D5. 0340 made EOF clean
by making *every* null clean; the real-failure branch is dead code
(host.js:4266–4269 tests for a negative number no fs method ever returns).
To make the branch live, `BlockFS.readdir`/`RemoteFS.readdir` would need to
return a distinguishable error value (or toWasmEnv consult `_lastError`
explicitly on null-with-error). Low urgency (EBADF-at-readdir is
POSIX-may-fail), but the dead branch documents an intention the code
doesn't implement.

**F5: `d_type` never reports DT_LNK/DT_CHR/DT_UNKNOWN in gucOS** — D6.
One-line class in `BlockFS.readdir` (host.js:3558). Directly mis-answers
CPython's `os.scandir` fast path and any `find`-class tree walker in-OS.

**F6: rename type-check gaps** — D7. `rename(file, emptydir)` and
`rename(dir, file)` both succeed in gucOS; POSIX EISDIR/ENOTDIR.

**F7–F13 (batch, mostly small):** F_GETFL fabrications (D9), walk-errno
collapse to ENOENT (D10), `access` ignoring mode incl. W_OK-on-/usr (D11),
EISDIR on directory opens breaking fsync-the-dir durability idioms (D12),
isatty three-way + missing errno (D13), fstat-on-pipe three-way (D8),
fsync/futime/EROFS-ordering/ftruncate-clamp minors (D14, D19, D21, D22),
`__fs_watch` LinkError asymmetry (D20).

Not filed as bugs: D15/D16 (documented or inherent transport differences),
D17 (Node env's d_ino=0 — worth fixing for symmetry when D6 is touched),
D18 (Env B canned termios — standalone pages have no kernel to ask).

## 4. The design question: do libc contracts deserve their own conformance seats?

**Yes — and the evidence in this file is the argument.** The current
distribution: the conformance corpus (141 dirs) runs the *Node* env by
default; 23 tests opt into in-process BlockFS; the brokered env — the one
every gucOS process actually uses — has **zero** contract seats and is
guarded only by whatever application e2es happen to trip over (0340 was
found because CPython checks errno after readdir; D1–D7 above sat unfound in
exactly the same way). The 0340 regression guard itself rides one filterable
e2e (tests/kernel/test_python_clang_e2e.js:176–199, :270–271) — `--filter`
that file away and the estate's only readdir-errno assertion goes with it.
And the two "implementations" that share toWasmEnv still diverge at the
method layer (D4, D5, D8, D13, D14), so "test one of B/R" does not cover the
other.

**Recommended shape — one C contract corpus, three seats:**

1. A new `tests/unit/conformance-libc/` (or a `libc_` prefix inside the
   existing corpus): small C programs asserting the *import contract* —
   errno discipline (readdir EOF/EBADF, ENOTDIR fidelity), EOF/short-read,
   partial-write behavior (>60,000 B writes), flag handling (F_GETFL,
   O_APPEND, O_CREAT-through-symlink, O_EXCL), fd semantics (access-mode
   enforcement, dup offset sharing), dirent fields (d_type, d_ino, dot
   entries). Each is exactly the `parse_bitfield_wide_promote` pattern: the
   property, not an app proxy. Divergences that are *by design* (pipe
   blocking in Env B, SIGPIPE only in-OS) get per-env expected files or are
   scoped out per seat.
2. **Seat 1 (Node) and Seat 2 (in-process BlockFS)** are nearly free: the
   runner already supports both (`config.blockFs`,
   tests/run-unit.js:308–331); the corpus runs both by adding the flag.
   Known divergences land as `knownBug`-pinned xfails per env (the existing
   mechanism, applyKnownBug) so the suite is born green and every fix
   converts to a permanent guard loudly.
3. **Seat 3 (brokered)** is the new work: a thin kernel-suite runner
   (`tests/kernel/test_libc_contract_e2e.js`) that boots once and runs the
   *same corpus binaries* via the real spawn path, diffing the same expected
   files. The corpus stays single-sourced; only the harness differs. This is
   the seat that would have caught 0340, D4, D5, D8 before any app did.
4. Wire a RULES entry: `host.js` / `kernel.js` fs-surface changes →
   `unit`-libc + the contract e2e — today host.js already maps to unit/
   kernel suites, so the mapping cost is a filter, not a new rule class.

**Cost, honestly:** the corpus itself is the cheap part (each probe here is
10–30 lines of C; ~25 tests covers every row in §2). Seat 1+2: small —
runner mechanism exists. Seat 3: one new e2e harness file (~150 lines on the
driveBoot pattern) plus per-env expectation plumbing in the corpus config —
call it one medium ticket. Runtime: seconds for seats 1–2 (they batch into
the existing unit run), one extra boot for seat 3 in the kernel suite. The
alternative — keep discovering these one CPython behavior at a time — has
already cost 0340, 0140, and the D1 corruption is sitting in the tree today.

Suggested queue items (for the master to file, not filed by this read-only
thread): (a) P0 — D1 dangling-symlink O_CREAT duplicate dirent + fsck_v4
name-uniqueness invariant + red control; (b) P0-or-waive — D3 access-mode
enforcement; (c) P1 — D4 brokered write fill (or documented contract);
(d) P1 — the libc contract corpus + three seats (subsumes regression guards
for all of §2); (e) P2 — the errno-fidelity batch (D5, D6, D7, D9–D13) as
individually small fixes landed test-first into that corpus.

## 5. Method note

Verification: both env bodies and every `BlockFS.prototype`/`RemoteFS.prototype`
fs method were read in full; kernel `_fsRpc` arms read for every op named
above. Behavioral rows D1, D2, D3, D5 (B-side), D6, D7, D8 (B-side), D10,
D11, D13 (B-side), D14 (B-side) were additionally confirmed by executing
throwaway scripts against the worktree's `host.js` (in-memory store).
Brokered-side rows rest on code reading of kernel.js (RemoteFS + `_fsRpc`),
not on a booted OS — none of them depend on timing or state that a boot
would change (they are straight-line request/response code), but a seat-3
harness would make them executable facts.
