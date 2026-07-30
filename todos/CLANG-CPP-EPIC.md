# CLANG-CPP-EPIC — real clang/C++ on gucOS: the self-hosting milestone + the clang build infra

Status: design (2026-07-20). No code in this doc's landing commit — design only.

Repos involved:

- **`../clang-simplified`** (sibling checkout) — the buildless Clang/LLVM 21.1.8
  amalgamation: `simple1/` (canonical reshaped form, 2278 TUs, builds a single
  ~305 MB native multicall ELF `simple1/out/llvm` with `clang`/`wasm-ld` argv0
  symlinks), `cc2wasm` (the one-command C/C++→wasm32 driver targeting host.js's
  `"c"` env), `wasm/` (reused ISO-C libc + `libcxx-mini` header-only STL +
  compat/RTTI/EH runtimes), `wasm/spikes/llvm-slice/` (the self-host
  feasibility spike), `out-image/` (the published `overlay@1` artifact).
- **this repo** — gucOS: the bake pipeline (`os/os-common.js`,
  `tools/mkimage.js`), the dev server (`serve.js`), the package system
  (`packages/*.json`, `tools/mkpkg.js`, `/bin/gucman`, `/bin/software`).

What already exists (do not re-invent):

- **The `clang-apps` image overlay** (todos/0118 bake, todos/0141 serve):
  `os/image.json` declares overlay id `clang-apps` with
  `manifest: ../clang-simplified/out-image/overlay.json` (`os/image.json:3-11`);
  `tools/mkimage.js --overlay=clang-apps` plants prebuilt `*-clang` apps into
  the baked `/usr/bin`, and `serve.js --clang` serves that sidecar image
  (`serve.js:13`, `resolveOverlayPlan` `serve.js:37-61`). The overlay producer
  is `../clang-simplified/wasm/tools/mk-overlay.mjs` → `out-image/overlay.json`
  + payload dirs (`doom-clang/`, `gameboy-clang/`, `sameboy-clang/`, …),
  sha256-manifested, installed **never overriding stock builds**.
- **The `*-clang` naming convention** — every clang-built app variant carries
  the `-clang` suffix (overlay@1 precedent; `logs/2026-07-12/…` in the sibling).
- **cc2wasm inside the OS, native-exec flavor** —
  `../clang-simplified/wasm/os/cc2wasm-os.js` boots gucOS with a compile hook
  that `exec`s the **native ELF** toolchain from the kernel-side Node process.
  That is a development convenience, not self-hosting: the compiler is not a
  wasm process, cannot run in the browser kernel-worker (no `child_process`),
  and dies the moment the OS is the real deployment target.
- **The feasibility spike** (sibling `todos/0037`, log
  `logs/2026-07-11/llvm-to-wasm-spike.md`): real `llvm::StringRef` /
  SmallVector/DenseMap/StringMap / `raw_fd_ostream` programs — including
  linking `Support/StringRef.cpp` itself — compile through cc2wasm and run on
  host.js with `"c"`-only imports. Verdict: **no fundamental language/target
  wall**; the gap is bounded library-surface breadth plus the `llvm::sys` OS
  layer, and the genuine long pole is **scale** (a ~100 MB+ module, 2278-TU
  build) — not the C++ language.

North star for this epic: the wasm clang is a first-class gucOS binary —
`clang hello.cpp` works in a gucOS terminal with no native toolchain anywhere
in the loop — and it can rebuild its own toolchain (**clang compiling clang**).

---

# Part I — the self-hosting milestone

## 1. Definition of done (stage vocabulary)

- **stage0** — the native `simple1/out/llvm` ELF (built by the host C++17
  compiler; exists today).
- **stage1** — `llvm-clang.wasm`: the same 2278-TU source set cross-compiled
  **by stage0 through cc2wasm** to a wasm32 multicall module (clang + wasm-ld
  behind argv0 dispatch) that runs on host.js / gucOS.
- **stage2** — the toolchain rebuilt **by stage1**: stage1 compiles all 2278
  TUs and stage1's wasm-ld links them → a second `llvm-clang.wasm`.
- **Self-hosting = stage2 exists and is trusted**: stage2 compiles the demo
  corpus correctly, and object files emitted by stage2 are byte-identical to
  stage1's for the same inputs (the classic fixpoint check; the stretch goal is
  stage3 ≡ stage2 module bytes).

