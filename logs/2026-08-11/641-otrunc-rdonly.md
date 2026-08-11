# #641 — `open(path, O_RDONLY | O_TRUNC)` destroys file contents

**Verdict: REFUTED as a defect. The truncate is correct — it is the Linux
answer, and gucOS emulates Linux.** Outcome (2) of the three the ticket
allowed: keep the behaviour, record the decision, pin it on both backends so
the next audit does not re-file it.

**One real defect WAS found on the same code path and fixed:** the truncate
marked `mtime` only. POSIX requires it to mark the **last file status change**
timestamp too. `ftruncate()` had the identical gap.

---

## 1. What the source actually says (re-derived at the lane tip)

The kickoff's line numbers had drifted, and one referent was wrong:

| Kickoff / ticket claim | At `84a87265` |
|---|---|
| `host.js:2911` `BlockFS.prototype.open` | ✅ `host.js:2911` |
| `host.js:2913` `var trunc = !!(flags & 0x200)` | ✅ `host.js:2913` |
| `host.js:2987` frees the extent, no access-mode test | ✅ `host.js:2987`; confirmed — nothing on that path reads `flags & 3` |
| `host.js:2960` the only access-mode-ish gate, volume-scoped | ✅ `this._readonly && ((flags & 3) !== 0 \|\| create \|\| trunc \|\| append)` → `EROFS` |
| `kernel.js:3912` ftruncate gates on write intent | ✅ the comment lives there; the **implementation** is `host.js:3846` (`entry.accmode === 0` → `EINVAL`) |
| `kernel.js:3672` `(req.flags & 0x200) \|\| !oExisted → dirty` | ✅ `kernel.js:3672` |
| `kernel.js:9249` "an RO-volume guard that DOES name O_TRUNC" | ❌ **wrong referent.** `kernel.js:9249` is `ProcFS.prototype.open` — the synthetic `/proc` volume, which refuses *all* write intent with `EACCES`. It is not the RO-volume guard. The RO-volume guard is `host.js:2960`. |
| `host.js:5548` wasip1 `oflags & 8 → 0x200` | ✅ `host.js:5548`, inside `path_open` |

A **fourth** surface the ticket did not name, found by reading:
`RemoteFS.prototype.open` (`kernel.js:8378`) already classifies `O_TRUNC` as
write intent — the local sealed-`/usr` fast path gates on
`(flags & 3) === 0 && (flags & 0x640) === 0`, and `0x640` includes `O_TRUNC`
(0x200). So a truncating open under `/usr` is always brokered and hits the
`EROFS` walk. No gap there; nothing to change.

## 2. Dynamic reproduction — BOTH backends

`/tmp/otrunc-repro.js` (scratch, not committed): seed an 11-byte file, then
`open(O_RDONLY|O_TRUNC)`.

```
== backend A: in-process BlockFS (host.js) ==
  before:  size=11
  open(O_RDONLY|O_TRUNC) -> fd=3 errno=-
  fstat(fd).size=0
  after:   size=0
  fsck: CLEAN
== backend B: kernel-brokered (kernel.js FS_OPEN, real SAB protocol) ==
  before:  size=11
  FS_OPEN(O_RDONLY|O_TRUNC) -> {"fd":3}
  FS_FSTAT(fd).size=0
  after:   size=0
  fsck: CLEAN
```

Reproduced on both, identically. **`fsck` is CLEAN on both** — the extent is
returned to the allocator, not orphaned, so there is no leak half to this bug.
Backend B drives the real kernel-page RPC transport (`writePayload` →
`RPC_REQUEST` → `readPayload`) over fake workers; no OS boot, no heavy lock.

## 3. The oracle — what do real POSIX kernels do?

**Darwin, measured live on this host** (`/tmp/otrunc_mac.c`, compiled and run):

```
before: size=11
open(O_RDONLY|O_TRUNC) -> fd=3 errno=0 (-)
after:  size=0
```

macOS truncates and returns a valid fd.

**Linux truncates too.** No Linux box was available to measure, so this rests
on the kernel source rather than a run — stated plainly:

- `fs/open.c build_open_flags()`: `if (flags & O_TRUNC) acc_mode |= MAY_WRITE;`
  — `O_TRUNC` raises the **permission** requirement (write permission on the
  file), it never touches the access mode.
- `fs/namei.c do_open()`: `do_truncate` is set from *"the dentry is a regular
  file AND `open_flag & O_TRUNC`"*. There is no `O_ACCMODE` test on that path;
  the only special case clears `O_TRUNC` for a file the same open just
  **created** (`FMODE_CREATED`) or for a non-regular file.

**POSIX**: *"If O_TRUNC is set and the file already exists and is a regular
file and the file is successfully opened O_RDWR or O_WRONLY, its length shall
be truncated to 0 … The result of using O_TRUNC without either O_RDWR or
O_WRONLY is undefined."* Undefined — not "shall fail". Both kernels I can
point at resolve the undefined case the same way.

