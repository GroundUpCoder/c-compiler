# #772 Objective-C experiment

Base: 277b14fb1782d4f81427d8a218b7890872e9409f. Isolated branch
experiment/objective-c-2026-09-07, worktree /Users/jku/git/c-compiler-objc.
Self implementation in cc thread 01a07b6b-5a27-7616-aa3a-d1634320119a;
cc-meta metadata verified executor codex, model gpt-6-astra. No other workers.

Gamedev justification: measure whether the native C/Wasm compiler can carry
Objective-C application/editor code for a future integrated game-development
workspace. This is a language/runtime experiment, not a desktop or Cocoa project.

## Red before implementation

Executed `node compiler.js tests/objc/core.m -o build/objc/core.wasm` at the
base compiler. Compilation refused with 13 lex errors, beginning with
`tests/objc/core.m:2: error: Unexpected character: '@interface'` and including
`@implementation`, `@end`, and `@selector`. Exact local output: build/objc/red.log.
The no-preprocessor parseSource probe separately failed at the C declaration parser.

The fixture asserts dynamic instance/class dispatch through three generations,
lexical super, inherited storage, int/pointer/f32/f64/i64 signatures, selector
identity, explicit lifetime, nil zero returns and receiver/argument side effects.
Expected successful program exit is zero; no translation to C supplied by the test.

## Design evidence

At the base, compiler.js:4396 ECall already preserves the function-pointer type
for indirect calls; parser declarations and bodies use DFunc/DVar/SCompound.
GNU's portable runtime uses lookup followed by a cast to the exact IMP signature:
https://gcc.gnu.org/onlinedocs/gcc-10.2.0/gcc/Messaging-with-the-GNU-Objective-C-runtime.html
Apple's historical language guide specifies nil scalar zero returns and lexical
super lookup; aggregate nil behavior depends on the target ABI:
https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/ObjectiveC/Chapters/ocObjectsClasses.html

Proposed boundary: one Objective-C TU, static class metadata, explicit
`guc_objc_alloc`/`guc_objc_dispose`, no ARC or automatic retain/release. Runtime ABI
is gucOS-specific; no Apple/GNU binary ABI compatibility claim.

## Implementation and targeted evidence

Implementation commit 06b9ce16; receiver-type correction 8a2b6504. The complete
support/refusal contract is tests/objc/README.md. Actual parsing builds the
existing DFunc/DVar/type/body AST; a message lowers to a typed helper call. The
runtime boilerplate and class-table initializers use the existing C parser.
Selectors are TU-local integers; static class/metaclass tables chain by parent;
lookup returns a generic IMP that the helper casts to its precise signature.
Root objects have a compiler-owned class-pointer header, an explicit custom ABI
choice. There is no Apple/GNU binary compatibility claim.

Executed Node corpus: five source programs in both default and no-inline modes
(all ten executions exit 0), and 23 expected compiler refusals. Covers i32/i64,
f32/f64/long double under existing C representation, data/function pointers,
mixed signatures, 1000 allocate/use/dispose iterations, typed superclass
upcasts, implicit/explicit and public/protected/private ivars, local shadowing,
recursive/nested sends, class-valued id, three-generation override/super,
selector identity, nil results and single evaluation. C-mode and multi-.m
refusals also pass. Raw output: build/objc/node.log.

The real Chromium standalone harness compiles source inside the page, then runs
its own resulting Wasm; it does not receive precompiled Node bytes. Earlier
iterations passed; the final corpus is additionally enrolled in os-objc.mjs for
the composed browser gate. build/objc/browser.json records the browser user
agent, per-execution exit/byte size, and per-refusal result of its latest run.

A headless gucOS /bin/cc test actually read core.m from BlockFS, compiled it,
launched the executable in a fresh kernel process, and observed OBJC-RESULT=0.
Its exploratory filtered run passed 1/200 kernel members; the first fixture bake
and the member each took about 225 seconds (source edits during investigation
made the first baked fixture stale). This is not an exact-tip broad gate.
The copied record is build/objc/targeted-kernel-summary.json and member log.

A separate dynamic-receiver probe whose actual class lacks the declared selector
exited 134. With -g and no inlining, fd2 named abort -> __guc_objc_lookup ->
__guc_objc_send_i1 -> main at unknown.m:1. The source and decoded output are
build/objc/unknown-runtime.m and unknown-runtime.json. This is an intentional
runtime refusal, not a compiler success assertion for message forwarding.

