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
