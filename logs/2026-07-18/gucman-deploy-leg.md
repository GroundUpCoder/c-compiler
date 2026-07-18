# gucman deploy-leg — the split list becomes packages, comguc ships them (todos/0262, image v122)

Slice 1 (todos/done/0261) built the engine; this makes it the real
distribution story. The locked split list — quake (+pak0.pak), mgba,
winmine (+.res), cairodemo, sqlite3, lua, micropython, sent (+demo deck),
mgp (+every deck) — moves OUT of the baked /usr blob into
`packages/<name>.json` definitions, and the comguc Pages build ships the
MINIMAL image plus the package repo at `/packages/*`. DOOM stays baked (the
no-install game, per the locked design). Zero engine changes: gucman.c and
mkpkg.js are untouched — everything below is declarative package content,
one general veneer fix, and wiring.

## Self-locating launchers (the data-beside-binary pattern)

quake finds `./id1/pak0.pak` and writes config.cfg relative to the CWD
(sys_sdl.c basedir "."); mgp and sent open deck image refs CWD-relative.
So a package whose data sits beside its binary carries a `#!/bin/sh`
launcher as its bin command: chase `$0` through symlinks, cd to the
resolved dir, run the real binary. One script works in BOTH modes —
installed (`/usr/local/bin/<cmd>` → `/opt/<name>/…`) and fat-baked
(`/usr/bin/<cmd>` → `/usr/opt/<name>/…`) — because the location comes from
the resolved `$0`, never a hardcoded path. The gucOS-authored decks'
absolute `/usr/share/{mgp,sent}` image refs became relative
(`%newimage "demo.gif"`), and the launchers cd into the package `share/`
so they resolve; mgp's two menu commands (`mgp-demo`, `learn-mgp`) run
from `share/` for exactly this reason.

Two potholes found and worked around:

- **libc realpath() is lexical-only in the RemoteFS flavor** — it never
  resolves symlinks (`realpath /usr/bin/quake` returns the input;
  `readlink -f` same, both back onto the one import). Launchers use a
  plain-`readlink` chase loop instead. Filed as **todos/0263 (P0)** with
  the repro; the launchers can simplify once fixed.
- **hush `exec` is spawn-and-exit** under the vfork shim (no in-place
  exec in the owner-brokered process model), so `exec ./quake-bin` made
  the job pid vanish and `kill %1` couldn't reach the game. The launchers
  invoke the binary WITHOUT exec (the sh waits — terminal fg behavior
  stays faithful), and tests kill by `pkill`.

## The one veneer fix: user32 res_chase

The `.res` sidecar loader appended `.res` to the UNRESOLVED argv0, so a
winmine reached through `/usr/local/bin/winmine` → `/opt/winmine/winmine`
looked for `/usr/local/bin/winmine.res` (silently absent → no
menus/strings). `res_ensure` now chases trailing-component symlinks
(bounded readlink loop) before appending — the sidecar semantics become
"beside the REAL binary", the PE resource-section analog. Baked calc/
notepad (argv0 = real file) are byte-behavior-identical.

## Surfaced, not forced

- **ROM-launchers stay baked** (image.json user section, unchanged):
  (1) their ROMs are copyrighted and gitignored — a package payload would
  publish them in the public pool, exactly what comguc's ROM-leak guard
  exists to prevent (the guard can't even see inside .tar.gz payloads);
  (2) their only surface is Desktop icons, and the Slice-1 engine has no
  `desktop[]` planting vocab (reserved in the locked design, not yet
  implemented); (3) mkpkg builds must be deterministic from repo inputs —
  gitignored optional inputs would make index.json machine-dependent.
  comguc's existing image.json transform keeps stripping them from the
  public deploy — public behavior unchanged.
- **Desktop `Presentations` rw copies stay user-seeded** (the 0202
  masters+copies rule): they are deck COPIES for the right-click-Edit →
  reload teaching loop, not the mgp app itself. On a minimal boot they
  open in notepad until mgp is installed. Their tutorial deck 07 loses
  its inline image when opened from the Desktop (CWD /root, relative
  ref) — accepted; the learn-mgp launcher path renders it.
- **Returning-visitor wart**: an EXISTING public root volume keeps its
  old `/root/Desktop/quake` link (user territory is never touched by
  upgrade), which dangles on the minimal image — and would still point at
  `/usr/bin/quake` after a gucman install (which plants
  `/usr/local/bin`). Fresh boots are clean. This sits next to the
  marquee/pre-install decision and is left for it.

## The fat-data proof + estate

`tests/kernel/test_gucman_quake_e2e.js` (red→green; red demonstrated on
the stashed pre-split tree — fails loud on the minimal-proof leg and the
PATH probe): minimal boot → install the ~8.6 MiB payload → **in-OS
`sha256sum` of the installed pak equals the vendored file's hash** (the
fetch → inflate → untar → BlockFS chain round-trips 18.7 MB bit-exact) →
quake boots its window from `/opt` through the launcher chain → remove
replays clean. Two test-craft notes: quake's own console banner
(`========Quake Initialized=========`) collides with drive.js
`section()`'s `==` delimiters — this test uses `@@` markers; and the
absence probe is `which quake`, not a bare spawn, because on a
quake-on-PATH tree a spawn runs the game foreground and burns the boot
timeout (the 0171 rule: fail loud, don't nap).

Shared fixtures (minimal-blob cache, mkpkg repo, static serve.js) moved
to `tests/kernel/lib/gucman.js`; test_gucman_e2e refactored onto it.

Test churn from the moved paths, all mechanical: os_apps (pak at
/usr/opt/quake/id1), present + os-present (launch decks from the package
share/, using the seeded launchers in the browser leg), openwith (cp
source), fileman (/root row math without id1/), wm_service (the
shift-range TEAL witness icon quake → notepad).

## comguc

build.mjs: fresh dist/ first, minimal bake straight into
`dist/os/os-system.img` (`--out` — the c-compiler tree keeps its fat
fixture), mkpkg into the warm c-compiler pool + verbatim copy to
`/packages/{pool,index.json}`, quake/mgp allowlist entries dropped
(Presentations decks still globbed), `_headers` grows
`/packages/index.json` must-revalidate + `/packages/pool/*` immutable
(the 0249 content-hash pattern). verify.mjs now proves the deploy story
in-browser: minimal image (quake not baked) + `gucman install quake`
through the baked origin-relative `/packages` default → PASS. Deploy
size: dist 25.7 MiB total incl. the 11.7 MiB pool (previously the fat
image alone was ~40 MB).

Gate: image v122 sealed; kernel 86/86 (test_gucman_quake_e2e new), browser
sweep 28/28, projects 26/26; flake gate 3/3 stable under load on the new +
changed e2es; compiler.js untouched. Public deploy + the fresh-boot
pre-install (marquee) policy deliberately NOT done — held for the user
decision.