Header preprocessing was also exercised directly: @interface in Probe.h included
by a .m TU parsed without errors; __OBJC__ did not leak back into the registry.
An aggregate method rejection named bad.m:2. Macro-expanded @ directives have a
permanent positive fixture.

## Aggregate ABI finding and next-step assessment

Executed tests/objc/aggregate-abi.c through this compiler and its generated Node
runner; exit 0. This is explicitly a C-only control. The emitter's
getWasmFunctionTypeIdForCFunctionType adds an i32 hidden return pointer for
aggregate returns; the inliner already refuses that return shape because of
caller-deferred stack restoration. That foundation is real, but it does not
establish Objective-C nil aggregate behavior, nested-send temporary lifetime,
argument-copy behavior or override compatibility. The spike refuses aggregate
method values at the parser instead of applying the scalar helper to them.

The next compiler-sized extension would be a cross-TU class/selector ABI plus
broader method type resolution. Current limitations are concrete: selectors
are numbered per TU, tables are static, and each selector/kind has one global
signature. Properties/categories/protocols would each add parser/type/runtime
work beyond that foundation. ARC and Blocks are separate ownership/ABI projects,
not syntax toggles. No measured implementation schedule follows from this spike.

An Xcode-like experience can be pursued independently of Cocoa: project/build
UI, editing, errors, and debugging can use the existing OS process/filesystem
seams. The current Win32 widget veneer gives the existing UI path a head start;
a macOS-inspired look does not require a kernel/filesystem rewrite. Foundation,
AppKit, responder chains, text/layout, documents and Interface Builder-style
resources remain a much larger library/tooling decision. GNUstep is a research
candidate, not a verified Wasm drop-in. This experiment changes none of those UI
or library layers and schedules no desktop rewrite.

## Stable-tip review corrections and a preserved red

The first browser OS attempt did not boot. Its standalone Chromium corpus passed,
but compiler.js had been edited after the fixture bake started. The fixture's
published mtime was 19:55:45 +0900 while compiler.js was 19:56:19, so serve.js
started a second bake and the 5-second waitForServer window expired. The sweep
record is a real FAIL, 0/1 selected browser members passed; it is preserved as
build/objc/browser-startup-red-{summary.json,member.log} and browser-startup-red.log.
The orphan bake process 38008 was identified by its exact worktree command and
stopped with SIGTERM; the next preflight reclaimed its 0.1 GB temporary file.
No test timeout was weakened. The retry began after committing all source edits.

Final source correction: 87c9562f threads Objective-C tokenization through
predefined macros, prelude tokens, pragma text and token pasting. Clang's actual
preprocessor confirmed `-DDECL=@NAME -DNAME=interface` expands `DECL A` to
`@interface A`; the host regression now asserts that path and no __OBJC__ leakage.

Five ordinary C controls (integer arithmetic, floating arithmetic, aggregate
indirect returns, preprocessing and malloc/calloc/free) were compiled with both
277b14fb and 87c9562f using the same filenames/options. Every resulting Wasm was
byte-identical. Sizes/hashes are in build/objc/c-byte-identity.json. This is a
small noninterference check, not a substitute for the selected regression gate.

One additional design cost is already visible: this spike represents id as void*.
A broader frontend should preserve distinct object type/ownership information
before attempting ARC or stronger method type resolution. Static linear table
lookup also has no dispatch cache; no performance target was measured here.
These are explicit experiment boundaries, not claims that Cocoa or a full
Objective-C toolchain is ready.

## Stable browser result and serial validation boundary

The stable retry at source/test tip 87c9562f passed os-objc.mjs: 1/70 browser
members selected, executed and recorded, zero carried/resumed, status pass.
The fixture baked in 225.4 seconds; the member took 5.1 seconds. Inside the
member, Chromium compiled/executed all ten positive mode/case combinations
and checked all 23 compiler refusals, then the real browser OS clipboard/tty
path wrote core.m, /bin/cc compiled it with -g, and the process-worker execution
reported OBJC-RESULT=0. The browser user agent reports HeadlessChrome
149.0.7827.55. Copied evidence: build/objc/targeted-browser-summary.json,
targeted-browser-member.log, os-browser-final.log and browser.json.

