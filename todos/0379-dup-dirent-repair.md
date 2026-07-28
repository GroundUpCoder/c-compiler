# 0379 — Repair path for duplicate-dirent corruption on existing user volumes

- **Status**: open
- **Design**: todos/done/0375-blockfs-dangling-symlink-dup-dirent.md (the
  defect + why the class is now detectable); `logs/2026-07-28/0375-dup-dirent.md`

## Goal

todos/0375 fixed the corruption *source* (`open(O_CREAT)` through a dangling
final symlink — and the mkdir/mknod/link siblings — appended a second dirent
under one name) and gave `fsck.js`/`fsck_v4.js` the name-uniqueness invariant
that detects it. What it deliberately did NOT do is repair images corrupted
**before** the fix:

- **Baked system blobs are fine** — a fresh bake was verified CLEAN under the
  new invariant, and every bake is fsck-checked, so any bake-path regression
  now fails loudly.
- **Persistent user/root volumes are the exposure**: browser OPFS
  `os-root.v5.img` (and Node-side image files) are never fsck'd at boot. Any
  pre-fix `tar -x` / `cp -a` / package restore over a pre-seeded dangling
  symlink left a duplicate dirent that is now permanent: path resolution is
  first-match, so one of the two same-named inodes is unreachable-but-live,
  and `unlink` semantics on the pair are wrong (remove one, "resurrect" the
  other). The 0375 fix prevents new instances; it cannot see old ones.

A repair needs a policy decision (which entry wins — first match preserves
observed post-corruption behavior; the other inode's data should probably be
salvaged to a `lost+found` rather than freed blind), which is why this is its
own ticket rather than a fold-in.

## Plan

1. Decide the repair policy (keep-first + salvage-second-to-lost+found is the
   conservative default; nlink/refcount must be re-balanced either way).
2. Implement as a repair mode alongside the detection-only fsck (fsck is
   deliberately detection-only today — keep the checker independent; the
   repairer may live in host.js or a small tool, but must be verified BY the
   independent fsck afterward).
3. Decide where it runs: an explicit tool invocation at minimum; whether the
   OS should fsck/repair user volumes at boot (cost: full-image scan on every
   boot) is part of the design.
4. Tests: corrupt an image the raw-surgery way (the 0375 positive-control
   pattern in `tests/blockfs/test_fsck_v4.js`), repair, prove fsck_v4 goes
   clean and the surviving tree matches the keep policy.

## Acceptance

- A duplicate-dirent image is repairable; post-repair `fsck_v4` reports clean
  (including nlink/refcount balance), demonstrated from a raw-surgery corrupt
  image.
- The salvage policy is written down and tested (no silent data loss without
  a recorded decision).
- An explicit statement of where repair runs (tool-only vs boot-time) with
  rationale.
