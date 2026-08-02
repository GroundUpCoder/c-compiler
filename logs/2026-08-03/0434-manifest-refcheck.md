# #434 — manifest referential integrity: the un-bake is a graph edit

v223 shipped three first-boot Desktop launchers (`pokemon`, `mario`,
`drmario`) invoking `sameboy`, which #417/#418 had just moved out of the
baked set into a gucman package. On the deployed minimal artifact `strings`
finds `sameboy` exactly 3 times — all three the launcher scripts. Dead
icons on every clean first boot, the exact failure #419's acceptance names
("never a silently missing app or a dead menu entry").

## The durable fix: checkManifestRefs (os-common.js)

An un-bake is a graph edit, not a file deletion: launchers, menu entries,
symlinks and config seeds are EDGES, and removing a node must fail the
build while an edge still points at it. `checkManifestRefs(manifest)` is
pure (no fs/clock) and runs FIRST in `bakeSystemImage` — every bake path
(mkimage, boot.js, the in-worker browser fallback) gets it, checked
against the manifest that shape actually bakes (minimal vs folded), which
is exactly the per-shape answer that would have caught v223 pre-deploy.

Checked: `link` targets (resolved through /bin, /usr/local and manifest
links); `#!` scripts — interpreter, command-position words (PATH =
/usr/local/bin:/bin for bare words), and absolute path arguments; the
openwith and sounds-scheme seed values. The lines that keep the result
RAGGED (the false-positive class the ticket names):

- **Territory rule**: absolute references are only checked under the
  sealed /usr | /bin. `/opt/...` (the 0444 launchers' installed-prefix
  probe), /root, /var, /tmp are runtime state — never checked.
- Shell keywords/builtins are structure; `[`/`test`/`echo` args are data —
  the minesweeper sample's `[ -f /usr/include/png.h ] || gucman install
  libpng` is an honest ABSENCE probe and is not flagged.
- Wrappers (exec/command/env/term/xargs/...) pass through to the wrapped
  command; `sh -c "…"` recurses into the quoted body (catches a dangling
  command inside the etl/stl4-style launchers).
- `$…`/backtick/glob tokens are dynamic — skipped, never guessed.
- The cmdalt seed is EXEMPT by design: its values name PACKAGES
  (`python  cpython-clang`), and an unresolvable pick is cmdalt's
  specified loud-127 path (todos/0338), not a dead icon.
- `optional` entries (the gitignored ROMs) count as present: they are
  data, and the honest gap when absent is the seed-time skip log.

## The immediate fix

The three launchers are REMOVED (v224). No `sameboy` auto-install — that
is #419's mechanism done as a one-app special case. The optional ROM seeds
stay: once the sameboy package is installed, the gb/gbc openwith defaults
make them double-clickable from fileman. Rebuilt minimal artifact:
`strings | grep -c sameboy` = 0 (was 3); doom 34 / software 13 /
gucman 129 / cmdalt 43 stay high (the count discriminator, inverted).

Red-then-green on the REAL build path: `mkimage
--manifest=<origin/main image.json>` exits 1 naming exactly the three
launchers, before any compile; the fixed manifest bakes v224 sealed.

## Test fallout of the graph edit

The three icons were selection-test subjects. Re-pinned (cells stay
derived via drive.js deskEntries — the 0166 rule made this a rename, not
a re-derivation): wm_service plain-select drmario→fileman, shift-range
mario→notepad (doom..notepad, notes.txt outside), marquee-teal
mario→paint, single-click-no-launch drmario→notepad; os-shell ctrl-click
mario→paint, marquee pair (drmario,fileman)→(fileman,notepad), drag
pokemon→ctlpanel; desktop-defaults' content-script fixture is the
minesweeper sample (the last Desktop content script); fileman l4 greps
paint. `tests/host/test_manifest_refs.js` holds the checker to the #97
standard: red controls for every reference kind incl. the literal v223
trio injected into the real manifest (exactly 3 errors), green over the
raw + every-fold shapes, the negative controls asserted PRESENT, a
one-error raggedness leg, and a bakeSystemImage refusal leg.

Gates: todos + host green here (one recorded dispatch); kernel + sweep
are the heavy legs, deferred to the coordinator's batched gate per the
#415 rule (the heavy lock was held by the #117 gate for this lane's whole
life).