The original checkout was not edited. This experiment remains isolated and
committed; no merge, deployment or remote push occurred. #772 stays in progress.
The broad 25-suite diff gate and the standard flake gate have NOT run for this
experiment yet. Those mandatory checks, failure resolution, exact final artifact
inspection and ticket closure pass to a real serial continuation; no internal
agent or parallel implementation worker was used. All targeted sessions are
closed before creating that continuation.

## Completed fresh regression and flake gates — serial continuation

The real continuation is cc thread 01a07b8e-f2c3-7b33-8ada-084561cbda9e.
Its metadata was read through shell cc-meta and verified as executor `codex`,
model `gpt-6-astra`; ticket #772's claim was transferred to this thread and
re-read to verify both claimant and working-thread link. This continuation
performed validation and documentation itself, with no internal agents or other
implementation workers. No compiler or test source changed: both gates ran at
HEAD a02713e61fb9d018653e30b638f0335baec70d14, source/test tip 87c9562f.

Executed fresh, with no --resume or test filter:

```
node tests/run.js --diff 277b14fb --dry-run
node tests/run.js --diff 277b14fb --out=build/objc/gate
```

Run `20260907-111042-38615` began 2026-09-07 11:10:42 UTC and ended
12:12:15 UTC; elapsed 3,693,238 ms (61.6 minutes), exit 0. The actual new
`build/objc/gate/summary.json` was checked before child artifacts: its mtime
postdates the start, filter is null, it selects 25 suites, and all seven
execution rows are literally `pass` (19 Python categories share one row).
This is the mapper's **diff gate**, not the full ship tier: `netsurf-patch`
is explicitly omitted. No deployment is being made.

| Execution row | Fresh result |
|---|---|
| todos | pass |
| unit | pass |
| host, including Objective-C corpus | pass |
| blockfs | 15/15 members pass |
| Python batch, 19 categories | 904 pass, 0 fail, 111 baseline skips; skip-baseline check passes |
| kernel | 200/200 members pass |
| browser sweep | 70/70 members pass |

The complete kernel/browser child manifests each have `done: true`, null filter,
executed = recorded = total, zero resumed/carried, and only pass results. The
fresh kernel Objective-C member passed in 0.7s; the browser Objective-C member
passed in 4.6s. Its log records Chromium 149.0.7827.55 compiling/executing all ten
positive cases and checking all 23 refusals, then compiling core.m via browser
OS /bin/cc and executing it in a process worker with exit 0. These are fresh
executions in the broad gate, not the earlier filtered results.

Before the next gate, complete kernel/browser/BlockFS/Python artifact directories
were copied under `build/objc/gate-children/`. Dispatcher history and transcript
are under `build/objc/gate/history/`; full shell output is `build/objc/gate.log`.
The earlier exploratory startup red remains preserved and separate.

Then executed the standard `node tests/flake.js`, serially after the regression
dispatcher exited. Exit 0 in 503.7s. Both legs used three repetitions under ten
CPU load generators:

- Kernel: wm_service, term, os_apps, comp_park; 12/12 fresh executions pass.
- Browser: os-compositor, os-doompage-motion, os-doom, os-term, os-wm,
  os-doompage-renders; 18/18 fresh executions pass. The standard substring filter
  selects six members, including the two Doom-page variants.

Every selected file has three pass records with repetition indexes 1/2/3; all
reported flake rates are 0% for this sample. This does not claim universal flake
freedom or a repeated Objective-C stress test. The flake manifests retain 196
kernel and 64 browser nonselected results from the preceding gate; those carried
records are **not** counted among the 30 fresh stress executions. Separate copies
are under `build/objc/flake-children/`; full output is `build/objc/flake.log`.
`build/objc/validation-final.json` records assertions, scope, and SHA-256 hashes
of the compiler, matrix, logs and summaries.

No regression or flake failure required a source fix. The final liability check
passed (37 entries, two pinned historical deferrals, 31 funding tickets), and the
register contains no #772 entry requiring retirement. Raw output is
`build/objc/liabilities-final.log`. The subset boundaries in tests/objc/README.md
remain experiment boundaries, not funded promises to implement Cocoa/ARC later.
Ticket closure records this isolated experiment's completion; no merge, push or
deployment occurred. The original checkout and its untracked browser/projects
experiments remain untouched. Compiler/runtime follow-up costs and the separation
between macOS-inspired UX, the existing POSIX-like filesystem/Win32 UI path, and
Cocoa compatibility remain as assessed above.
