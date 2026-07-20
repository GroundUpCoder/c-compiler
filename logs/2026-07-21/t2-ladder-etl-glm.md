# T2 C++ ladder (c-compiler side): etl-clang + glm-clang packages + e2e

Tier 2 of the C++ port ladder (`todos/CPP-LADDER-PROPOSAL.md` — templates
without the STL confounder) lands as two more optional `*-clang` gucman
packages on the CLANG-CPP-EPIC Part II channel. Sibling branch
`t2-clang-apps` carries the ports/harnesses/overlay (dev log there:
`logs/2026-07-21/t2-clang-apps.md`); this repo's side is packaging + the
e2e, exactly the T1 pattern.

- **`packages/etl-clang.json`** — the ETL 20.48.1 template-conformance
  battery (45 TUs, 1984 UnitTest++ tests) as `/opt/etl-clang/etl-clang`.
  It is a tty app, so the package also plants `etl-tests`, a `#!/bin/sh`
  launcher that runs the battery under `term` and holds the window for the
  verdict — the Demos menu entry points at the launcher, not the raw
  binary (the sent.json `content`-entry precedent).
- **`packages/glm-clang.json`** — the GLM 1.0.1 spinning-cube demo
  (`--sdl`, window "GLM (clang)"), box2d-clang shape verbatim.
- **`tests/kernel/test_clang_pkgs_e2e.js`** grew from 15 to 24 checks: the
  two T2 installs/removes, the glm window launch leg, and the tier's
  centerpiece — the FULL ETL battery executed in-OS (`etl-clang` under
  hush on the brokered fs/tty) asserting `Success: N tests passed.` with
  N ≥ 1000. Base-purity and catalog checks now cover all four `*-clang`
  packages. Base image ships zero clang bytes, as before (plain mkpkg
  excludes `requires:"clang-sibling"` definitions by construction).

No image bump, no deploy — master reviews and sequences the channel. Tier
ratchet: T2 proven (build pristine/thin-patch + deterministic harnesses +
shipped as gucOS apps) → next rung T3 (Ninja + tinyrenderer).
