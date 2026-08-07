# #518 — packages: an honest explicit `minBase` (lane-518)

## The Finding on the decisive ABI question (HIGH confidence — measured, not reasoned)

**The kickoff's "condition under which I am wrong" is TRUE for every code-bearing
package, and the ticket's premise is therefore about half wrong.** A payload that
carries compiled code has a real link-time ABI dependency on the base platform,
mkpkg's current-version default is CORRECT BY CONSTRUCTION for it, and its
`minBase` is NOT free to be lowered. The ticket's premise survives intact only
for pure-data payloads, which now declare their (stable, measured) floors.

The measurement chain:

1. **Payloads are compiled by the exact bake pipeline** (`tools/mkpkg.js:35-39`:
   "assembled by the EXACT bake pipeline … byte-identical to the same entry
   baked into the system blob"). So every index build re-compiles (or reuses a
   fresh build of) each binary against TODAY's compiler + libc + host env
   surface.
2. **A wasm binary's env imports resolve against host.js at spawn, and a
   missing name is a hard LinkError.** In-tree statement at `host.js:12633-12639`
   (the wasip1 shim: "On an embedder whose host.js predates this shim,
   instantiation LinkErrors naming module and symbol") and the served/absent
   split at `host.js:4873-4878`.
3. **Measured on the flagship:** today's `doom` payload (extracted from the
   built index, `build/repro-518-doom-imports.txt`) declares 113 imports;
   three of them do not exist in host.js at image v133:
   `__clip_has` (landed b1d3f59b, image v167), `__mkdir_impl` (37f13598,
   v186), `__getentropy` (c0978991, **v187**). Positive control: `__exit`
   present in the v133 host. So today's doom payload **LinkErrors on any base
   older than v187** — its import-name floor sits within 57 versions of
   current after only ~10 days of platform history.
4. **The floor MOVES.** Every libc/env growth that the app's code path touches
   raises the true floor of the NEXT payload build. A hand-declared static
   number on a code-bearing package is guaranteed to rot, and it rots in the
   dangerous direction: too low ⇒ the disabled-Install guard opens ⇒ the user
   gets a LinkError at spawn instead of a greyed card. The current default can
   only ever err in the SAFE direction (a working package refused). Per the
   API-honesty frame this is the only defensible default for compiled
   payloads.

Why the base VERSION_ID is a valid proxy for the whole platform: the baked
blob, host.js, and kernel.js ship together in one deploy; gucman gates against
os-release `VERSION_ID` (`os/gucman/gucman.c:951-957`), which identifies that
deploy.

**Where the ticket's premise survives:** a payload with NO compiled code (font
files, seeded HTML pages) has zero link surface. Its only coupling is the
gucman control-key mechanism that plants it — and that floor is *stable*: it
was fixed the day the key shipped and does not move when the platform grows.
Old gucman **silently ignores** unknown control keys (`cJSON_GetObjectItemCaseSensitive`
→ NULL → section skipped), so an under-declared floor there means a zombie
install (package "installs", fallback font never takes effect) — the floor
must be the key's first-SHIPPED image version, and I verified the payload
handshake itself (top-level `control.json` + `opt/<name>/` members +
sha256-before-extract + `tar+gzip` format string) is unchanged since v133.

## What changed

- `packages/font-noto-cjk-mono.json`, `packages/font-unifont.json`:
  `minBase: 133`. The `fonts` control key, the gdi32/term fallback chain that
  consumes `/etc/fonts/fallback`, and these two exact packages all landed and
  shipped in ONE commit (0d31e175, "image v133" — the bump is in the commit),
  so v133 is the oldest base these packages *demonstrably* work against.
- `packages/netsurf-demos.json`: `minBase: 169`. The `seed` content-resource
  kind landed at 7ad413d6 (image.json still read 168, no bump there); the
  first bump after it is 36e7d29a "image v169 — the gucman `seed` content
  resource kind", so v169 is the first base that shipped the engine; the
  engine was not modified before the package itself shipped at v170
  (`git log 36e7d29a..847dc057 -- os/gucman/gucman.c` is empty). The
  `netsurf` dep carries its own gate: gucman's minBase check runs per index
  entry inside the recursive dep install (`gucman.c:925-965`), so an old base
  refuses the dep LOUDLY ("needs base vN — upgrade the OS first") rather than
  pulling an incompatible netsurf. `minBase` describes the package↔base
  relation; the dep chain is gated separately, by design.