Two venues, in order: (a) **host.js CLI** (Node — same runtime contract, none
of the OS's scale constraints), then (b) **inside gucOS** (spawned processes
over BlockFS, browser included).

## 2. Concrete gaps blocking self-compile today

Grounded in the spike report + a fresh read of both repos (2026-07-20). The
sources themselves are friendly: LLVM builds `-std=c++17 -fno-exceptions
-fno-rtti` (`simple1/build.sh` CXXFLAGS; matches cc2wasm's fixed defaults —
across 155 Support `.cpp` there are 0 `typeid`, 0 `dynamic_cast`, 2 `throw`),
cc1 runs **in-process** (`gen/clang/Config/config.h`: `CLANG_SPAWN_CC1 0`),
wasm-ld is in-process behind the multicall dispatcher, threads-off is a
first-class LLVM configuration, and LLVM uses `raw_ostream`/`llvm::sys::fs`,
not `<iostream>`/`<filesystem>` (0 includes of either).

### 2.1 C++ standard library (libcxx-mini) — medium, mechanical

`wasm/libcxx-mini` already grew most of the LLVM-ADT surface (sibling 0041):
`<system_error>` (`std::error_code` ×213 in LLVM), `<optional>` (×714
includes), `<variant>`, `<functional>` with `std::function`, `<chrono>`,
`<random>`, `<unordered_map/set>`, `<deque>/<list>/<bitset>`, threads-off
`<atomic>/<mutex>/<thread>/<condition_variable>/<shared_mutex>`. Remaining:

- **`<future>` — absent, ×14 LLVM users.** Needs a threads-off synchronous
  `std::future`/`promise`/`packaged_task`/`async` (run-inline, like the
  existing `std::thread` stub that executes its callable in the constructor).
- **`<regex>` — absent, ×2 users.** Audit the two call sites first; prefer
  neutralizing them (config/stub) over writing a regex engine.
- **`<fstream>` write side — `ofstream` missing** (today: read-only `ifstream`
  that slurps via libc; ×2 LLVM users). Small.
- **`std::string` fidelity** — libcxx-mini's `string` is a standalone class,
  not `basic_string<char>`; LLVM includes `<string>` ×515. Expect a burn-down
  of missing members/overloads (`std::hash<string>`, `to_string` breadth,
  `char_traits` corners, `stoull`, comparison/`operator+` overload sets,
  `getline`). Same class of fallout for `<map>`/`<tuple>` (×154/×108).
- **Dialect wrinkles**: sources are C++17 while cc2wasm hardwires
  `-std=c++20 -Xclang -fno-wchar` — the toolchain build must pass
  `-std=c++17`, and the known `-fno-wchar` × `is_integral<wchar_t>`
  specialization collision (spike log) needs a decided answer, not a per-file
  patch. Quoted-include shadowing (`#include "type_traits"` from inside
  libcxx-mini headers) is a solved-pattern from the spike; keep its rule.

Ruling reaffirmed from the spike: **grow libcxx-mini toward a libc++-lite; do
NOT port upstream libc++** — upstream libc++ would re-introduce exactly the
sysroot/build-system dependency the amalgamation exists to eliminate.

### 2.2 libc / POSIX surface — the sharp edges

The reused libc (`wasm/libc`, extracted from this repo's `compiler.js`) covers
stdio/malloc/string/dirent/getenv/environ/time/locale/wchar/signal already.
The self-host-relevant holes:

- **`setjmp`/`longjmp` is accepted-unsupported** (`jmp_buf` = `int[1]`).
  LLVM's `CrashRecoveryContext` is the main client; the harvest already builds
  with `LLVM_ENABLE_CRASH_OVERRIDES=OFF` and the wasm `config.h` disables
  crash recovery — **verify no residual sj/lj path is reachable** and make any
  hit fail loud at link (undefined symbol), not silently at runtime.
- **File-backed `mmap` doesn't exist** (`sys/mman.h` is calloc-backed
  anonymous-only; file mmap → `ENODEV`). Two LLVM clients:
  `MemoryBuffer`/`mapped_file_region` (reads — must take the
  `shouldUseMmap()=false` malloc+read path; that's a Path.inc/config decision,
  already the spike's plan) and `FileOutputBuffer` (writes — **upstream
  already falls back** to an in-memory buffer when mmap fails,
  `Support/FileOutputBuffer.cpp`, so wasm-ld output is safe by construction).