## 4. In-tree evidence (outcome 1) — none, either way

Swept every `*.c`/`*.h` in the tree for `O_TRUNC` (97 hits). **No in-tree or
vendored program passes `O_TRUNC` without `O_WRONLY`/`O_RDWR`.** The three
near-misses are all *implementations*, not consumers:

- `vendor/tinyemu/fs_net.c:1026` — a **9p server** skipping truncate for
  `P9_O_RDONLY`. That is the 9p protocol's own rule, not `open(2)`'s.
- `vendor/zlib/src/gzlib.c:243` and `vendor/busybox/**` — always
  `O_WRONLY|O_CREAT|O_TRUNC`.
- `os/win32/kernel32.c:436` — `TRUNCATE_EXISTING` maps to `O_TRUNC`; the Win32
  caller supplies `GENERIC_WRITE`, so the access mode is never `O_RDONLY`.

So outcome 1 is unavailable: nothing in the tree constrains the choice. The
choice therefore falls to "match the emulated platform".

## 5. The decision, and why not "reject"

**Truncate. Keep the current behaviour.** Reasons, strongest first:

1. **Rejecting diverges from both kernels that were checked.** A program ported
   into gucOS that opens `O_RDONLY|O_TRUNC` and relies on the file being empty
   would silently keep its old contents — a *new* data bug, introduced by the
   "fix", in the direction the audit was trying to protect.
2. **"The two paths disagree" is not evidence of a defect here.** POSIX
   *defines* `ftruncate` to require a writable fd and *deliberately leaves*
   the `O_TRUNC` case undefined. The two paths differing is the standard's own
   shape, not drift. Harmonizing them would be harmonizing to the wrong side.
3. **The scary half of the report is not real.** "Destroys file contents on a
   non-writable fd" reads like a privilege hole. It is not: the caller asked
   for the truncate explicitly with `O_TRUNC`, on a writable volume, and the fd
   handed back is still read-only — `accmode` is `flags & 3` = 0, so `write()`
   on it is `EBADF` (todos/0376). Truncating never grants write access. Both
   pinning tests assert this half.
4. **The wasip1 seam agrees by construction.** `path_open`
   (`host.js:5538`) derives `accmode` from the *rights* bits and forwards
   `gflags | accmode` to the same `open()`. wasi-libc computes read-only rights
   for `O_RDONLY|O_TRUNC`, so a rejection would surface as an unexpected
   `EACCES` to wasm code that Linux serves. (Read, not run — declared in §9.)
5. **The kernel's watch bookkeeping already assumes the truncate is real.**
   `kernel.js:3672` marks the OFD dirty on the `O_TRUNC` **flag**, not on write
   intent, so an editor watching the file gets its `FSW_CLOSE_WRITE` settle.
   That is correct only under this decision; a rejection would have to change
   it too.

Not a "no fix needed, move on": the code now *says* the decision at the site,
the design doc records it, and two tests hold it down.

## 6. The real defect found on the same path — ctime

POSIX `open()`: a successful `O_TRUNC` *"shall mark for update the last data
modification and last file status change timestamps of the file."*
`truncate`/`ftruncate` carry the identical sentence.

Both sites set `mtime` only:

- `host.js:2994` (the `O_TRUNC` arm) — `w.ino.mtime = this._now();`
- `host.js:3870` (`ftruncate`) — `ino.mtime = this._now();`

BlockFS *does* track `ctime` and *does* bump it everywhere else a size or
metadata change happens (`write` at `:3215` carries the comment *"a write
changes the inode (size/mtime) → ctime too"*; `chmod`/`fchmod`/`utime`/
`futime`/`link`/`rename` all bump it). So a truncate — the one operation that
changes a file's size to zero — was the hole: any consumer using `ctime` as a
staleness key saw an unchanged inode. Both are now `mtime = ctime = _now()`.

**No image-determinism risk:** the deterministic bake injects a fixed
`opts.clock` (todos/0249), so `ctime` on a bake-time truncate resolves to the
same constant the creation stamp already used. Bakes stay byte-identical.

## 7. Coverage, with red controls

Two pins, one per backend, plus the timestamp pin:

| Test | Backend | Asserts |
|---|---|---|
| `tests/blockfs/test_posix.js` — *"open(O_RDONLY\|O_TRUNC) truncates, and the fd stays read-only"* | in-process BlockFS | open succeeds; `stat`/`fstat` size 0; `read` → EOF; `write` → `EBADF` and file still empty; `fsck` clean |
| `tests/blockfs/test_posix.js` — *"O_TRUNC without O_CREAT on a missing file is still ENOENT"* | in-process BlockFS | the refusal path is untouched |
| `tests/blockfs/test_posix.js` — *"O_TRUNC and ftruncate bump ctime as well as mtime"* | in-process BlockFS, **v4 + injected clock** | `mtime` **and** `ctime` move on both operations; `fsck_v4` clean |
| `tests/kernel/test_fs_e2e.js` leg 11 | kernel-brokered, **real C in a worker_thread** | `otrunc pre=11 ok=1 err=0 fsize=0 rd=0 wr=-1 we=1 post=0` |

