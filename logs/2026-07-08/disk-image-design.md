# Disk-image design + WM queue promotion (todos/0038–0040)

Docs-only round: promoted the WM follow-ups into numbered items and
landed the read-only-system-image design.

## WM queue (0038, 0039)

The 0033 known-issues list had exactly one *fixable* bug (taskbar not
always-on-top) among four watch/checklist items — so it graduated per
WM.md's own rule into **0038** (fix item; wm.c re-raise policy vs a
kernel layer bit, decided in-item), and **0039** allocates the next
sweep round per the repeatable 0033 format (round 2 MUST include the
pointer-lock human check round 1 skipped). Both slotted at the top of
README's next-up.

## DISK-IMAGE.md (design; queued as 0040)

The question that forced the design: upgrades and user modifications
share the system volume today — a user writing /bin/foo collides with
what the next reseed expects, and the reseed itself is a boot-path
compile of the whole manifest. The user wanted "update = swap a
read-only drive".

Decisions (full rationale in `todos/DISK-IMAGE.md`):

- **One mkimage-baked read-only blob is the system.** Upgrade = swap
  the blob; rollback = keep the old one. The seed pipeline moves
  offline (mkimage drives os-common.js under Node) — bake-time
  compilation, same repo discipline, nothing compiles on boot.
- **Layout flip**: writable root volume at `/` (owns /etc /var /tmp
  /dev — all the awkward "system volume but user-mutable" paths today),
  RO system volume at `/usr`, `/bin → /usr/bin` merged-usr symlink.
  The flip is *configuration*: MountFS + the 0026 symlink-escape
  machinery already do everything needed except an EROFS flag.
- **/usr/local → /var/local** baked symlink = the admin's territory;
  PATH order (not file overwrites) is how users shadow system
  binaries.
- **/etc is systemd-style** (user's explicit call, over first-seed-
  then-freeze and ostree three-way merge): vendor defaults under
  /usr/share, /etc holds only overrides, an EMPTY /etc must boot,
  factory reset = wipe /etc+/var. Consumers today are just wm.c
  (/etc/menu) and term.c (font path) — two fallback lookups.
- Overlayfs-style copy-up was rejected explicitly: upper-layer copies
  shadow future system updates — the same conflict class relocated.

Prior art leaned on: macOS sealed system volume, Android/ChromeOS A/B
image swap, FHS /usr/local contract, systemd stateless-system /etc.

Open (recorded in the doc, decided in-item): blob version location,
virgin-boot user-volume asset seeding (doom1.wad), whether live-seed
survives as a dev flag. 0040 subsumes the old unnumbered mkimage
entry; its blob version doubles as 0037's module-cache key.