- **Process spawn**: the clang driver normally `posix_spawn`s the linker
  (Program.inc). cc1 is in-process (`CLANG_SPAWN_CC1 0`) so the compile path
  needs no spawn at all. For the link step: gucOS **has** real
  `posix_spawn` (the owner-brokered model), so in-OS `clang foo.c -o foo`
  can genuinely spawn `wasm-ld` as a sibling process; on the bare host.js CLI
  there is no spawn, so the stage1/stage2 build drivers invoke `wasm-ld`
  (the same module, argv0-dispatched) as its own host.js run per link. Both
  paths avoid teaching Program.inc anything exotic; Program.inc's spawn maps
  to libc `posix_spawn` where it exists and fails loud where it doesn't.
- **Signals/backtrace**: `Signals.inc` (`sigaction`/`backtrace`/`sigaltstack`)
  is stubbed by the hand-written wasm `config.h`
  (`wasm/spikes/llvm-slice/wasm-config/llvm/Config/config.h` — threads OFF, no
  mach/pthread/dlopen/backtrace, prototype exists). `RegisterHandlers` → no-op.
- **`__cxa_atexit` is a fixed 128-slot table** (`wasm/compat/cxxrt.cpp`).
  LLVM registers ManagedStatic cleanups liberally; make the table growable
  (malloc-backed) before M2 or the failure will be a confusing mid-build trap.

### 2.3 The `llvm::sys` / config gap (spike gap B) — larger, riskier

155 `.cpp` + 20 `.inc` in `lib/Support`; **44 files reference `llvm::sys::`**
(Path/Process/Program/Signals/Threading/DynamicLibrary/Host). Work: finish the
hand-written wasm32 `llvm/Config/{config.h,llvm-config.h}` (prototype in the
spike's `wasm-config/`; harvested values are the Mac's — threads ON,
mach/pthread/dlopen present — and must be inverted) and re-back or stub the
Unix `.inc`s against the libc that actually exists: `realpath`, `getcwd`,
`opendir/readdir`, `stat` family, `getenv/environ`, `getpagesize`/`sysconf`,
`isatty` all exist in the reused libc; `dlopen` never happens
(`DynamicLibrary` → loud stub; no plugins); `Threading` → threads-off.

### 2.4 Scale and memory — the honest long pole

- **Module size**: the native ELF is 305 MB at `-O2`; the sibling's own
  estimate for the wasm module is **~100 MB+**. Risks: engine
  compile/instantiate limits and cost (Node and Chromium), and gucOS spawn
  latency. Must be **measured first** (M0), not discovered at M3.
- **wasm32 heap ceiling is 4 GiB.** Per-TU cc1 peak RSS on the biggest TUs
  (Sema/CodeGen monsters) and — worse — **wasm-ld linking 2278 objects into a
  ~100 MB module** are the two suspects. Measure native peaks in M0 as a
  proxy; if the link alone busts 4 GiB, the recorded contingencies are (in
  preference order) `-O0`/`-Os` object bloat reduction, linking in batches via
  `wasm-ld -r` partial links, and only then a memory64 build of stage1 (new
  substrate — a scope decision to surface, not silently take).
- **Throughput**: single-threaded (threads-off) wasm clang at an assumed
  3–10× native-single-core slowdown puts a full 2278-TU stage2 in the
  many-hours band. Consequence: the stage2 build driver must be **resumable
  and checkpointed** (the `tests/lib/suite-runner.js` philosophy: per-TU
  objects persisted, `--resume` picks up), never one monolithic run.
- **Command lines**: the final link names 2278 objects. LLVM tools support
  `@response-file` natively — use it everywhere; do not test gucOS's argv
  limits for sport.