`test_readonly.js:109` already pinned `open(O_TRUNC)` on a read-only volume →
`EROFS` (the one case where the truncate must NOT happen). Unchanged, still
green.

The v4-with-injected-clock form is deliberate: v3 stores whole seconds, which a
fast test cannot tell apart, and v4 is the format the shipped OS mounts.

**Red controls — every pin was proven to discriminate.**

1. *ctime fix reverted at the `O_TRUNC` arm:*
   `FAIL … O_TRUNC bumped ctime too: 1000 !== 5000` (35 passed, 1 failed)
2. *ctime fix reverted at `ftruncate` only:*
   `FAIL … ftruncate bumped ctime too: 5000 !== 9000` (35 passed, 1 failed)
   — run separately because the file aborts a case at its first failed
   assertion, so control 1 never reached the `ftruncate` half.
3. *The REJECTED alternative* (`if ((flags & 3) === 0) return
   this._setErr('EACCES')` in the trunc block), in-process backend:
   `FAIL … O_RDONLY|O_TRUNC must SUCCEED (the Linux answer), got EACCES`
4. *The same alternative, brokered backend:*
   `FAIL "otrunc pre=11 … post=0"  "otrunc pre=11 ok=0 err=13 fsize=0 rd=-1
   wr=-1 we=0 post=11"` — `EACCES` (13) propagates correctly through the RPC
   and the file survives at 11 bytes.

Control 4 also settles a side question: the reject alternative was *feasible*
on both backends. It is being declined on merit, not on cost.

## 8. Non-goals recorded (not silently cut)

- **No permission model.** Linux additionally requires *write permission* on
  the file for `O_TRUNC` (`MAY_WRITE`). BlockFS performs no mode-bit permission
  checking on `open()` at all — a 0444 file opens `O_WRONLY` today. That is a
  pre-existing, systemic property of a single-user, uid-less filesystem, not
  something specific to `O_TRUNC`; closing it means building a permission
  model, which is a separate piece of work. Named here so the absence is not
  mistaken for an oversight on this path.
- **Non-regular targets need no `O_TRUNC` clearing.** Linux clears `O_TRUNC`
  for anything that is not a regular file; BlockFS reaches the trunc block only
  after `S_IFDIR` → `EISDIR`, `S_IFSOCK` → `ENXIO` and `S_IFCHR` → early return
  (its comment already says `O_TRUNC` is a no-op there). There is no
  `S_IFIFO`/`S_IFBLK` inode in this filesystem (`mknod` is used only for
  `S_IFCHR` `/dev` nodes), so the case is unreachable.

## 9. What was NOT verified

- **Linux was not measured.** No Linux host was available; §3's Linux claim
  rests on kernel source, not on a run. Darwin was measured.
- **The wasip1 seam was read, not run.** `path_open` forwards to the same
  `open()`, so it inherits the decision by construction, but no wasm-level
  probe was executed.
- **The heavy gate has not run.** `lane-657` owns the heavy lock. Everything
  runnable without it was run (§10); `kernel` and `sweep` are pending master's
  release.

## 10. Suites run at the lane tip

`node tests/run.js --diff origin/main --dry-run` mandates **23 suites** (the
`host.js` edit pulls in nearly everything):

> todos, unit, host, blockfs, ast, extra, ext, projects, zlib, lua, freetype,
> libpng, libjpeg, cairo, micropython, micropython-upstream, sqlite, tcc, libc,
> fuzz, fakegit, kernel, sweep

Run so far (no heavy lock taken):

| | Result |
|---|---|
| `tests/run.js unit` | **826 passed, 0 failed, 3 skipped** (base baseline) |
| `tests/run.js host` | pass (303.8 s) |
| `tests/run.js todos` | pass (3/3) |
| every `tests/blockfs/test_*.js`, run individually | all exit 0; `test_posix` 36/0, `test_blockfs` 72/0, `test_fsck` 11/0, `test_tlsf` 17/0 |
| `tests/blockfs/test_fuzz.js` | 12/0 (6 seeds × {single,dual}, 1200 ops) |
| `tests/kernel/test_fs_e2e.js`, run directly | PASS (does not boot the OS, does not join the heavy lock) |

## 11. Epic justification

`epic:correctness`. The claim under review was silent data loss in the
filesystem under a plain `open()` — the exact path an in-OS developer's editor,
compiler and save loop runs through. It turned out not to be a defect, and
*establishing that* is the deliverable: an unpinned "undefined" corner is a
standing invitation to a future audit to "fix" it in the direction that would
break every ported program. The `ctime` gap fixed alongside it is a genuine
correctness dependency for any tool that keys on inode status time (make,
package managers, the in-OS package-dev work). Also jku-directed, 2026-08-11.
