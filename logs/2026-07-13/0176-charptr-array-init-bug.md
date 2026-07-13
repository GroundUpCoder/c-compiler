# 0176 — the `{ "str" }` char*-array miscompile (found by /bin/code)

While landing 0174's in-OS leg, `/bin/code` SEGV'd (or hung — the symptom
moved when instrumentation moved, the classic corruption tell) before its
first HTTP request. Bisection: cJSON fine in isolation, veneer fine (0173's
differential just proved it), pure-C repro in four steps down to:

```c
const char *r[] = {"command"};   /* r[0] == 0x6d6d6f63 — "comm" as an address */
```

**An array of char* with EXACTLY ONE string-literal initializer got the
`char s[] = "str"` byte-copy rule**: the string's bytes were written into
the pointer slot. Two elements were fine (the shortcut can't pattern-match),
bare pointers fine — which is why the whole vendor corpus (busybox tables
are almost always multi-element) never tripped it. code.c's
`{ const char *r[] = {"command"}; make_tool(..., r, 1); }` blocks are the
minimal trigger, and cJSON then walked the garbage pointer.

Root cause: sema (`normalizeInitList`, compiler.js:8864) has the correct
C11 6.7.9p14 guard — the element type must be a matching-width character/
integer type — but SIX downstream `{ "str" }` shortcut sites lacked it:
the three compound-literal parse paths (these ADOPT the string's char[N]
type, so `(const char *[]){"x"}` failed to parse outright), the static-data
populator, the frame-slot local init, and file-scope compound literals.

Fix: one shared top-level predicate `stringLiteralCanInitArray`, gated at
every site; refusal falls through to the ordinary per-element path, where
the literal decays to a pointer like any scalar initializer. Test-first per
the house rule: `tests/unit/conformance/charptr_array_string_init/`
(clang-verified golden; auto sized/unsized, static local, file-scope
static, two-element controls, const char** round-trip — the cJSON shape —
plus the byte-copy rule and both compound-literal flavors as regression
guards) committed red in c34ef31.

Debugging notes for next time:
- Standalone `node host.js x.wasm` + stderr markers is the fastest bisect
  loop for in-OS crashes — no kernel, no image bake.
- Print pointers with %p BEFORE dereferencing with %s: `0x6d6d6f63`
  reading as ASCII was the whole diagnosis.
- stdout is buffered in-OS; SIGTERM'd runs lose it. Instrument on stderr.