- **The spawn/module-cache trap (gucOS venue) — RESOLVED by #188
  (2026-07-30)**: kernel spawn used to cache compiled `WebAssembly.Module`s
  only for read-only-volume binaries, so a gucman-installed toolchain under
  `/opt/<name>` on the **rw** root volume re-compiled its ~100 MB module
  **per spawn** — catastrophic for a 2278-invocation build. #188 landed the
  clean general fix (resolution (b) of the old menu): the fs `moduleKey`
  gives rw-volume binaries a **validated** cache key (ino+size+mtime read
  through the store), so `/opt` toolchains ride the same one-compile cache
  as baked binaries. Batch mode (`clang -c a.cpp b.cpp …`, resolution (a))
  remains worth having for spawn-count reasons alone.

### 2.5 The toolchain-asset story (sources on the OS fs)

Self-compile **inside** gucOS needs the compiler's own inputs on BlockFS:
`simple1/{src,include,gen}` (~87 MB, 2278 TUs) plus the cc2wasm "sysroot"
(`wasm/libc` headers + `libcxx-mini` + `compat/`) and the TU manifest/flags.
That is strictly package territory (a `clang-src-clang` package; §Part II) —
never baked into the base image. The cc2wasm-in-OS includes story
(`logs/2026-07-11/cc2wasm-in-os-includes.md` in the sibling) already frames
this; the package is its resolution.

## 3. The step ladder (ordered milestones, each with an acceptance test)

- **M0 — measure before climbing.** Native baselines with stage0: per-TU peak
  RSS + time for the 10 biggest TUs; peak RSS of the full single link; total
  object bytes at `-O2` vs `-Os`/`-O0`. Engine probes: instantiate a synthetic
  ~120 MB wasm module in Node and Chromium (kernel-worker context), time it.
  *Accept:* a one-page numbers memo; go/no-go on wasm32 for the link (else the
  §2.4 contingency ladder activates). Cheap, kills the biggest unknowns.
- **M1 — all of `lib/Support` compiles.** Finish wasm `config.h` +
  `llvm::sys` re-backing (§2.3); extend the llvm-slice harness from 4 tiers to
  "every Support TU compiles; the tier tests still pass on host.js".
  *Accept:* 155/155 Support `.cpp` objects + spike tests green.
- **M2 — LLVM core libs.** ADT/IR/MC/BitReader/Bitstream/TargetParser… —
  the template-stress bulk; expect the libcxx-mini burn-down of §2.1 to land
  here (`<future>` stub, string/map fidelity, growable `__cxa_atexit`).
  *Accept:* a mini `opt`-shaped tool (parse IR, run a pass, print) built by
  cc2wasm runs on host.js.
- **M3 — full cross-build: stage1 exists.** Frontend (Lex/Parse/AST/Sema) +
  CodeGen + WebAssembly backend + lld-wasm + `multicall.cpp` — all 2278 TUs
  compiled by stage0-through-cc2wasm, linked by native wasm-ld into
  `llvm-clang.wasm` (+ `@response-file`). *Accept:* the module instantiates in
  Node within the M0 budget.
- **M4 — stage1 runs.** `node host.js llvm-clang.wasm` (argv0 `clang`)
  compiles `hello.c`/`hello.cpp` → the output wasm runs on host.js. A
  `cc2wasm-stage1` wrapper drives compile and link as separate host.js
  invocations (§2.2 spawn note). *Accept:* the sibling's demo corpus compiles
  and runs; per-TU wall/RSS measured against M0 (this sets the stage2 ETA).
- **M5 — stage1 inside gucOS.** Package the toolchain + sysroot headers
  (Part II): `clang` in a gucOS terminal compiles a hello over BlockFS; the
  driver spawns `wasm-ld` via real posix_spawn; spawn-cost story resolved
  per §2.4 (batch mode at minimum). *Accept:* in-OS
  `clang /root/hello.cpp -o hello && ./hello` — browser and boot.js both.
- **M6 — determinism harness + first self-compiled TU.** stage1 compiles
  `Support/StringRef.cpp`; byte-compare against stage0-through-cc2wasm's
  object for the same flags. Chase any drift now (suspects: host-side
  vsnprintf float formatting leaking into output, path/date embedding,
  iteration-order) — determinism is the cheap proof the fixpoint check rests
  on. *Accept:* N sampled TUs byte-identical stage1-vs-stage0-built.
