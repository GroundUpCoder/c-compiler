# 0375 — open(O_CREAT) through a dangling symlink appends a DUPLICATE dirent — on-disk directory corruption, and fsck_v4 passes it clean

- **Status**: open
- **Priority**: **P0** — on-disk corruption, reachable from ordinary user
  actions, present in **both** gucOS environments, and invisible to the
  filesystem checker.
- **Difficulty**: medium
- **Design**: `logs/2026-07-28/review-libc-env-divergence.md` on
  `origin/review-libc-divergence` @ `ecfc0f40` — rows **D1** and **D2** of the
  22-row divergence table, and finding **F1**. **Read §2 rows D1/D2 and §3 F1
  before scoping.**
- **Provenance**: the libc env-divergence deep dive (Fable), 2026-07-28. ⭐ The
  review **executed** these rows, it did not only read them: *"verified: root
  listing `["dang:9","dang:8"]`"*. Filed by master cont-122 — the review had
  named it and nobody had queued it.

## The defect

POSIX: `open(path, O_CREAT)` where the final component is a **dangling
symlink** creates the *target* file. Node passthrough does this correctly
(`host.js:286`).

BlockFS does not. Its create branch inserts a dirent for the **lexical** name
without ever re-checking whether a dirent of that name (the symlink) already
exists — `host.js:2911–2953`. Result, **verified by execution**:

```c
symlink("/t", "/l");
open("/l", O_CREAT, 0644);
/* readdir now shows TWO entries named "dang", with different inodes:
   ["dang:9", "dang:8"]                                              */
stat("/t");   /* ENOENT — the target was never created */
```

Then `unlink` removes only the **first** match — the new file — **resurrecting
the symlink**. The directory is now permanently inconsistent.

**The kernel path has the same code** (`kernel.js:3188 → fs.open`), so this is
both gucOS environments, not one.

**Natural triggers, none exotic:** `tar -x`, `cp -a`, or a package restore over
pre-seeded symlinks. gucOS seeds symlinks.

## The companion defect — D2, and it is why this went unnoticed

**`fsck_v4.js` has no name-uniqueness invariant.** It passes a
duplicate-dirent image **clean** — verified: `fsck(store)` returns `[]` on the
corrupted image. So `tests/blockfs/test_fsck_v4.js` cannot see this either.

🔴 **Fixing the create branch without adding the invariant leaves the class
open.** A checker that cannot see a corruption is not a checker for it, and the
next variant of this bug gets the same free pass.

## Plan

1. **Test-first.** Commit a red test that builds the corrupted image and shows
   the duplicate dirent, and a red `fsck_v4` case that shows the checker passing
   it. Both must be red before either fix lands.
2. Fix the create branch: resolve the final component's existing dirent
   (symlink included) before inserting; create the **target** per POSIX.
3. Add a **name-uniqueness invariant** to `fsck_v4.js`, with a **positive
   control** — hand it a known-corrupt image and show it goes red. *A scan whose
   "nothing found" is meaningful must carry a positive control.*
4. Check the kernel path (`kernel.js:3188`) takes the same fix — it shares the
   code, so confirm rather than assume.
5. ⚠️ Consider whether existing on-disk images can already carry the corruption.
   If so, say so explicitly; a repair path may be owed as its own ticket.

## Acceptance

- The red tests from step 1 go green, and both are permanent tests, not probes.
- `symlink("/t","/l"); open("/l",O_CREAT)` creates `/t`, leaves exactly one
  dirent named `l`, and `stat("/t")` succeeds.
- `fsck_v4` **rejects** a duplicate-dirent image, demonstrated with a positive
  control.
- Both gucOS environments covered (in-process BlockFS **and** brokered/kernel),
  not just the one that was easiest to test.
- `blockfs` + `kernel` suites green with NUMBERS. ⚠️ `test_os_boot.js` needs
  719 s on an idle box against a 900 s cap (`0369`) — if it times out under
  contention that is `0369`, not your bug.
- `todos/LIABILITIES.md` is machine-checked by the `todos` suite — re-anchor or
  retire any anchored line this change rewrites, in the same commit.
