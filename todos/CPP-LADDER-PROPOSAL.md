# C++ port ladder — tiered candidate pick-list (PROPOSAL, awaiting selection)

Status: **proposal — nothing here is vendored or queued.** This doc grounds a
ladder of C++ projects to bring into gucOS as apps, ordered in TIERS of
increasing C++-ness, so each language level gets proven SMOOTHLY and FULLY by
several real consumers before we ratchet to the next. The user picks; picks
become queue items.

> **Progress (2026-07-20): TIER 1 GREEN — Box2D + Dear ImGui promoted.**
> Both ship as optional `*-clang` gucman packages (CLANG-CPP-EPIC Part II
> channel; base image stays clang-free): `box2d-clang` (interactive sandbox,
> mouse-spawn/drag over a real b2MouseJoint; shared-core scenario matches
> native within 3.4e-4 over 240 frames) and `imgui-clang` (demo + a Process
> Inspector reading the real /proc in-OS). Sibling branch `t1-clang-apps`
> (front-ends + harnesses + overlay), this repo's branch `t1-ladder`
> (package defs + `tests/kernel/test_clang_pkgs_e2e.js`, 15/15). Dev log:
> `logs/2026-07-20/t1-ladder-box2d-imgui.md`. Note: sameboy-clang left the
> sibling overlay (0260 made vendor/sameboy win32 — cc2wasm can't build it).
> Next rung on ratchet: Tier 2 (ETL + GLM).

> **Progress (2026-07-21): TIER 2 GREEN — ETL + GLM landed.** `etl-clang`
> is the ETL 20.48.1 unit-test suite as the tier's conformance battery —
> 45 TUs / **1984 UnitTest++ tests pass on wasm** (native clang++ 1983;
> the wasm run is a verified name-superset — the one extra test is
> upstream-gated off on Apple+clang only), run in-OS by the e2e; the menu
> launches it through a `term`-wrapper launcher. `glm-clang` is a `--sdl`
> spinning cube over GLM 1.0.1 — wasm bit-identical to native over 240
> frames (`run-glm-test.sh` 4/4). The battery drove the largest
> libcxx-mini growth since Stockfish (`<bit>`/`<compare>`/`<span>`, the
> f128 long-double runtime, C++-aware NULL at libc vendoring, container
> API tails — sibling dev log `logs/2026-07-21/t2-clang-apps.md`).
> `test_string_view` excluded by design (wide basic_string/basic_ostream
> stack is a rejected mini-STL refactor); known toolchain debt: no builtin
> `wchar_t` in cc2wasm C++ mode (one guarded ETL hash.h specialization).
> Sibling branch `t2-clang-apps`, this repo's branch `t2-ladder`
> (package defs + the extended `tests/kernel/test_clang_pkgs_e2e.js`).
> Next rung on ratchet: Tier 3 (Ninja + tinyrenderer).

> **Progress (2026-07-21): TIER 3 GREEN — Ninja + tinyrenderer landed.**
> `ninja-clang` is Ninja v1.12.1 with its subprocess layer riding gucOS
> posix_spawn UNPATCHED (upstream already speaks posix_spawn/file_actions/
> pipe/waitpid — 6 thin `__wasm__` patches elsewhere: setsigmask/pselect
> skips under the cooperative signal model, st_mtim, loadavg/nproc/truncate;
> 1 MiB stack for BuildLog's 256K on-stack buffer): **the killer leg runs —
> in-OS ninja spawns `/bin/sh -c "cc hello.c -o hello"`, the product runs,
> and a second invocation says "no work to do"** (incremental stat semantics
> on the brokered fs). Headless harness `run-ninja-test.sh` 13/13 (dry-run +
> `-t` tool suite vs a native ninja from the SAME sources). `tinyrenderer-
> clang` is ssloy's 2025 renderer PRISTINE (zero patches) as a `--sdl`
> spinning head + packaged model assets (the new mkpkg `nativeFile` entries);
> `run-tinyrenderer-test.sh` 7/7 with the 800x800 render **BIT-IDENTICAL
> wasm-vs-native** — the native leg needs `-ffp-contract=off` (default fma
> contraction, not a wasm bug, caused a 40%-of-pixels divergence), and the
> in-OS e2e re-verifies the checkpoint series byte-exact vs the sibling
> golden. Mini-STL growth: `<queue>`/`<stack>`, ofstream + `std::ios`,
> istream read/float-extraction/pushback-fix, string/vector swap +
> const-ref access, map `insert(P&&)` ambiguity fix, `mem_fn`,
> unordered_set emplace, il min/max/minmax. `test_clang_pkgs_e2e.js` 39/39
> over six packages; base stays clang-free (plain mkpkg indexes/pools zero
> `-clang`). Sibling landed on `main` (@1beacf2), this repo's branch
> `t3-ladder`. Dev logs: sibling `logs/2026-07-21/t3-clang-apps.md`, here
> `logs/2026-07-21/t3-ladder-ninja-tinyrenderer.md`.
> Next rung on ratchet: Tier 4 (jsonq — exceptions/RTTI at app scale).

---

## 1. Ground truth: what the toolchains compile TODAY

### compiler.js — no C++ at all

`compiler.js` is a C11 compiler. Every "C++" string in it is a comment about
matching clang behavior (e.g. `compiler.js:1234` "matches C++ readFile()
behavior", `:3122` "matching C++ which keys by Info* pointers") or the C
identifier `template_` in the libc (`mkstemp`, `:24224`). There is no C++
lexer/parser path. **All C++ compilation goes through the sibling toolchain.**

### ~/git/clang-simplified — the working C++-to-wasm path

A buildless amalgamation of **real Clang/LLVM 21.1.8** (clang + wasm-ld as one
argv0-dispatch ELF, `simple1/out/llvm`; WebAssembly backend only), built by
`./build.sh` from committed sources + pre-generated TableGen output
(`README.md`). `./cc2wasm input.(c|cpp)` compiles **`-std=c++20`** to a
`.wasm` that runs on c-compiler `host.js`, reusing the c-compiler's ISO C libc
(`cc2wasm` lines 200–214). Key facts from `cc2wasm` + `wasm/`:

- **STL is `wasm/libcxx-mini/` — our own header-only mini-STL, NOT upstream
  libc++** (`cc2wasm:212`). Present today: `vector string string_view map set
  unordered_map unordered_set deque list forward_list array bitset tuple
  optional variant memory functional algorithm numeric iterator chrono random
  valarray sstream iostream fstream iomanip thread mutex atomic
  condition_variable system_error stdexcept typeinfo type_traits limits ratio
  initializer_list` + the `c*` wrappers.
- **Absent headers** (growable — it's our STL): `queue`/`stack` (adapters),
  `span`, `ranges`, `regex`, `filesystem`, `format`, `charconv`, `compare`,
  `concepts` (library side), `any`, `future`, `complex`, `locale`/`codecvt`,
  `typeindex`, `expected`, `source_location`. nlohmann/json is compiled with
  these steered OFF via its own macros (`wasm/demos/json_demo.cpp:13–19`).
- **Exceptions: opt-in `--exceptions`** → `-fwasm-exceptions` (native wasm EH,
  engine-unwound, no JS trampoline) + the Itanium `__cxa_*` runtime
  (`wasm/compat/cxxabi_exception.cpp`, `cxxabi_personality.cpp`,
  `unwind_wasm.c`) (`cc2wasm:67–77, 300–304`). Default builds are
  `-fno-exceptions` (mini-STL misuse paths trap via `__fatal`).
- **RTTI: opt-in `--rtti`** → drops `-fno-rtti`, links the libc++abi
  type_info hierarchy + `__dynamic_cast` (`wasm/compat/cxxrti.cpp`)
  (`cc2wasm:60–66, 291–293`). `--exceptions` links the type_info hierarchy
  too (catch-by-type matches on it).
- **Graphics/audio: opt-in `--sdl`** (host `__sdl_*` bindings — the same SDL
  subset gucOS apps use) and `--webgpu`; frame loop is the callback model
  (`__setAnimationFrameFunc`), no JSPI (`cc2wasm:36–41`;
  `wasm/demos/imgui_app.cpp` header).
- **Threads are fake:** mini-STL `std::thread` runs its callable **inline in
  the constructor** — persistent-worker designs deadlock and must be patched
  to synchronous, as Stockfish was
  (`wasm/vendor/stockfish/CC2WASM.md`, thread.cpp patch).
- Global ctors work; argc/argv works; `--data HOST:GUEST` bundles assets;
  `-Wl,-z,stack-size=` raises the 64 KB default wasm stack (Bullet needs 8 MB,
  `wasm/demos/bullet_demo.cpp:29`; Box2D heap-allocates its world for the same
  reason, `box2d_demo.cpp:41–44`).

### Already PROVEN through cc2wasm (each with a harness in `wasm/tools/`)

| Consumer | C++ surface it proved | Harness |
|---|---|---|
| `cpp_features.cpp`, `stl_features{,2..5}.cpp` | language + mini-STL feature sweeps | `run-libc-test.sh` set (34/34) |
| **Dear ImGui** (vendored, `wasm/vendor/imgui`) | real C++ app, own containers, `--sdl`, guest-side triangle clipping | `imgui-browser-check.mjs` |
| **Box2D 2.4** (vendored) | C-with-classes physics; only `<new>` from the STL; deterministic vs native | `run-box2d-test.sh` |
| **Bullet 3** (vendored) | mid-size 3D C++; templates-light; f64 determinism vs native | `run-bullet-test.sh` |
| **LaiNES** NES emulator (vendored) | C++11 core + our SDL front-end (`nes_app.cpp`) | `run-nes-test.sh` |
| **nlohmann/json** (vendored, pristine) | heavy SFINAE/constexpr TMP, `--exceptions` | `run-json-test.sh` |
| **Stockfish 11** (vendored, pristine + 3-file patch) | serious modern C++, full `<iostream>/<iomanip>/<sstream>/<bitset>/<fstream>` — it *drove* that mini-STL growth; single-thread patch | `run-stockfish-test.sh` |
| RTTI / exceptions / exception_ptr demos | `dynamic_cast`, `typeid`, throw/catch, `std::exception_ptr` | `run-rtti-test.sh`, `run-exceptions-test.sh`, `run-exception-ptr-test.sh` |

The sibling's own retired ladder was: 0053 json → 0054 Stockfish → 0055 Bullet
→ 0056 Godot (**deferred indefinitely** — "god-tier ceiling") → 0057 Chromium
(the joke rung).

### The gucOS delivery path exists

`os/os-common.js:353+` (todos/0118): **`overlay@1`** manifests fold
sibling-published, prebuilt cc2wasm binaries into the system image at bake
time — this repo is consumer-only (verifies hashes, plants bytes, records
provenance at `/usr/share/overlays/<id>.json`; never runs cc2wasm). Sibling
side: `wasm/tools/mk-overlay.mjs`, `run-overlay-test.sh`, `run-os-cc2wasm.sh`;
serve.js overlay support landed as todos/0141. gucman packages (`tools/
mkpkg.js`) are the second route for optional apps. So a chosen C++ port means:
vendor + front-end in clang-simplified, publish overlay/package, bake — zero
compiler.js work.

### gucOS constraints every candidate is judged against

- **No raw sockets.** Network = HTTP-only via the host-brokered curl veneer
  (gucman's path). Anything wanting `socket(2)` is out or needs its net layer
  cut.
- **Single-threaded** (see std::thread above). Thread pools → synchronous
  patches.
- **UI**: tty apps run under `/bin/term` (ANSI escapes fine; **no ncurses in
  the libc** — a mini-curses is enabling work, flagged below), GUI apps use
  the `--sdl` subset (windows, textures, `SDL_RenderGeometry`, audio) or
  webgpu.h.
- **No mmap of files** (Stockfish's Syzygy prober was stubbed for this),
  wasm32 ILP32, 64 KB default stack (raisable at link).
- **License**: permissive preferred; GPL has precedent (doom, quake, busybox,
  Stockfish already vendored).

---

## 2. THE LADDER

Rules of the game: each tier lists MANY candidates. Selection means picking
~2–4 per tier; a tier is "proven" when its picks build pristine-or-thin-patch,
run deterministically under a harness, and ship as gucOS apps. Sizes are rough
(sloc of the part we'd build). "Difficulty" is against cc2wasm + mini-STL +
gucOS constraints, not generic porting effort.

### Tier 1 — barely-C++ / C-with-classes
*(classes, methods, ctors/dtors, references, new/delete; no templates/STL/
exceptions. Proves: name mangling, vtables, ctor ordering, operator
new/delete glue — at scale.)*

Already proven here: **Box2D** (only `<new>`), **Dear ImGui** (own ImVector
containers, exceptions-free). Both are vendored in the sibling but NOT yet
gucOS apps — promoting them is the cheapest possible Tier-1 win.

| Candidate | What / size | C++ it exercises | Difficulty | Why in gucOS |
|---|---|---|---|---|
| **Box2D sandbox** (erincatto/box2d 2.4, MIT — already vendored) | 2D physics engine, ~15 kloc | classes, virtual dispatch, placement new; zero STL | **Low** — engine proven; write a small `--sdl` front-end (mouse-spawn boxes, drag) like `nes_app.cpp` | First interactive physics toy; the canonical Tier-1 flagship |
| **Dear ImGui tool** (ocornut/imgui, MIT — already vendored) | immediate-mode GUI, ~60 kloc | C-with-classes + light templates (ImVector); no STL/exceptions | **Low** — `imgui_app.cpp` already is the integration; wrap the demo + a real tool (e.g. a wm/proc inspector reading /proc) as a window | A native-feeling tools substrate; every later GUI port can lean on it |
| **Abuse** (abuse-sdl, ~1995 Crack dot Com game, GPL/public-domain mix) | side-scrolling run-and-gun with Lisp scripting, ~50 kloc | vintage C-with-classes, own containers, zero STL | **Medium** — old SDL1→our subset, asset files (freeware data released) | A real commercial-era game; strong retro fit next to doom/quake |
| **NXEngine-evo** (Cave Story reimpl., GPL3) | platformer engine, ~40 kloc | C-style C++, minimal STL (a few vectors — trims to Tier 1) | **Medium** — SDL2 → our subset; freeware data files | Beloved game, tty-free, fixed-res (scales via 0024) |
| **OpenJazz** (Jazz Jackrabbit engine, GPL2) | platformer engine, ~30 kloc | classes + inheritance, own lists, near-zero STL | **Medium** — SDL; needs shareware data | Another DOS-era icon; small enough to be a weekend rung |
| **fallout1/2-ce** (MIT/Sustainable-Use — check per repo) | Fallout engine reimpl., ~150 kloc | decompiled C-style C++, almost no STL | **High** (size; needs retail data — weakest data story) | Stretch pick only; listed for completeness |
| **7-Zip / LZMA SDK core + `7za`-style CLI** (Igor Pavlov, LGPL+public-domain parts) | archiver, ~40 kloc used | COM-style interfaces, own CObjectVector — deliberately STL-free | **Medium** — kill threads (single-thread mode exists); CLI only | Real utility: `.7z`/`.xz` in-OS, complements busybox tar/gzip |
| **Doom 3 / idTech4 idLib only** (GPL3) | just idLib containers/math, not the game | idStr/idList: industrial C-with-classes, no STL | **Low-Medium** as a *library stressor* + unit demo, not an app | Pure compiler workout at scale; no shippable app — pick only as a stressor |

### Tier 2 — templates (function/class templates, no STL dependence)
*(Proves: instantiation at scale, template linkage/COMDAT-equivalent, member
templates, partial specialization — without the STL confounder.)*

Real-world "templates but no STL" code clusters in embedded and math libs.

| Candidate | What / size | C++ it exercises | Difficulty | Why in gucOS |
|---|---|---|---|---|
| **ETL — Embedded Template Library** (jwellbelove/etl, MIT) | fixed-capacity STL-alike (no heap), ~big header set + huge unit-test suite | class/function templates, traits, CRTP — explicitly no-exceptions/no-RTTI/no-heap mode | **Low** — header-only; its test suite is a ready-made conformance battery | The *perfect* Tier-2 gate: hundreds of template tests as a pass/fail suite app |
| **GLM** (g-truc/glm, MIT) | OpenGL math, header-only | templated vec/mat/quaternion, swizzles, specializations | **Low** — header-only; demo prints transforms, or feeds a `--sdl` spinning-cube rasterizer | Math substrate later GPU/game ports will reuse |
| **linalg.h** (sgorsten/linalg, public domain) | single-header vector math, ~1 file | terse template metafunctions, operator templates | **Trivial** | Smallest possible Tier-2 smoke; good first commit |
| **doctest** (doctest/doctest, MIT) | single-header test framework | templates + macros, expression decomposition | **Low** — self-test binary as the app | Gives every later port an in-OS unit-test runner (`/bin/doctest-demo`) |
| **Peanut-GB-style single-header emu cores in C++** e.g. **chip8-cpp cores** | tiny emulators | templated bus/opcode dispatch | **Trivial-Low** — `--sdl` front-end reuses nes_app patterns | Cheap fun; another window on the desktop |
| **fpm** (MikeLankamp/fpm, MIT) | fixed-point math, header-only | class templates + numeric-limits specializations | **Trivial** | Useful for later ports on wasm32 (no-FPU-style determinism) |
| **Squirrel** (albertodemichelis/squirrel, MIT) | scripting language, ~15 kloc | templated allocator hooks + classes; exceptions optional (has jmp fallback) | **Medium** — REPL over tty; sits Tier 2–3 boundary | A scripting REPL app (`/bin/sq`) alongside lua/micropython |

### Tier 3 — STL containers (vector/map/string, iterators, algorithms)
*(Proves: mini-STL is a drop-in for real consumers — allocator traffic,
iterator invalidation patterns, string_view plumbing, algorithm coverage.
Known gap to grow on demand: `queue`/`stack` adapters — trivial over the
existing `deque`.)*

| Candidate | What / size | C++ it exercises | Difficulty | Why in gucOS |
|---|---|---|---|---|
| **tinyraytracer** (ssloy, "do what you want") | ~300-line ray tracer | `std::vector`, `<fstream>` PPM out, `<limits>`, lambdas | **Trivial** — file out today, or blit to `--sdl` | Instant-gratification demo; Demos-menu material |
| **tinyrenderer** (ssloy, MIT) | ~1 kloc software rasterizer (the "how GL works" course) | vector/string, matrices, model loading | **Low** — TGA→SDL texture blit | Software-rendered 3D head on the desktop; teaching artifact |
| **Ninja** (ninja-build/ninja, Apache-2.0) | the build tool, ~25 kloc | restrained STL (vector/map/string), `-fno-exceptions` by design — Tier-3 exactly | **Medium** — subprocess layer → gucOS `posix_spawn`/`__spawn`; kill ppoll/threads | **Killer app**: `ninja` driving in-OS `cc` = real builds inside gucOS |
| **re2c** (re2c.org, public domain) | lexer generator CLI, ~30 kloc | STL containers/iterators throughout | **Low-Medium** — pure stdin/stdout/file CLI | Dev-tool synergy with in-OS cc; generates C we can then compile in-OS |
| **The Powder Toy** (GPL3) | falling-sand physics game, ~120 kloc | STL + own framework, some threads | **High** — size, threads to strip, SDL | Iconic; huge draw; stretch pick for the tier |
| **SpaceCadetPinball** (k4zmu2a decompilation; **license murky** — MS-decompiled) | 3D Pinball Space Cadet, ~25 kloc | light STL (vector), C-style classes | **Medium** — SDL2→subset; data from original game | *Perfect* Win95-aesthetic fit for gucOS; license needs a ruling first |
| **Stella** (stella-emu, GPL2) | Atari 2600 emulator, ~100 kloc core | C++17, STL, unique_ptr-heavy | **Medium-High** — big; SDL front-end rewrite like nes_app | Third emulator core; completes the console shelf |
| **micropolis** (SimCity classic, GPL3+trademark note) | city sim, ~50 kloc engine | STL moderate, C-style core | **High** — original UI was Tcl/Tk; needs a from-scratch SDL front-end | Deep sim for the desktop; big front-end investment |
| **Infra Arcana** (martin-tornqvist/infra-arcana, AGPL) | Lovecraft roguelike, ~60 kloc | modern-ish STL C++ | **Medium** — SDL tiles path exists | A serious roguelike without the curses problem |
| **bsdgames-era C++ rewrites / 2048.cpp / console tetris (various, MIT)** | tiny tty games | vector/string + ANSI escapes | **Trivial** | Filler wins; prove tty+STL path in an afternoon |

*Enabling work surfaced by this tier: `queue`/`stack` headers (trivial);
optionally a mini-curses over ANSI for the roguelike class (medium — unlocks
NetHack-class C ports too, but note Dungeon Crawl Stone Soup and
Cataclysm-DDA remain out of budget for now).*

### Tier 4 — exceptions + RTTI
*(Proves: `--exceptions`/`--rtti` at application scale — throw across deep
template stacks, exception-safe containers, `dynamic_cast` hierarchies.
Runtime exists and is demo-proven; no *application* exercises it yet.)*

| Candidate | What / size | C++ it exercises | Difficulty | Why in gucOS |
|---|---|---|---|---|
| **nlohmann/json CLI (`/bin/jsonq`)** (MIT — already vendored) | a small jq-like query/pretty-print tool we write over the proven header | exceptions as API (parse errors), TMP underneath | **Trivial-Low** — the header already compiles `--exceptions` | First *shipped* exceptions consumer; genuinely useful in a shell |
| **muparser** (beltoforion/muparser, BSD-2) | math expression parser, ~5 kloc | exception-based error reporting, std::function callbacks | **Low** — `/bin/mucalc` REPL | A real calculator backend (ctlpanel's calc is UI-only) |
| **ChaiScript** (BSD-3) | header-only embedded scripting, ~30 kloc headers | **exceptions + RTTI + heavy TMP together** — boxed values via type_info, dynamic_cast dispatch | **Medium** — compile time will hurt; REPL app `/bin/chai` | The single best exercise of `--rtti --exceptions` in one target |
| **AngelScript** (zlib) | statically-typed scripting lang, ~60 kloc | classes, exceptions optional, hand-rolled calling conventions — **its native-call ABI layer needs a wasm port** | **High** (that ABI layer) | Only if we want its C++-like language; ChaiScript is the cheaper pick |
| **CLI11** (BSD-3) | arg-parsing header | exception-driven parsing, STL | **Trivial** — adopt as the standard argv layer for our C++ apps | Infrastructure, not an app; raises all boats |
| **pugixml + a `/bin/xmlq`** (MIT) | XML DOM, ~10 kloc | mostly Tier 3, exceptions optional — the *contrast* consumer (works with and without `--exceptions`) | **Low** | XML sibling of jsonq; proves both build modes of one lib |
| **Catch2 v3** (BSL-1.0) | test framework, ~30 kloc | exceptions as control flow, RTTI, templates, iostreams — a 4/5 straddler | **Medium** | In-OS test runner upgrade over doctest; stress before Tier 5 |

### Tier 5 — iostreams (cout/cerr/fstream/stringstream as the app's spine)
*(Proves: the mini-STL `<iostream>` stack under load. Stockfish already
*forced* this layer into existence — Tier 5's job is breadth: formatting
corner cases, fstream+seek, tellg/putback, manipulators.)*

| Candidate | What / size | C++ it exercises | Difficulty | Why in gucOS |
|---|---|---|---|---|
| **Stockfish 11 → `/bin/stockfish`** (GPL3 — already vendored & passing) | the chess engine, UCI on stdin/stdout | the whole iostream/iomanip/sstream/bitset/fstream surface | **Low** — publish via overlay@1; it already runs on host.js | Flagship. Pair with a tiny ANSI chessboard TUI (`/bin/chess`) driving it over a pipe — pipes are first-class since 0181 |
| **primesieve CLI** (kimwalisch/primesieve, BSD-2) | segmented sieve, ~10 kloc | iostreams formatting, chrono, STL; threads to strip (has single-thread mode) | **Low-Medium** | An honest wasm perf benchmark app; prints pretty tables |
| **taskwarrior** (GPL... actually MIT) | CLI task manager `task`, ~70 kloc + libshared | iostream-everywhere, STL, exceptions — a 4+5 combo | **Medium-High** — trim libuuid/regex uses; no sockets needed locally | Real daily-driver utility; strong "OS you can live in" energy |
| **bc-like / calc REPLs in C++ (e.g. Expression-evaluator ports over muparser)** | tiny | iostream REPL loop, getline | **Trivial** | Cheap breadth for cin/getline paths |
| **Zork/Inform-era C++ IF interpreters (e.g. Glulxe C++ forks / scare)** | interactive fiction terps | fstream game files, iostream tty | **Medium** — check licenses per terp | Story-game shelf for term; pairs with Frotz-class C terps later |
| **cppcheck** (GPL3) | C/C++ static analyzer, ~200 kloc | STL + iostreams + exceptions at scale | **High** — size; but pure CLI, zero OS surface | Dev-tool synergy: lint the code you write in-OS; stretch pick |

### Tier 6 — heavy template metaprogramming / full modern STL
*(Proves: constexpr evaluation depth, variadic packs, SFINAE/concepts-lite,
compile-time regex — the frontend at its limits, plus mini-STL growth:
`span`, `charconv`, `compare`, maybe `ranges`. nlohmann/json already lives
at this tier's edge with features macro'd off — Tier 6 turns those ON.)*

| Candidate | What / size | C++ it exercises | Difficulty | Why in gucOS |
|---|---|---|---|---|
| **{fmt}** (fmtlib/fmt, MIT) | THE formatting library | constexpr format-string parsing, variadic TMP, UDLs | **Low-Medium** — self-contained; `charconv`-adjacent bits may need growing | Infrastructure prize: `fmt::print` for every later port; `<format>` stand-in |
| **exprtk** (ArashPartow, MIT) | expression toolkit, ONE ~1.5 MB header | the most brutal single-TU template torture in common use | **Low to try, compile-time is the test** | `/bin/exprcalc`; also a wonderful compiler-throughput benchmark |
| **CTRE — compile-time regex** (hanickadot, Apache-2.0) | regex evaluated at compile time, header-only | C++20 NTTP strings, deep constexpr | **Medium** — pushes constexpr limits; would give us regex **without** `<regex>` | A `grep`-alike (`/bin/ctgrep`) whose patterns cost zero at runtime |
| **EnTT** (skypjack/entt, MIT) | ECS framework, header-only | modern C++17 TMP, type-erasure, sparse sets | **Medium** | Substrate for a from-scratch gucOS game (roguelike/arena demo) |
| **magic_enum** (Neargye, MIT) | enum reflection, tiny header | compiler-intrinsic-adjacent TMP | **Trivial** | Smoke test + genuinely handy for our own C++ apps |
| **cereal** (USCiLab, BSD-3) | serialization | TMP + RTTI + iostreams — a 4+5+6 capstone | **Medium** | Save-file layer for our C++ games; exercises everything at once |
| **PEGTL** (taocpp, Boost-lic) | parser combinator library | template grammars, deep instantiation | **Medium** | Build a tiny language/config-parser demo; frontend depth test |
| **range-v3** (ericniebler, BSL-1.0) | ranges without `<ranges>` | the deepest TMP in the pre-C++20 world | **High** — a stressor, not an app; expect mini-STL friction | Only as a conformance battery once 6 is otherwise green |
| **nlohmann/json, restrictions lifted** (already vendored) | re-enable `JSON_HAS_THREE_WAY_COMPARISON` / ranges / `<compare>` as mini-STL grows | operator<=>, ranges integration | **Medium** (drives `<compare>`/`<span>` growth) | Turns the Tier-4 app into the Tier-6 gate with zero new vendoring |

### Deferred / rejected at the top

- **Godot** — already ruled: deferred indefinitely in the sibling
  (commit 661cb84, "god-tier rung-3 ceiling").
- **Anything socket-native** (asio, cpp-httplib, irssi-class chat): raw
  sockets don't exist; only curl-veneer HTTP. Revisit only if a candidate's
  net layer is cleanly excisable.
- **Boost-dependent projects** (ledger, older openttd deps): the Boost
  surface is not a mini-STL-sized problem; avoid.
- **Qt/GTK/wxWidgets apps**: whole-toolkit ports are out of scope; ImGui is
  our GUI substrate.

---

## 3. Suggested proving protocol (per selected candidate)

Mirrors the sibling's existing pattern (box2d/bullet/stockfish):

1. Vendor pristine upstream under `clang-simplified/wasm/vendor/<name>/`
   (pinned tag + SHA, patches as separate files — the Stockfish
   `CC2WASM.md` format).
2. A deterministic headless harness `wasm/tools/run-<name>-test.sh`
   (native-vs-wasm output match where the workload allows).
3. Front-end (tty or `--sdl`) written from scratch against the subset, the
   `nes_app.cpp` way.
4. Publish `overlay@1` (or gucman package for optional apps) → bake → gucOS
   e2e test in this repo (kernel e2e + browser sweep leg as fits).
5. A tier ratchets only when its selected picks are ALL green end-to-end.

**AWAITING USER SELECTION — pick candidates per tier (suggest 2–4 each);
picks become numbered queue items.**
