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
