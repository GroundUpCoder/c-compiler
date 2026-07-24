# win32 Lane C — explicit desktop eligibility (design §5)

Lane C of the win32 source-lib stream (design: the external embedder's
win32-sourcelib-design.md §5/§8): gucman's Desktop-icon planting switches
from the primary-command HEURISTIC (any installed package with a launchable
bin got an icon — CLI spam by construction) to an explicit **`desktop`
field** on the package def, copied into control.json by mkpkg. Eligibility
is data now, not an inference.

## Mechanism

- **Def/control field**: `"desktop": { "cmd": "<bin name>" }` — an object so
  it can grow (icon asset, label, …). Absent ⇒ desktop-ineligible, ever,
  regardless of the global toggle.
- **mkpkg** (tools/mkpkg.js): validates shape (object, `cmd` its only key
  today) and `cmd ∈ bin` at package-build time — a def whose desktop.cmd
  names no bin command fails the build loudly. Field copied into
  control.json only when present.
- **gucman** (os/gucman/gucman.c): the `primary[]` derivation is DELETED;
  the plant is `control.desktop && depth == 0 && desktop_shortcuts flag`.
  The cmd is re-checked against control.bin defensively (warning + skip,
  never an install failure — icon stays cosmetic). Icon shape unchanged:
  `/root/Desktop/<name> → /usr/local/bin/<cmd>`, recorded in db_desktop,
  removed by uninstall's reverse replay.
- **Storefront**: untouched — software.c only owns the toggle UI; listing
  is unchanged (installed ≠ desktop presence).

## Per-def enumeration (all 20 — the watch-item)

GAIN `desktop` (windowed GUI apps; icon preserved):

| def | cmd | confirmation |
|---|---|---|
| punes | punes | SDL NES emulator window ("puNES") |
| quake | quake | engine window; launcher script cd's to pkg dir |
| winmine | winmine | win32 veneer GUI |
| mgba | mgba | SDL GBA emulator window |
| sent | **slides** | ⚠ deviation: bare `sent` reads stdin (useless from an icon); `slides` presents the bundled demo deck — matches its menu entry |
| cairodemo | cairodemo | windowed vector scenes (test_cairo_e2e waits on its window) |
| tinyrenderer-clang | **tinyrenderer-demo** | ⚠ deviation from "same as today": the demo launcher passes the packaged model; bare binary defaults to an overlay path a gucman install lacks — matches its menu entry |
| imgui-clang | imgui-clang | windowed ("cc2wasm Dear ImGui") |
| doom-clang | doom-clang | windowed DOOM |
| box2d-clang | box2d-clang | ⚠ deviation from the §5 list (which called it a header lib): it's the windowed "Box2D (clang)" sandbox — test_clang_pkgs_e2e waits on its window |
| glm-clang | glm-clang | ⚠ deviation, same reason: windowed "GLM (clang)" spinning cube |

LOSE their (heuristic) icon — bin-bearing CLI tools / batteries, the
behavior this lane deletes: jq, lua, micropython, sqlite3, ninja-clang,
**etl-clang** (⚠ the §5 list had it losing via "header lib"; really it's a
tty conformance battery whose menu entry is a term wrapper — same verdict,
different reason). No `desktop` field added.

Never had an icon (no bin) — no change: font-noto-cjk-mono, font-unifont,
win32 (srclib-only, stays ineligible per §5).

## Image bump v156 → v157 — byte-identity proof

gucman.c is baked as /usr/bin/gucman, so the blob moves. Proof
(file-level BlockFS diff over `--packages=all` bakes; control worktree at
d5e438f):

- control vs control (same tree, two bakes): ONLY /usr/opt/quake/quake-bin,
  8 bytes — the known `__TIME__`/`__DATE__` noise (post-0249 bakes are
  otherwise deterministic).
- control vs lane: exactly `/usr/bin/gucman` (the heuristic deletion,
  134682→134743 bytes), `/usr/share/os-release` (1 byte — the VERSION_ID
  digit), + the same 8-byte quake noise. ZERO other files — package-def
  `desktop` lines don't reach the bake (control.json rides only in the
  tarballs; foldPackages reads bin/menu/openwith/srclib).

## Tests

test_gucman_e2e.js grew: mkpkg negative check (bad desktop.cmd ⇒ build
fails naming the cause), session C jq legs (toggle ON + field-less
bin-bearing package ⇒ NO /root/Desktop/jq — the heuristic's grave),
session D win32 leg (toggle ON + no bin/no field ⇒ no icon). Existing
punes legs already prove eligible-plants + remove-unplants unchanged.

## Gotchas

- The e2e's negative mkpkg check writes a temp def into packages/ (mkpkg
  has no packages-dir seam) and removes it in finally — it must run AFTER
  ensurePackages so the shared repo build never sees it.
- A file-level image differ must pass `count` to BlockFS.read(fd, buf,
  count) — omitting it reads 0 bytes and every file compares "equal"
  (vacuous PASS). Self-check a differ against a known-different pair first.
