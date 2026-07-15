# Desktop content: tool launchers (0184) + the mgp Presentations showcase (0185)

Two user-requested desktop items batched into one thread — both edit
`os/image.json`'s desktop seed, so ONE image bump (v92 → v93) and ONE golden
pass covered both.

## 0184 — tool launchers

Four `link` entries (the notepad shape): fileman, calc, paint, ctlpanel.
**`code` deliberately left off** — it's a line-oriented tty app (no SDL
window) that reads `ANTHROPIC_API_KEY` from `~/.profile`; a bare desktop
link would spawn it windowless and broken, and even a `term code` wrapper
greets a fresh user with a missing-API-key error. It has no menu entry
either; shell-only stays consistent.

## 0185 — Presentations showcase

**Prerequisite found and fixed**: a real directory on the desktop fell
through `activate()` to openwith (no extension) → `default.gui` → *notepad
opening a directory* — the same wart the ctx-menu "New Folder" had since
0091. Minimal fix: an `S_ISDIR` branch in wm.c's `activate()` spawns
`/bin/fileman <path>` (the Recycle Bin *script* precedent, without the
script). Start-menu dirs are flyout groups and never reach `activate()`, so
the branch only fires for desktop folders. `is_dir` icons now draw a
tab+body folder glyph (tile centers stay navy for the probe pixels; the tab
notch at tile +16,+6 is the folder-vs-launcher discriminator tests use).

**Decks**: seven authored decks at `vendor/magicpoint/decks/` (ours —
upstream `sample/` stays verbatim), seeded to `/usr/share/mgp/`, one
capability slice each: text / colors / align / bullets / images /
backgrounds / effects. Written against the 0119 port's real constraints:
mono.ttf is the only face, demo.gif the only image, no `%lcutin`/`%rcutin`
(they create X child windows, the stubbed-plist class), ASCII only (mgp is
byte-oriented Latin-1 — the first drafts' em-dashes would have rendered as
mojibake). Per-deck distinct `%default` backgrounds so pixel tests tell
them apart. Two parse gotchas the headless probe caught: a text line
starting with `%back` parses as a directive (→ `\%back`), and `\%` only
escapes at line START — mid-line it's "unknown escape sequence" (fatal).

**Desktop folder**: `/root/Desktop/Presentations/` holds one symlink per
deck (demo.mgp included) — single source under the sealed /usr,
EROFS-protected, and the `.mgp` link *name* keeps the openwith key so
fileman/desktop opens land in `/bin/mgp`.

## The golden pass — one grid model, not eight patches

Adding 6 entries (5 files + 1 dir) broke the desktop-grid math estate-wide,
in two distinct ways:

1. **Column wrap**: 14 seeded entries × 11 rows/col (1024×768) pushes
   quake/term/Recycle Bin into **column 1**; every `x=58` column-0 probe on
   a tail icon missed.
2. **The dirs-first blind spot**: the 0166-rule derivations read
   `user.files` only — a seeded *directory* was invisible (and worse, the
   new `Presentations/*.mgp` sub-entries would have polluted the name
   lists), shifting every index.

Fix: ONE shared model — `deskEntries`/`deskSort`/`deskCell` in
`tests/kernel/lib/drive.js` (ESM twin in `tests/browser/lib/os-harness.mjs`)
replicating wm.c `entcmp` exactly (Recycle Bin last, dirs first, strcmp) +
the column-major wrap at the live screen height. Five kernel e2es
(wm_service/recycle/ctxmenu/fileman_ops/openwith) and four sweeps
(os-shell/os-recycle/os-drop + os-aero's blend probes, which sat under
column 1's labels) now derive every cell through it.

Two legs needed intent-level fixes, not just coordinates: both "ArrowRight
selects the top-left icon" rename legs (kernel + browser) now had
Presentations at top-left — the kernel one silently renamed *the folder*.
Both legs drop the dir in their setup (their successor legs wipe the whole
Desktop anyway). The wm_service arrow-launch leg gained a `Down` step for
the same reason — and incidentally proved Enter-on-a-folder opens fileman.

**Diagnostic improvement** (the 0171 rule): `driveBoot`'s wait-timeout error
now appends the stdout tail before the first timeout — the bare
`wmctl: wait atleast timed out` named the symptom but not the script leg,
which cost a full re-run to localize.

New coverage: wm_service dblclicks Presentations → fileman opens AT it +
folder-glyph/link-notch pixel asserts; test_present pages through all seven
decks (title dominant-background + capability witnesses: red column, green
box / gold arc icons, GIF magenta/cyan, bgrad gradient bands) and asserts
the window survived every page — a draw-time crash can't hide.

## Gate

- `projects` 26/26, `kernel` 73/73, browser sweep 25/25 (all foreground).
- `tests/flake.js --kernel-only --filter=wm_service`: stable ×3 under load.
- os-quake's post-close "desktop restored" tolerance 5% → 12%: the probe
  region legitimately holds two icon columns now (measured 5.05%).
