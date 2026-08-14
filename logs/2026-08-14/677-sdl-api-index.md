# #677 — generated SDL API index at /usr/share/doc/sdl-api-index.md

**Problem.** GCODE.md correctly says "the headers are the authoritative
surface — don't assume stock SDL3", and the measured consequence (#508 Pass B
round 2, evidence `s3://groundupcoder/gucos/508-passb-r2/2026-08-13/
s1-brief.log`) was ~17 of 34 rounds of a fresh gcode session spent grepping
`/usr/include/SDL.h` to reconstruct the API before writing any game code —
repeated in later sessions because compaction folds the detail away.

**Fix.** `os/doc/sdl-api-index.md`: one line per symbol, grouped (init,
main-loop callbacks, events, input state, window, renderer/textures, timing,
audio, clipboard, cursors, error, hints, paths, memory/random/log, plus the
subsidiary headers SDL_popup.h / SDL3_image / sdl3webgpu.h), full types +
constants sections, and a "notably absent" list. Baked by the uniform
image.json doc wiring (`bin: os/doc/sdl-api-index.md`), referenced from
GCODE.md's SDL bullet and the doc README chapter table. No gcode code change —
the #530 layered context already embeds GCODE.md, which points at the file.

## The (a)-vs-(b) shape decision

The ticket said "generated at bake time so it cannot drift". Two honest
shapes: (a) generate during the bake (file never in git), or (b) commit the
generated file and pin it with a regenerating drift test. **Chose (b),** on
this evidence:

- Every existing `/usr/share/doc` entry is a committed `bin:` file; (a) would
  need a new manifest entry kind in the seedEntries pipeline AND would have to
  run inside the in-browser bake path (kernel-worker bakes in-worker when the
  prebaked fetch misses), while making the shipped artifact unreviewable in
  git.
- (b) has two in-repo precedents at once: `tools/mkmpgenhdr.js` (committed
  generated artifact, `--check` as the registered sync test) and #505
  (`test_gcode_orientation.js`, a doc pinned to the platform by a host test).
- The anti-drift property is enforced by a TEST either way; (b) gets it
  without touching the bake pipeline.

The dishonest third shape (a hand-maintained file with a "generated" banner)
is exactly what `tools/mksdlindex.js` exists to prevent: the file is a pure
function of `createDefaultPPRegistry().standardHeaders` — the same seam the
#505 test pins.

## Anti-rot guards in the generator itself

A drift test only catches committed-vs-generator divergence; a generator bug
would drift silently on both sides. Two loud-failure guards close that:

- **No silent drops.** Every top-level header declaration must classify
  (unrecognized shape → throw); every function must match exactly one GROUP
  rule and every constant one CLUSTER prefix (no match → throw naming the
  symbol). A new SDL symbol either lands in a family automatically or forces
  a deliberate taxonomy decision.
- **Absence claims are verified at generation time.** Every name in the
  curated ABSENT list is checked against the comment-stripped surface —
  present ⇒ regeneration REFUSES, naming the PRINCIPLES.md two-sided edit.
  #672 is the live precedent: the ticket's own suggested absent list named
  `SDL_RenderTextureRotated`, which #672 made real the day before; the
  generator would have refused that exact staleness. `see:` anchors (the
  "use X instead" advice) are symmetrically verified PRESENT.
  (Comment-stripping matters: `SDL_CreateCursor` appears in a header comment
  while being genuinely absent as a symbol.)

Every "notably absent" candidate was grep-verified against `compiler.js` at
92f0745d before curation; the host test additionally pins three of them
behaviorally (undeclared through the real cc driver) and compiles the two
documented alternatives, including `SDL_RenderTextureRotated`.

## Test

`tests/host/test_sdl_api_index.js` (registered in tests/host/run.js): the
`--check` drift gate, bake + reference wiring, red controls on the
comparator / group matcher / cluster matcher / absence gate, and the
behavioral absence boundary. `image.json` bumped 263→264 (new baked file —
the in-browser OPFS gate only re-fetches on a version bump).