- **M7 — full stage2 on the host.js CLI.** A resumable checkpointed batch
  driver (Node script over the TU manifest; persisted objects; `--resume`)
  runs stage1 over all 2278 TUs; stage1's wasm-ld links stage2.
  *Accept (the self-hosting milestone):* stage2 compiles the demo corpus;
  sampled stage2-built objects ≡ stage1-built; stretch: stage3 ≡ stage2 bytes.
- **M8 — self-compile inside gucOS.** `clang-src-clang` package on BlockFS;
  the build driver is an in-OS shell script (hush + coreutils; sh-loop over
  the manifest, resumable by presence-of-object — no make dependency), batch
  clang invocations per §2.4. *Accept:* an in-OS rebuilt `llvm-clang.wasm`
  replaces the installed one and still compiles hello. Wall-clock is
  explicitly not an acceptance axis here; resumability is.
- **M9 — stretch/ergonomics (unordered).** Compile-server mode (one long-lived
  clang process fed TUs — kills spawn cost entirely), `-O0` quick-build
  profile, memory64 contingency if M0 forced it, wasm-threads if/when the
  substrate grows them.

Risk register (top 3): (1) wasm32 4 GiB vs the final link — M0 measures,
§2.4 ladders; (2) `llvm::sys` re-backing surprises (44 files) — M1 is
front-loaded exactly to flush these; (3) engine cost of a ~100 MB module in
the browser kernel-worker — M0 probes it, M5's batch/overlay/RO-cache options
absorb it.

---

# Part II — clang build infra in this repo (design only; nothing built here)

## 4. Ground rules

1. **Naming**: every clang-built binary is `*-clang` (overlay@1 precedent).
   For the toolchain itself the one real binary is **`llvm-clang.wasm`**
   (satisfying the rule); `clang` and `wasm-ld` exist only as argv0 symlinks
   next to it (that adjacency is how the driver finds its linker), planted
   inside the package prefix — stock gucOS never grows an unsuffixed
   clang-built name on `PATH`.
2. **Always optional**: base gucOS builds, tests, and ships with **no** clang
   anywhere — clang artifacts enter only when (a) the `../clang-simplified`
   sibling is present AND (b) a clang flag was explicitly given. The two
   states an explicit request can produce are *works* or *loud hard failure* —
   never a silent skip. (An **un**requested absent sibling stays a normal
   state, exactly like `serve.js:48-49` today.)
3. **One compile path**: clang payloads are produced by the sibling's own
   producer (`mk-overlay.mjs` → `out-image/`), sha256-manifested there;
   this repo's tools consume artifacts, they never invoke the sibling's
   compiler directly. One producer = one thing to keep deterministic.

## 5. Two channels, one rule

- **Channel A (exists): the `clang-apps` overlay** — bakes `*-clang` apps into
  the read-only `/usr` (`tools/mkimage.js --overlay=clang-apps`). Keep as-is:
  it's the dev flavor, and per §2.4 the RO volume is also the spawn-module-
  cache-friendly home for a future 100 MB toolchain. `os-common.js
  loadOverlays` already hard-throws with an actionable message when a
  *requested* overlay manifest is missing — the exact loud-failure semantics
  rule 2 wants.
- **Channel B (new): `*-clang` gucman packages** — the user-facing channel:
  cards in `/bin/software`, install/remove via `/bin/gucman`, zero base-image
  footprint. Designed below.

## 6. `serve-with-clang.js` (new file, sibling of `serve.js`)

Shape: mirrors `serve.js` exactly — same positionals (`[dir='build']
[port=8080]`), same single-file Node style, same COOP/COEP headers and
`/packages` route semantics — but the clang sibling is **mandatory**.

Design decision — *wrapper, not fork*: `serve-with-clang.js` performs the
hard preflight, then delegates the entire serve to `serve.js` (spawn
`process.execPath serve.js …` with `stdio:'inherit'`, forwarding positionals),
passing `--clang` plus one **new** serve.js flag, `--packages-index=clang`
(§7). Rationale: `resolveOverlayPlan`, the sidecar-image naming
(`os-system.clang-apps.img`, `serve.js:60`), the three-axis freshness gate and
the mkimage delegation (`ensureSystemImage`, `serve.js:80-133`) must not drift
between two copies; the wrapper owns only what differs — the failure policy.

Preflight (all failures: multi-line `console.error` naming the expected path
and the exact fix command, then `process.exit(1)`; **never** fall back to the
base image):