- `tools/mkpkg.js`: declared `minBase` is now shape-validated (integer in
  [0, current image version]; garbage used to `|0`-coerce into a silent wrong
  claim — `"133x"` → 133, `true` → 1). 0 stays legal: it is software.c's
  documented "ungated" sentinel (`os/win32/software.c:97`) and the
  synthesized `-sources` defs declare it (`os/os-common.js:957,:1006`).
  Header + entryFor comments now state the default's rationale so the next
  reader doesn't re-file this ticket.
- `tests/serve/test_mkpkg_minbase.js` (NEW, registered in
  `tests/host/run.js` — the set-equality guard refuses an unregistered file):
  declared-rides-verbatim (0 included — a truthiness regression would eat the
  sentinel), the default, all four refusal shapes, and a lint over the real
  `packages/`: a pure-data def (no project/c/nativeApp entry, no srclib
  section) MUST declare an explicit `minBase`, and every declared value must
  be an integer in [1, current]. Classifier carries red/green controls plus a
  non-empty-scan check so a misread directory cannot fake a clean pass.
- `tests/browser/os-minimal.mjs`: **re-cut, declared in advance here.** Its
  Deliverable-B leg pinned "netsurf-demos sits at minBase == base" — my
  change would have left the assertion green but VACUOUS (169 < 244 also
  renders `[available]`). The boundary role moves to `netsurf` — undeclared,
  sorted directly above netsurf-demos so both cards share the scrolled
  viewport (`wait label` needs a VISIBLE card; software.c renders
  card-granular from `g_scroll`). New coverage is strictly larger: the
  boundary card wait stays (on netsurf), a declared-floor card wait is added
  (netsurf-demos at 169 < base renders `[available]`), and two node-side
  precondition pins fail LOUDLY if either package's declaration ever changes
  (no silent vacuity in either direction).

## The 37-row adjudication table

Classes: **D** = declared (pure data, stable mechanism floor, measured);
**S** = undeclared, srclib source package; **W** = undeclared, wasm built by
our pipeline; **N** = undeclared, native-sibling artifact (`requires:
native-sibling:*`, absent from a base index anyway).

