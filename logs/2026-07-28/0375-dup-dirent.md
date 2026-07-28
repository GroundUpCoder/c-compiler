# 0375 — O_CREAT through a dangling symlink: duplicate dirent, and the checker that couldn't see it

Lane for todos/0375 (P0), branch `0375-dup-dirent`. Source: the libc
env-divergence review (`logs/2026-07-28/review-libc-env-divergence.md` on
`origin/review-libc-divergence`, rows D1/D2, finding F1) — the review had
*executed* the repro, master cont-122 queued it.

## The defect, and why it was a class

POSIX `open(path, O_CREAT)` follows a **final-component symlink** even when
creating: a dangling link means "create the *target*". BlockFS's create
branch never re-checked the lexical name after the full walk returned null,
so it appended a **second dirent under the link's own name**. Two entries,
one name, different inodes; resolution is first-match, so `unlink` removed
the new file and resurrected the symlink. Both gucOS environments (kernel
FS_OPEN → the same `fs.open`).

Reading the neighbours before fixing turned one bug into four: **mkdir,
mknod and link had the sibling defect** — their EEXIST guards used a
*full-follow* walk, so a dangling link at the target name answered "doesn't
exist" and they inserted the same duplicate. (POSIX: none of those follows
the final symlink — the correct answer is EEXIST.) `symlink()` and
`rename()` were already correct: their target checks walk `noFollowFinal`.
That asymmetry — two ops right, four wrong, all adjacent — is the argument
for fixing the class, not the reported op.

## Fix shape

- `open()`: when the full walk finds nothing and O_CREAT is set, chase the
  final component by lstat hops (`_spliceFinalLink`, mirroring `_walkHops`'
  target-splice rules: absolute restarts, relative joins the link's dir,
  mounted volumes resolve in the full namespace). ELOOP-bounded;
  `O_CREAT|O_EXCL` refuses EEXIST **on the symlink itself** (POSIX);
  empty target → ENOENT. The chase sits *before* the EROFS check — the
  load-bearing escape-before-EROFS ordering (`/usr/...` → `/var/...`)
  is untouched, and a cross-volume dangling link never reaches the chase
  anyway: the initial full walk throws `__mountEscape` first and MountFS
  reroutes the whole open to the owning volume (pinned by a test).
- mkdir/mknod/link: EEXIST walks become `noFollowFinal` — one-argument
  fixes.
- `fsck.js` + `fsck_v4.js`: per-directory **duplicate-name invariant**. The
  companion defect (D2) was the reason this went unnoticed: a checker that
  passes a corruption clean is not a checker for it.

## Test-first record

Red commit `b744ae3c` (all counts verified failing before the fix), green
after `df591cbd`:

- `tests/blockfs/test_posix.js`: 9 new cases (dangling / chain / relative
  target / O_EXCL / ELOOP loop / missing target parent / mkdir / link /
  mknod-v4) — 9 FAIL → 19/0.
- `tests/blockfs/test_fsck.js` + `test_fsck_v4.js`: **positive control** for
  the invariant — the corrupt image is built by *raw surgery* (rename one of
  two same-length sibling dirents onto the other's name), independent of any
  host.js code path, so the control outlives the open() fix. Both checkers
  passed the corrupt image clean pre-fix (1 FAIL each) → 11/0, 13/0.
- `tests/blockfs/test_mounts.js`: in-volume dangling on a mounted volume
  (reproduced the dup) + cross-volume escape (already correct, pinned).
- `tests/kernel/test_symlink_create_e2e.js` (new, registered): the
  **brokered** environment — hush redirects + ln/rm/mkdir over the kernel
  FS RPCs. Pre-fix: `ls` printed `["l","l"]`, `rm` resurrected the link,
  `mkdir` over a dangling link exited 0 and duplicated. 9 FAIL → 9/9.

## Existing images

- A fresh `mkimage` bake (v182) is **CLEAN** under the new invariant — the
  bake path mints no duplicates, and every bake is fsck-checked, so a
  regression fails loudly now.
- **Persistent user/root volumes can already carry the corruption** (any
  pre-fix tar -x / cp -a / package restore over a dangling symlink), nothing
  fscks them at boot, and the fix does not repair them. Filed as
  **todos/0379** (repair policy + salvage; not folded in).

## Gotchas worth keeping

- The u32-at-nameLen-offset `& 0xFFFF` trick in both fsck walkers is
  little-endian-dependent (DIR_ENT_HEADER is 4+2); MemoryByteStore is
  explicitly LE, so the surgery helpers in the tests read/write name bytes
  at `+6` directly.
- The new fsck invariant survived the existing model fuzzer (10 seeds × 600
  ops with fsck after every op) unchanged — no false positives from normal
  operation, which is the cheap proof the invariant is a real invariant.