1. **Sibling repo present**: `--clang-root=PATH` or default
   `path.resolve(repoRoot, '..', 'clang-simplified')` (the same relative
   convention as `os/image.json`'s overlay manifest path). Absent →
   ```
   serve-with-clang: clang-simplified sibling not found at <path>
     this server REQUIRES the clang toolchain repo (serve.js serves the base image without it)
     fix: clone it next to this repo, or pass --clang-root=PATH
   ```
2. **Toolchain built**: `<root>/simple1/out/clang` executable. Absent → error
   naming `cd <root> && ./build.sh`.
3. **Overlay artifact present**: `<root>/out-image/overlay.json` readable +
   parseable. Absent/malformed → error naming
   `node <root>/wasm/tools/mk-overlay.mjs`. (No auto-build by default — the
   sibling's producer owns its own build; `--build-overlay` opt-in may run it
   foreground, but absence must never be *silently* healed.)
4. **Clang package prebake**: run `tools/mkpkg.js --clang` (§7) foreground;
   non-zero exit is fatal (mirror of serve.js's mkimage-failure exit at
   `serve.js:129-132`).

Then: `spawn serve.js <dir> <port> --clang --packages-index=clang`. Note
serve.js's own overlay handling stays untouched for plain `serve.js --clang`
users (drop-to-base remains that entry point's documented behavior); the
*hard* contract lives only in the new file, so the base pipeline is
byte-identical when clang is not in play.

## 7. `*-clang` packages (gucman + software center) without base contamination

**Definitions** live in `packages/` beside the stock ones, named
`<name>-clang.json`, with two schema additions consumed by `tools/mkpkg.js`
and validated in `buildPackage` (`tools/mkpkg.js:249-269` today):

```jsonc
{ "name": "doom-clang", "version": "…", "summary": "DOOM (clang-built variant)",
  "requires": "native-sibling:clang",                  // NEW: gate field
  "files": { "doom-clang": { "nativeApp": "doom-clang" } },   // NEW entry type
  "bin": { "doom-clang": "doom-clang" },
  "menu": [ { "group": "Demos", "entry": "doom-clang", "cmd": "doom-clang" } ] }
```

- **`requires: "native-sibling:clang"`** — `listPackages` (`os/os-common.js:541`)
  grows a filter: defs carrying `requires` are **excluded** from every default
  enumeration (`mkpkg` no-flag, `foldPackages 'all'` — so `serve.js`'s fat
  image, `boot.js --packages=all`, and `tests/lib/image-fixture.js` never see
  them) and **included** only under an explicit `--clang`/`withClang` opt-in.
  This single choke point is what keeps "base ships with NO clang" true by
  construction rather than by convention: naming a `-clang` package explicitly
  without the flag is `exit 2` (unknown-name path, already loud).
- **`nativeApp: "<app>"`** entry type (mkpkg-only; `seedEntries` refuses it
  exactly like `link` is refused today, `tools/mkpkg.js:201` — clang payloads
  are never bake vocabulary): resolved against the sibling's
  `out-image/overlay.json` — copy that app's payload files (wasm + assets)
  into the package tree, verifying the overlay manifest's sha256 per file.
  mkpkg's freshness closure (`newestPkgInput`, `tools/mkpkg.js:84-138`) grows
  the overlay.json mtime for these defs. The toolchain packages
  (`clang-toolchain-clang`: `llvm-clang.wasm` + `clang`/`wasm-ld` symlinks +
  sysroot headers; `clang-src-clang`: the M8 source tree) ride the same entry
  type once mk-overlay.mjs publishes them — this repo needs no new mechanism
  per milestone.
- **`mkpkg --clang`**: includes `requires:"native-sibling:clang"` defs; hard-fails
  (exit 1, fix-command error — same text discipline as §6) when the sibling or
  `out-image/overlay.json` is missing. Output goes to the normal
  `dist/packages/{pool,index.json}`; `index.json` becomes a superset with the
  `*-clang` entries. Because the public deploy always runs plain `mkpkg`, the
  published `/packages/index.json` never lists a `*-clang` package, and
  mkpkg's orphan-prune (`tools/mkpkg.js:350-357`) then removes their pool
  payloads from the deploy tree — the public repo is self-cleaning. Local
  serve↔serve-with-clang alternation re-prunes/re-adds the clang payloads;
  that thrash is a cheap re-tar of prebuilt overlay bytes (accepted;
  escape hatch if it ever hurts: key the dist dir by mode, the
  `os-system.<ids>.img` sidecar precedent).
- **`--packages-index=clang`** (the one new serve.js flag, §6): makes serve.js
  assert-and-serve the superset `dist/packages` (and re-run `mkpkg --clang`
  in its prebake instead of plain mkpkg). Flagless serve.js keeps today's
  behavior verbatim.
- **Software center / gucman: zero code change.** `/bin/software` renders
  whatever `/packages/index.json` lists and `/bin/gucman` installs by
  index entry (sha256-verified, `/var/lib/gucman/<name>.json` DB) — `*-clang`
  cards appear on a clang-enabled origin and simply don't exist on the public
  one. `minBase` defaulting to the bake version (`tools/mkpkg.js:274`) applies
  unchanged.

**Guardrails** (tests to write when this lands, named here so the queue items
can cite them): (1) a serve-suite test that plain `mkpkg` + `foldPackages
'all'` yields no name matching `-clang$` (base-purity assert); (2) a
`serve-with-clang` test faking an absent sibling → exit 1 with the fix-command
text (the `tests/serve/test_clang_overlay.js` fake-sibling harness is the
template); (3) a `mkpkg --clang` round-trip against a fake `out-image`
verifying sha256 enforcement and index superset/prune behavior.

**Non-goals**: no base `image.json` change (no version bump — nothing baked
changes), no kernel change, no gucman/software change, no auto-building the
sibling from this repo's tools beyond the opt-in `--build-overlay`.

## 8. Follow-on queue candidates (file as cc tickets via `cc-meta ticket create`, not here)

1. `serve-with-clang.js` + the `--packages-index=clang` serve.js flag +
   guardrail tests (Part II §6–7; small, self-contained).
2. `mkpkg --clang` + `requires`/`nativeApp` schema (Part II §7).
3. Kernel: content-hash module cache for large rw binaries (§2.4 option b).
4. Sibling-side (their queue): M0 measurement memo; M1 Support milestone —
   the sibling's 0030 epic owns Part I's ladder, with 0041/0042 as the
   running starts.

---

# Part II — LANDED (2026-07-20, branch `clang-infra`)

The optional `*-clang` build/package infra from §6–7 is built (this-repo
JS/packaging only; NO base `image.json` bump — base OS image byte-unaffected).
Dev log: `logs/2026-07-20/clang-infra-part-ii.md`.

- **`serve-with-clang.js`** (§6) — hard-fail WRAPPER (not a fork): preflights
  the sibling (present / `simple1/out/clang` built / `out-image/overlay.json`
  present+parseable), runs `mkpkg --clang` foreground, then delegates to the
  unmodified `serve.js` with `--clang --packages-index=clang`. Every preflight
  miss is a loud `exit(1)` + fix command; never falls back to base.
  `--clang-root=PATH`, `--build-overlay` opt-in.
- **`mkpkg --clang`** (§7) — `requires:"native-sibling:clang"` gate field (filtered at
  `listPackages`, the base-purity choke point) + `nativeApp` entry type (copies
  `/usr/bin/<app>` from the sibling overlay, sha256-verified through the SAME
  `os-common.loadOverlays` the bake uses). Plain `mkpkg` writes the base index
  (no `-clang` name); `--clang` writes the superset; orphan-prune self-cleans.
- **`serve.js --packages-index=clang`** — one new flag: asserts the served
  `/packages` index is the clang superset; flagless serve.js byte-identical.
- **`packages/doom-clang.json`** — the shipped example `-clang` def.
- **3 guardrail tests** (all green, in `tests/host/run.js` + `tests/run.js`
  RULES): base-purity (a), serve-with-clang preflight exit-1 (b), mkpkg --clang
  sha256 round-trip (c).

Not yet built (as designed — no mechanism gap): the real per-app `-clang` defs
and the toolchain packages (`clang-toolchain-clang`, `clang-src-clang`) — they
ride the same `nativeApp` type once the sibling publishes their overlay payloads.
