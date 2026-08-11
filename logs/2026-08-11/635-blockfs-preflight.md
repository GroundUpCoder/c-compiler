# #635 — BlockFS preflight: rmdir("/"), rename cross-type / root / own-subtree

Lane: `lane-635` off `c6d9086d`. Jku-directed P0 (data-integrity class, relayed
from the GLM audit and re-reproduced by @master before filing).

## What was wrong

One class, one blind spot: `_resolvePath` fully normalizes, so the
`substring(lastIndexOf('/'))` parent-derivation idiom yields an empty name and
"parent = the path itself" for exactly one input — a path resolving to `/`.
Any op that reaches that idiom with `/` runs its dirent arithmetic against
inode 1.

Re-derived the full referent set at `c6d9086d` (the ticket asked for the
sweep, listing `unlink`/`mkdir`/`symlink`/`link`/`mknod` as candidates —
all of those turn out to be guarded):

- `mkdir`/`mknod`/`symlink`/`link(newpath)` — EEXIST guard fires first
  (`/` always exists), parent derivation unreachable.
- `unlink` — root is a directory → EPERM at the type check first.
- `open` O_CREAT create-branch — unreachable for `/` (the walk succeeds);
  `open("/", O_TRUNC)` refuses EISDIR before the trunc branch.
- `_spliceFinalLink` — only runs when `resolved` names a symlink; never `/`.
- **`rmdir("/")`** — UNGUARDED (ticket defect 1): on an empty root the
  emptiness guard doesn't fire, the arithmetic underflows root's `dataSize`,
  decrements its nlink and `_freeInode`s inode 1. Returns 0; fsck reports
  `root inode 1 is not a live inode`; the image is unrecoverable.
- **`rename("/", "/x")`** — UNGUARDED and NOT in the ticket: returns 0,
  hardlinks `/x` to inode 1 and damages root's own dirent stream. fsck:
  `directory cycle: inode 1 reached twice (/x)` + an orphan. Fourth member
  of the class. (`rename(x, "/")` errored only by accident — ENOTEMPTY,
  because the source's own existence populates root.)

Plus the two cross-type defects (ticket defects 2/3): rename never compared
source type to target type, so file-over-directory and directory-over-file
both returned 0 and silently flipped the target name's type — **with fsck
clean**, since the damage is semantic, not structural.

And a fifth, refuting half of the ticket's "not a defect" note: the note held
for `rename("/a", "/a/b/c")` (nonexistent deep target → ENOENT, clean
rollback), but the neighboring input `rename("/a", "/a/b")` with an EXISTING
empty `/a/b` returned an error having ALREADY corrupted the store — after the
source dirent removal the target-parent re-walk fails (the parent just became
unreachable), so the target's dirent removal is skipped but `_dropLink` still
runs: `dir 2: entry 'b' -> inode 3 which is not live`.

## The fix (host.js, all preflight — before the first dirRemove)

- `rmdir`: `resolved === '/'` → EBUSY (root qua root, populated or not — the
  ticket's instruction not to lean on the emptiness guard).
- `rename`: `oldResolved === '/' || newResolved === '/'` → EBUSY, right after
  the same-path no-op.
- `rename`: own-subtree check `newResolved.indexOf(oldResolved + '/') === 0`
  (source a directory) → EINVAL — this is what fixes the fifth defect, and it
  falls out of the preflight for free as the ticket predicted.
- `rename`: cross-type — dir over non-dir → ENOTDIR, non-dir over dir →
  EISDIR, before the ENOTEMPTY check (Linux ordering). Same-inode no-op stays
  first; dir-over-EMPTY-dir and file-over-file stay permitted (controls pin
  both).

With these, no public entry point can reach the empty-`dirName` arithmetic:
the latent-underflow sibling hazard the ticket flagged is closed classwide,
not per-symptom.

## Evidence

Six regressions + two preservation controls in `tests/blockfs/test_posix.js`
(25 → 33). All six demonstrated failing at base (committed test-first,
`0d4b878a`), green after the fix. fsck runs at the end of every case; the
empty-fs rmdir case proves inode 1 survived by `mkdir("/x")` succeeding after
the refusal.

No image bump: host.js IS a bake input (`newestBakeInput`, os-common.js:2489
— staleness is mtime-handled Node-side), but the bake path contains zero
`rename`/`rmdir` calls (grep -c over os-common.js + mkimage.js), so blob
bytes are identical and the browser's version-gated re-fetch has nothing to
fetch.
