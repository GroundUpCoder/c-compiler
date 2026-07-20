# T1 C++ ladder: box2d-clang + imgui-clang as optional gucman packages

Tier 1 of `todos/CPP-LADDER-PROPOSAL.md` (the "cheapest possible Tier-1 win":
promote the already-proven Box2D + Dear ImGui from the clang-simplified
sibling to shippable gucOS apps) is **green end-to-end**, riding the
CLANG-CPP-EPIC Part II `*-clang` channel that landed in parallel (001a80a) —
this work is its first real consumer beyond doom-clang.

## What shipped (this repo, branch t1-ladder)

- `packages/box2d-clang.json` + `packages/imgui-clang.json` — the Part II §7
  schema verbatim (`requires:"clang-sibling"`, one `clangApp` entry each,
  Demos menu). Base purity holds by construction: plain `mkpkg` yields a
  12-package index with zero `-clang` names and orphan-prunes the pool;
  `mkpkg --clang --clang-root=…` builds the 15-package superset,
  sha256-verified against the sibling's `out-image/overlay.json`.
- `tests/kernel/test_clang_pkgs_e2e.js` (registered in tests/kernel/run.js) —
  15/15: in-OS base purity (zero `*-clang` in /usr/bin of the minimal image),
  both cards on the `--clang` superset catalog, gucman install (opt tree +
  /usr/local/bin symlinks + /etc/menu/Demos entries), both apps LAUNCH under
  headless boot (windows "Box2D (clang)" / "cc2wasm Dear ImGui"), the ImGui
  Process Inspector reads the REAL /proc (`proc scan pids=N`, N>0 — the leg
  the sibling harness can't run), clean removes. SKIPs (exit 0) without the
  sibling's published overlay — the base estate never hard-requires it.

## Sibling side (clang-simplified, branch t1-clang-apps)

- Box2D: `box2d_app.cpp` interactive `--sdl` sandbox (mouse-spawn/drag via a
  real b2MouseJoint) over a shared `box2d_scene.h` sim core whose scripted
  scenario also builds natively → `run-box2d-app-test.sh` 4/4: wasm-vs-native
  max |Δ| 3.41e-4 (eps 1e-3, 240 frames incl. the drag), committed golden,
  SDL front-end checkpoint bit-exact vs the pure driver, "c"-only imports.
- ImGui: `imgui_app.cpp` grew a Process Inspector window (/proc table +
  uptime/meminfo; honest degrade off-OS) → `run-imgui-app-test.sh` 7/7 +
  the existing browser check still green.
- Overlay: both published via mk-overlay (box2d-clang 140 KB, imgui-clang
  926 KB), `run-overlay-test.sh` 8/8.

## Surfaced to master

- **sameboy-clang is unbuildable and was removed from the sibling manifest**:
  vendor/sameboy became a win32 app in 0260 (main.c includes windows.h);
  cc2wasm has no win32 veneer, and one failing project hard-fails the whole
  overlay publish. Documented in run-overlay-test.sh beside the mgba-clang
  note. Options if it should return: cc2wasm win32 veneer (big) or an
  upstream-SDL SameBoy build in the sibling.
- dist/packages mode thrash (plain vs `--clang` supersets) behaves exactly as
  Part II §7 accepted — the gucman e2es re-prune and stay green.

Gates: kernel 100/100, host suite green, serve clang guardrails 3/3.
T1 ratchet: both picks build (pristine vendor + from-scratch front-ends), run
deterministically under harnesses, and ship as optional gucOS apps.
