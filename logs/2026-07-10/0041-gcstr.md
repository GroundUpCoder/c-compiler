# 0041 — `__gcstr("...")`: string literals as imported externref constants

Landed `__gcstr` (todos/done/0041): a C string literal becomes an imported
immutable `(ref extern)` global — module `"#"`, import NAME = the literal's
bytes — resolved at compile time by `importedStringConstants`. Zero-copy,
zero linear memory, deduped by construction. `GCSTR(s)` in guc.h is the
friendly spelling.

## Shape of the change

**No new AST node.** The plan sketched a `GCStringLiteral` class; the landed
form is an `EIntrinsic` of kind `GC_STR` carrying the parsed `EString` as its
single arg. That's the established pattern for every other GC builtin
(`__ref_null`, `__cast`, …) and means exactly three dispatch sites (parser,
C-printer, codegen) instead of a class every visitor must learn. The EString
child rides along inert: nothing ever takes its address, so it never lands in
`stringLiteralAddrs` → never in a data segment (the host-level test asserts
the literal's bytes appear in the binary exactly once — the import name).

**The index-shift, structurally.** Imported globals occupy `[0, K)` of the
global index space, so every defined global shifts by K — and function bodies
burn indices in as bytes the moment they're emitted. Rather than a relocation
pass, ordering is enforced: `generateCode` pre-scans every function body and
static-storage initializer for GC_STR nodes (the inliner has already run, so
the walk sees the final AST) and registers all imports BEFORE the first
`addGlobal` (stack pointer). `addGlobal` bakes `globalImports.length` into
the ids it returns; `addGlobalImport` throws if a defined global already
exists; the codegen GC_STR case throws on an unregistered literal instead of
registering late. A missed path is a loud ICE, not a silent off-by-K.
(`patchGlobalI32` — the heap-base patch — now subtracts the import count;
it indexes the defined-globals array directly.)

**UTF-8 at the parse boundary.** Import names must be valid UTF-8; `\xNN` /
octal escapes can produce bytes that aren't. The parser fatal-decodes the
literal at `__gcstr` and rejects with a source location (`err_gcstr_bad_utf8`)
— the alternative was the byte-offset gibberish of the emit-time wasm
validator backstop. Wide literals (L/u/U) are rejected; u8 passes (it IS
UTF-8); embedded NULs are fine (valid UTF-8, valid JS string). Strict UTF-8
decode is injective (fatal rejects overlong forms), so the dedup key —
decoded content — equals byte equality. Names emit as raw bytes, not
`emitString`'s charCodeAt (which would mangle non-ASCII).

**`__refextern` gained its one global initializer.** `global.get` of an
immutable import is a wasm constant expression, so file-scope
`__externref g = __gcstr(...)` AND `__refextern r = __gcstr(...)` both work
— the latter used to be unconditionally rejected (nothing non-null could
initialize it). The old rejection stands for every other initializer.

## Host wiring

`importedStringConstants: '#'` joined the MUST-MATCH compile-options pair
(host.js `runModule` + kernel.js `_moduleFor`) — verified benign for every
existing binary (option only affects modules that import from `"#"`).
Loaders that can't pass compile options get the documented polyfill
`imports['#'] = new Proxy({}, {get: (_, name) => name})` — proven by
`tests/host/test_gcstr_imports.js`, which instantiates a gcstr binary with
NO compile options at all.

**Residue → todos/0097**: the C and ss compile options are now IDENTICAL,
which was the only reason ss modules were excluded from the 0037 spawn
module cache (SS-INTEROP.md §4). 0097 drops the exclusion.

## Tests

- `tests/unit/gc/gcstr` — js-string ops over constants, file-scope both ref
  types, static local, macro, adjacent-literal concat, inlined call sites,
  NUL + non-ASCII, `__jss` equivalence.
- `tests/unit/gc/gcstr_mixed_globals` — the index-shift stress: reads AND
  writes of i32/u32/i64/f32/f64/ref/eqref defined globals + statics + alloca
  (stack pointer) + heap_base (the patched global) with imports in play.
- `tests/unit/gc/err_gcstr_{nonliteral,bad_utf8,wide}` — diagnostics.
- `tests/host/test_gcstr_imports.js` — binary shape: one import per distinct
  literal, literal bytes absent from data segments, immutable global kind,
  the no-options Proxy polyfill.
- Suites: unit 707/707, kernel 44/44 (module cache incl. ss exclusion),
  blockfs 15/15, host all-pass, ast 125/125, headless boot, browser
  os-boots.mjs (Chromium accepts the new compile option), and an in-OS
  `cc`-compile-and-run of a gcstr program (rw-volume bytes path).

## Adjacent fix: perpetual image staleness from bake temps

Found while the suites ran concurrently: `newestBakeInput` (os-common.js)
scanned mkimage's atomic-rename temps (`os-system.img.tmp-<pid>`) as bake
INPUTS. A temp left by a killed bake read as an ever-newer input → the
published image was stale forever → serve.js re-baked on every start → the
5s `test_first_run` timeout killed serve mid-bake → ANOTHER temp. The filter
now skips `.img.tmp-<pid>` (they're bake outputs), and the pattern is
gitignored. Self-feeding failure loops out of test timeouts are worth
watching for.
