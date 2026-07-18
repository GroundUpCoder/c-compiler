# mGBA compiler.js crt0 investigation: requested failure does not reproduce

**Date:** 2026-07-18  
**Branch:** `mgba-compilerjs-fix`  
**Base:** `origin/mgba-shared-bug` at `dc7054e`

## Result

The kickoff's required first premise is false on the specified base: a fresh,
direct compiler.js build boots Mario Tennis cleanly past the cited crt0 branch.
It does not jump to `0x09000000`. This was verified both with and without the
128-entry instruction ring, without an OS image or baked application cache.

Consequently there is no reproducible miscompiled handler, C construct, or
minimal compiler conformance failure to fix. No compiler or vendor source
change is included. Inventing a codegen change from the historical symptom
would be a symptom patch without a red regression and would violate this
item's root-cause requirement.

## Exact reproduction

The instrumented build recorded `(pc, opcode, r1)` before every ARM/THUMB
handler and arranged to flush the last 128 entries from the invalid-address
path. It was compiled directly:

```sh
node compiler.js vendor/mgba/bin.json -a compile \
  -o /private/tmp/mgba-compilerjs-trace-resume.wasm
node host.js /private/tmp/mgba-compilerjs-trace-resume.wasm \
  /Users/jku/git/c-compiler-copy/vendor/gameboy/roms/mariotennis.gba
```

An eight-second bounded foreground run produced no `BADJUMP`, no
`Jumped to invalid address`, no illegal opcode, and therefore no ring dump.
Instead it passed crt0 and continuously reported valid activity including:

- DMA from `0x0800070C` to `0x03000100`;
- DMA from `0x08020AD0` to `0x030001E8`;
- SWI `0B` calls at valid game PCs;
- SRAM save detection;
- repeated display/audio DMA during the normal game loop.

The uninstrumented build produced the same behavior. Two independent fresh
uninstrumented compilations were byte-identical:

```text
c78b1e9e79022257ea3f69b1afdfe992f554cd863607140ca7ce25c207be3725
```

This rules out ring-buffer source perturbation and compiler nondeterminism for
the current tree.

## Historical-compiler control

To test whether later compiler work had silently fixed the issue, compiler.js
from the old mGBA port commit `fa79315` was streamed directly from git and used
to compile the current pre-item-C mGBA source shape. That rebuilt wasm also
booted Mario Tennis cleanly. Rebuilding the fully dirty historical throwaway
clone (including its original trace instrumentation) likewise booted cleanly.

Thus the committed historical `0x09000000` observation cannot currently be
recreated from the named compiler/source revisions. The strongest remaining
explanation is that the earlier differential exercised a stale or otherwise
different wasm artifact despite the intended freshness controls. This is an
inference from the rebuild evidence, not a proved identity of the old artifact:
the failing wasm binary and its hash were not preserved in either dev log.

## Validation

- compiler.js conformance corpus: **115 passed, 0 failed, 8 expected xfails**.
- Mario Tennis, compiler.js direct build: clean past crt0 for repeated bounded
  runs, with the same valid activity previously used as the clang oracle.
- jsmolka expectations remain item C's verified baseline because this branch
  changes no executable source: ARM test 522, THUMB test 230, memory all pass.
  Those separate residuals were explicitly excluded from this item.

## Blocker and next evidence needed

A fundamental compiler fix requires the exact failing input/output pair. Resume
this hunt only after preserving a wasm that actually jumps to `0x09000000`, its
SHA-256, the compiler.js SHA used to create it, the complete `bin.json`, and all
78 source-file hashes. The failing wasm can then be compared structurally with
the deterministic clean wasm above, and its named bad handler reduced to a C
repro. Without that artifact, adding a conformance test would not pin the cited
failure and no defensible compiler.js codegen patch can be made.

No deploy, image, overlay, baked binary, or vendor workaround was made.
