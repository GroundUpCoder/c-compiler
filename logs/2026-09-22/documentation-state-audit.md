# Repository documentation state audit

User-requested documentation audit against source at `ffea2c32`, after building
and launching native Doom. No implementation changes. Gamedev relevance:
accurate compile/run, asset, backend, and in-OS development instructions are
part of the developer loop; incorrect examples obstruct that loop directly.

## Scope and findings

Inspected the compiler CLI/project expansion/output packagers and GC parser,
standalone runtime/backend selection, native build/docs/tests, kernel socket
boundary, OS manifest and boot/server paths, package and vendor inventories,
test registry and prerequisite resolvers, and canonical architecture/policy docs.
A local Markdown-link scan covered 114 tracked files outside `old/`, engineering
logs, and `docs/archive/`, including vendored documentation. This was a repository
state/documentation audit, not an exhaustive code review or full regression gate.

| Area | Finding and disposition |
|---|---|
| README structure | The front page mixed an obsolete overview with a long GC reference and historical bootstrap narrative. Reorganized around quick start, execution environments, supported scope, projects/options, gucOS, repository map, and tests. Detailed GC documentation already exists in `docs/WASM_GC.md`; link to that canonical reference instead of maintaining a conflicting second copy. |
| Language/GC | README said bare GC structs and dot access were allowed and showed reference-form intrinsic type arguments. Current parser rejects these. Replaced with a verified example and the heap/ref distinction; stated the compiler's explicit C feature boundaries. |
| SDL/GPU | README still called the API SDL2. Distinguish SDL3 subset, native SDL3/wgpu-native, browser GPU, and gucOS's optional npm Dawn tier. Corrected WebGPU architecture text that denied the C veneer and described direct struct-layout marshalling/callback calls. Runtime ABI module is `c`. |
| Assets | README documented assets as HTML-only. Both `.js` and `.html` embed them; raw `.wasm` does not. Added Doom's explicit WAD argument, bundled-JS behavior, and temporary working-directory/save lifetime. |
| gucOS | Removed stale applet counts and the first-boot-only/no-build description. Describe actual image preparation, desktop, packages, persistent volumes, worker processes, browser requirements, and separate headless behavior. Manifest owns membership, rather than a mirrored app list. |
| CLI/tests | Added debug/source-link options and unsupported GCC-style flags; separate host compiler from the narrower in-OS frontend. Replaced the short obsolete category list with the dispatcher, Python pin, browser setup, optional native tiers, and scope of full/smoke/diff. |
| History | Frozen C++ equivalence and self-hosting results were presented as current guarantees, including nonexistent script paths. Removed the runnable bootstrap claim from README and labeled the QuickJS record; fixed its broken local link. Node matrix totals are explicitly historical. |
| Networking | Top of guide called curl unfinished despite its manifest entry and the guide's own later completion record. Tier 1 prose read as implemented, but `socket()` rejects non-AF_UNIX domains. Corrected status using the existing #3/#7 design references, without changing the backlog. |
| Design status | Added documentation authority map, marked the OS phase plan historical, refreshed SDL/WebGPU entry points, and removed GAMEDEV-EPIC's contradictory future-primacy wording. |

The imported `vendor/netsurf/netsurf/README.md` still links to an omitted upstream
`docs/quick-start.md`. Left upstream text intact; this repository's port guide is
`vendor/netsurf/README.md`. No other missing relative Markdown link targets were
found in the scan. This check does not validate external URLs, inline-code paths,
or every historical assertion inside design documents.

The canonical rules and liability register were read. `cc-meta` is not available
on this session's PATH and no ticket connector is exposed, so live ticket status
was not verified or mutated. This pass implements the user's direct request and
does not assert ticket closure or deployment state. Archived records and
third-party source implementations were preserved.

## Validation on Node 25.6.0 / macOS arm64

- Compiled `vendor/hello/main.c` to Wasm, JS, and HTML; Wasm and JS printed
  `Hello world` and exited 0.
- Compiled and ran the README GC example: `3 20`, exit 0.
- Compiled and ran Lua (`print(1 + 2)`): `3`, exit 0.
- Compiled and ran QuickJS (`console.log(1 + 1)`): `2`, exit 0. This is direct
  eval only, not validation of the archived self-host bootstrap.
- Built a temporary project with `dataFiles` and `runArgs`: generated JS read
  the bundled asset and received `embedded-arg`; HTML generation succeeded.
- Served generated hello HTML with `serve.js` in single-file mode on an
  ephemeral port: HTTP 200, COOP `same-origin`, COEP `require-corp`. Server
  terminated afterward. No browser rendering/OS boot sweep was run.
- `node tests/host/test_native_optional.js`: passed relocated console,
  unavailable/broken-addon behavior, and explicit backend-selection checks.
- Compiled `tests/native/fixtures/gpu-compute.c`, ran with `--sdl=native`:
  1,024 values transformed and read back, sum 1,048,576, all verified, exit 0.
- Earlier Doom launch reached graphics/game initialization with its WAD, but
  reported audio-device initialization failure. This audit does not certify
  audible native playback or resolve that runtime observation.
- `git diff --check`: clean. `node tests/run.js --diff --dry-run` selects no
  suites for these documentation changes. No full gate or deploy performed.

All scratch programs and outputs are under ignored `build/doc-audit/`.