The named measurement for every S/W/N row is the same, and it was genuinely
attempted, on doom, before being stopped: the import-name floor is cheaply
measurable per payload (I measured doom's: ≥ v187), but proving a payload
*runs* on that base needs semantic compatibility too, and the only instrument
for that is booting historical images and running the app — the kickoff's
explicit weight-fence trigger ("needing to build or boot multiple historical
images"). And the number would be stale at the next payload rebuild anyway
(Finding pt. 4), so the archaeology buys a value that rots. Per-row deltas
noted where they exist.

| # | package | class | adjudication |
|---|---|---|---|
| 1 | box2d-clang | N | undeclared — clang-built wasm resolves against the current host env; floor moves with the sibling + platform |
| 2 | cairodemo | W | undeclared — our-pipeline wasm; class measurement |
| 3 | cpython-clang | N | undeclared — as box2d-clang |
| 4 | demos | W | undeclared — 8 binaries incl. gpubox (WebGPU surface) and the win32 demos; widest env surface in the set |
| 5 | doom-clang | N | undeclared — as box2d-clang |
| 6 | doom | W | undeclared — THE measured row: import-name floor ≥ v187 (`__getentropy`), semantic floor unmeasurable without historical boots |
| 7 | etl-clang | N | undeclared — as box2d-clang |
| 8 | font-noto-cjk-mono | **D 133** | fonts key + fallback chain + this package shipped together at v133; payload = ttf bytes (no link surface); handshake stable since v133 |
| 9 | font-unifont | **D 133** | same commit, same evidence |
| 10 | gameboy-clang | N | undeclared — as box2d-clang |
| 11 | gameboy | W | undeclared — class measurement |
| 12 | git | W | undeclared — curl veneer rides the HTTP OFD surface (recent env growth); floor certainly recent |
| 13 | glm-clang | N | undeclared — as box2d-clang |
| 14 | imgui-clang | N | undeclared — as box2d-clang |
| 15 | jq | W | undeclared — class measurement |
| 16 | libgit2 | S | undeclared — source compiled in-OS by the BASE's cc; floor = "oldest baked cc that compiles today's sources", unmeasurable without historical boots; failure mode on an old base is a loud compile error, not a zombie |
| 17 | libjpeg | S | undeclared — as libgit2 |
| 18 | libnsbmp | S | undeclared — as libgit2 |
| 19 | libnsgif | S | undeclared — as libgit2 |
| 20 | libpng | S | undeclared — as libgit2 |
| 21 | lua | W | undeclared — class measurement |
| 22 | mgba | W | undeclared — class measurement |
| 23 | micropython | W | undeclared — class measurement |
| 24 | netsurf-demos | **D 169** | seed kind first shipped v169 (engine unmodified through the package's own v170 ship); payload = pages (no link surface); dep `netsurf` gated recursively by gucman |
| 25 | netsurf | W | undeclared — class measurement (+ HTTP surface like git) |
| 26 | ninja-clang | N | undeclared — as box2d-clang |
| 27 | punes | W | undeclared — class measurement |
| 28 | quake | W | undeclared — class measurement |
| 29 | sameboy | W | undeclared — class measurement |
| 30 | sdldemo | N | undeclared — as box2d-clang |
| 31 | sent | W | undeclared — class measurement |
| 32 | sqlite3 | W | undeclared — class measurement |
| 33 | stl4 | N | undeclared — as box2d-clang (its `content` launcher is data, but the `nativeApp` binary decides the class) |
| 34 | tinyrenderer-clang | N | undeclared — as box2d-clang |
| 35 | wc-rust | N | undeclared — the DOCUMENTED LinkError case: imports `wasi_snapshot_preview1`, which a pre-0442 host does not serve at all (`host.js:12633-12639`) |
| 36 | win32 | S | undeclared — as libgit2; additionally its sources track the LIVE veneer (user32.c edits move the floor continuously) |
| 37 | winmine | W | undeclared — class measurement |

3 declared + 34 undeclared-with-named-measurement. No blanket value in either
direction; the boundary between the classes is the presence of anything the
base must compile or link.

## Testing evidence

- **Repro preserved BEFORE repair**: `build/repro-518-before.log` — the
  as-was index (isolated `--out`/`--pool` per 0388): all 26 base packages
  stamped `minBase=244`, the synthesized `-sources` set at 0, positive
  control `ALL_AT_BASE` computed over the full listing. Supporting artifacts:
  `build/repro-518-doom-imports.txt`, `build/repro-518-host-v133.js`,
  `build/repro-518-build.log`.
- **Deliberate breakage A** (the ticket's defect class regrows): deleted
  `minBase` from font-unifont.json → `test_mkpkg_minbase.js` FAILS
  ("pure-data package font-unifont declares an explicit minBase"), exit 1.
  Reverted; `git status` clean.
- **Deliberate breakage B** (mkpkg stops honoring declared values): replaced
  the entryFor ternary with the always-default arm → the test FAILS twice
  ("declared minBase rides into the index verbatim" and the 0-sentinel
  check), exit 1. Reverted; `git status` clean.
- Green run: all 23 checks + 4 refusal legs pass; the lint saw exactly the 3
  pure-data defs (non-vacuity check pinned).
- Committed assertions audited: `test_software_e2e.js:91` (`onBoundary.length
  > 0`) still holds — 23 base packages remain on the boundary.
  `test_source_packages.js:80/:177` (`minBase === 0` for the source set)
  untouched — the synthesized path is unchanged and the new validation
  deliberately admits 0. `os-minimal.mjs` re-cut declared above.
  `test_defaults_sync_e2e`/`os-gucman.mjs`/`test_mkpkg_rust` reference the
  three packages but assert nothing about their minBase (verified by grep).

## Instrument errors and confidence notes (mine)

- The kickoff's `:704` → `:710` drift: confirmed, re-measured; `:710` in this
  tree.
- **My first classifier was wrong**: `grep -cE '"(project|c|nativeApp)"'`
  reported libgit2/libjpeg/libpng/libns*/win32 as "code=0". They are
  code-CARRYING through `srclib` (in-OS compiled source). The committed lint
  classifier has the srclib axis; the error is preserved here because the
  same shortcut would misdeclare six packages as pure data.
- The v133 import comparison uses substring `.includes` on the old host.js —
  crude, but sound in the direction used (a name absent as a substring is
  certainly not an env key), and positively controlled (`__exit` found).
- MEDIUM confidence that 169 (not 170) is the exact netsurf-demos floor: the
  seed engine shipped at v169 and was unmodified through v170 when the
  package first shipped; I did not boot a v169 image. The value errs by at
  most one version, in the safe-enough direction that the engine demonstrably
  existed. If a v169 field report ever contradicts this, bump to 170.
- Bypass scan at the final tip: recorded in the lane report; the grep is
  positive-controlled against a synthetic `process.env` line before trusting
  its empty result.
