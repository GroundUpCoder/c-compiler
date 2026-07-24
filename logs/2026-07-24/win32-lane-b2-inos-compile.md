# win32 Lane B2 — win32 apps compile in-OS (require blocks + physical TU paths)

Lane B2 of the win32 source-lib stream (design: the source-lib design pass
§4.1–4.4; Lane A = compiler FS resolution @0358ec7, Lane B1 = srclib
packages @56ed229). The payoff lane: `cc hellowin.c` with
`#include <windows.h>` inside the OS pulls the whole veneer + freetype and
produces a runnable, wmctl-drivable win32 app.

## What landed

- **Require blocks (§4.1/§4.2)**: `os/win32/include/windows.h` ends with the
  11 `__require_source("win32/<tu>.c")` lines (lib.json ∪ menucore.json);
  `os/win32/gdi32.c` ends with the 12 `freetype/<shim>.c` requires (vendor
  knowledge stays with its consumer); `os/win32/menucore.h` carries its own
  2-line block (menucore.c + gdi32.c — the engine-only link set).
  `srcRoots` declared in os/win32/lib.json + menucore.json (`{win32: .}`)
  and vendor/freetype/lib.json (`{freetype: srclib}`) so every host project
  build resolves the names to its explicitly-listed TUs and the Lane-A
  path-identity dedup no-ops them.
- **Physical TU paths (the B1 `..`-is-lexical finding, option (a))**:
  `PPRegistry.realpath` — an optional embedder hook; when set,
  `parseAllUnits` canonicalizes EVERY TU path (input files and FS-resolved
  requires) through it and compiles the TU under its PHYSICAL path.
  `createCcDriver` wires it to `kfs.realpathPhysical` (todos/0263 — exists
  on BlockFS/MountFS/RemoteFS alike). So a require resolved at the visible
  tier (`/usr/src/win32/gdi32.c`, a symlink-farm entry) compiles as
  `/usr/opt/win32/src/win32/gdi32.c`, and its `"../fontcore.h"` — lexically
  hopeless through the symlink — resolves inside the payload's real tree
  where lexical == physical. Hook absent (every host build) → paths pass
  through untouched, byte-identical. This deliberately revives what design
  §7 rejected — the rejection was premised on §1.5's physical-walk claim,
  which B1 refuted.
- **§4.4 drift gate**: `os-common win32RequireDriftErrors` is the ONE
  checker (windows.h == lib.json ∪ menucore.json; menucore.h ==
  menucore.json; gdi32.c == freetype lib.json — set equality both ways,
  loud per-name messages). mkpkg refuses to build the win32 package on
  drift; tools/win32ports.js runs it first in both modes (`--check` runs in
  the kernel suite — the CI tripwire). win32ports.js's tool-local project
  expansion also grew the srcRoots plumbing (buildProject twin) so the
  corpus compiles the require-bearing header.
- **Payload closure (packages/win32.json)**: the veneer TUs pull 8 more os/
  headers via `../` includes that B1's payload lacked — fontchain.h,
  wcwidth.h (fontcore.h), fileops.h (shell32), sounds.h + cfgstore.h
  (winmm), keys.h, wm_agent.h (user32), listdir.h (comdlg32) — now planted
  at `src/` beside fontcore.h.
- **Docs**: PORTS.md (generated header) documents the in-OS build path:
  `cc app.c`; `cc -DUNICODE app.c /usr/src/win32/wwinmain.c` for wWinMain
  apps; `gucman install win32` on a minimal image; `.res` sidecars stay
  host-only.
- **Image v155 → v156** (the baked win32 SOURCE payload changed).

## FINDING — an unconditional require block breaks the subset link
## (WIN32_NO_REQUIRE_SOURCES, the veneer's WIN32_LEAN_AND_MEAN)

The design said "wm.c is untouched (never includes windows.h)" — false at
the include-chain level: menucore.h and win32_internal.h both include
windows.h for declarations, and gdi32.c includes it directly. With an
unconditional block, /bin/wm and /bin/term (menucore.json subset links)
pulled the ENTIRE veneer — +122 KB each, silently (the veneer self-links;
tree-shake keeps agent/table roots). windows.h is a monolith (windef.h/
wingdi.h are shims back into it), so a types-only header split was out of
scope. The fix is a suppression guard, real-Windows style:

- `WIN32_NO_REQUIRE_SOURCES` around the §4.1 block in windows.h.
- Defined (ifndef-guarded) before the windows.h include by the subset API
  header (menucore.h) and by the veneer-internal TUs' entry points
  (win32_internal.h, and gdi32.c's own direct include) — an INTERNAL TU
  must never be the one that decides the link set.
- Model (verified in compiler.js): macro and pragma-once state are PER-TU
  (`processSource` resets `pp.onceGuards`); required-source NAMES dedup
  per-compile. So the block fires from the first TU whose windows.h
  inclusion sees the guard undefined — exactly the app TU (in-OS input TUs
  compile before required TUs; host builds dedup regardless). Pitfall,
  documented in the header: a TU wanting the full veneer must include
  <windows.h> BEFORE any subset header — getting it wrong is a loud
  undefined-symbol link error.

The e2e pins both directions: an engine-only app (`cc -I/usr/src/win32`,
`#include <menucore.h>`) links menucore + gdi32 + freetype and a user32
reference is a LOUD link failure; a windows.h app gets everything.

## The byte-identity gate — PASSED (file-level)

B2's intended delta changes the baked payload (source text + 8 new
headers), so a raw byte-diff shifts allocation and is unreadable; the gate
ran FILE-LEVEL instead (mount control vs lane image via BlockFS read-only,
walk, compare every file — harness /tmp/b2-imgdiff.js, not committed):

- Same-tree control (two `--packages=all` bakes @56ed229): 37 raw bytes =
  seal hash + 6 quake `__TIME__` digit bytes (the B1 profile).
- Control vs B2 bake: only-in-B2 = the 8 new payload headers; differing =
  the 4 intended source files (windows.h, gdi32.c, menucore.h,
  win32_internal.h), `/usr/share/os-release` (1 byte — the version digit),
  and `/usr/opt/quake/quake-bin` (8 bytes — the known `__TIME__`/`__DATE__`
  noise). **Zero app wasm modules differ** — /bin/wm and /bin/term were the
  regression the guard fixed, verified byte-identical host-side
  (`node compiler.js os/wm.json` control vs lane) and in the image.

## Notes / gotchas

- `wmctl tree`'s per-app header is `== pid N` — drive.js `section()` reads
  it as a section terminator; assert tree lines (`class=`/`text='…'`) on
  the full output instead.
- A win32 app's kernel window exists at CreateWindowEx but the agent
  socket binds inside CreateWindowEx slightly later — `wmctl wait label`
  (the agent-tree wait) before `wmctl tree`, not just `wait win`.
- In-OS compile speed is a non-issue: the full veneer + freetype pull is
  ~1.5 s in the kernel worker; the output (518 KB) matches the baked
  ctldemo (538 KB) — the whole library really is in there.
