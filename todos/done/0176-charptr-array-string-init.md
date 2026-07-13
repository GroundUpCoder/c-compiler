# 0176 — P0: {"str"} initializer for a char* array copies bytes, not the pointer

- **Status**: done (2026-07-13)
- **Design**: —

## Resolution

Fixed with ONE shared predicate, `stringLiteralCanInitArray(arrayType,
strExpr)` (compiler.js, top-level between the WASM helpers and the Parser
module so both scopes see it): element type must be a non-pointer,
non-aggregate, non-array scalar whose width matches the string's element
width — the same guard sema's `normalizeInitList` already had. Applied at
all six `{ "str" }` shortcut sites: the three compound-literal parse paths
(which previously ADOPTED the string's char[N] type, so
`(const char *[]){"x"}` didn't even parse), `populateInitListStatic`
(static locals + file-scope statics), the local frame-slot init path, and
file-scope compound-literal initialization. When the guard refuses, each
site falls through to the ordinary per-element path, which handles the
string-literal-decays-to-pointer case correctly.

Conformance test committed red first (c34ef31), green after; full unit
suite 711/711. Dev log: logs/2026-07-13/0176-charptr-array-init-bug.md.

## Goal

`const char *r[] = {"command"};` miscompiles: the string's BYTES land in the
pointer slot (r[0] == 0x6d6d6f63 "comm") instead of the literal's address —
the `char s[] = "str"` byte-copy shortcut fires for ANY array with exactly
one string-literal initializer, without checking that the element type is a
character type (C11 6.7.9p14). Multi-element initializer lists are fine (the
shortcut can't pattern-match them), bare pointers are fine.

Found by /bin/code's build_tools() (todos/0174): cJSON walked a "required"
name list through such an array and SEGV'd/hung on the garbage pointer.

Affected sites (all missing the element-type guard that sema's
`normalizeInitList` at compiler.js:8864 already has):

- `populateInitListStatic` (static locals + file-scope statics)
- the local frame-slot init path (`emitStringToFrameSlot` caller)
- file-scope compound-literal initialization
- the three compound-literal PARSE paths, which ADOPT the string's char[N]
  type for an unsized array — `(const char *[]){"x"}` even fails to parse
  ("cannot convert '*char' to '**const char'")

## Plan

1. Failing conformance test first (house rule):
   `tests/unit/conformance/charptr_array_string_init/` — clang-verified
   golden covering auto (sized/unsized), static local, file-scope static,
   two-element control, const char** round-trip (the cJSON shape), the
   still-working char-array byte-copy rule, and both compound-literal
   flavors.
2. One shared predicate (`stringLiteralCanInitArray`, beside
   `normalizeInitList`): element type must be a non-pointer, non-aggregate,
   non-array scalar whose width matches the string's element width. Apply at
   every affected site.

## Acceptance

- The new conformance test passes; the full unit suite stays green (the
  char/wchar byte-copy rule and `char m[][6] = {"ab","cd"}` untouched).
- /bin/code's build_tools() runs in-OS (0174's e2e covers it from then on).
