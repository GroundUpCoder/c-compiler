# #723 (#529-B) — complete path-based `SDL_LoadWAV` (pinned upstream decoder adaptation)

Lane: `lane/723-sdl-loadwav`, base `36e6a26ff6ed47a3d5908740639c0c54af0cc7b1`
(the reviewed #722 tip — NOT main; B's output feeds A's conversion path).
Canonical design: `~/git/meta/meta/notes/cc-529-proposal-superseding-2026-08-19.md`.
Classification: `feature-gap` (`SDL_LoadWAV` measured TRUE null at #529).

**Epic justification (`epic:gamedev`).** #720 (Pass A round 5) shipped a real
game that had to hand-roll `snd_wav_parse()` (`os/sounds.h:98`) precisely
because `SDL_LoadWAV` does not exist — a game could not load a sound asset
from disk by the standard API at all. Complete WAV loading is the asset half
of the audio foundation the epic's acceptance bar ("various games … very
stable and very enjoyable") gates on, and it is a RECORDED hard prerequisite
chain: `#721 (Pass A round 6) → #529 → {#722, #723}`.

## What landed

`bool SDL_LoadWAV(const char *path, SDL_AudioSpec *, Uint8 **, Uint32 *)` —
the complete codec contract (PCM 8/16/24/32, IEEE float32, MS ADPCM, IMA
ADPCM, A-law, mu-law), by adapting the PINNED upstream decoder, not by
writing a fresh one and not by promoting `snd_wav_parse`.

- **Pin:** libsdl-org/SDL tag `release-3.4.0`, commit
  `a962f40bbba175e9716557a25d5d7965f134a3d3`.
- **Imported originals** (pristine copies committed at
  `logs/2026-08-20/529b-evidence/upstream/`; SHA-256 also in
  `tests/unit/sdl_load_wav/upstream.json`):
  - `src/audio/SDL_wave.c` — 76,624 B —
    `add3e834af400f913864b8e9dee5985e8cf3fd8d8d2cb6949a64380a0d1014c0`
  - `src/audio/SDL_wave.h` — 5,302 B —
    `9f7d01071f8100f35f552b5ea8605cf2a3af8bd25cadbc360fa4ab5e1b977214`
  - `LICENSE.txt` (zlib) — 884 B —
    `97f35b302b361680ec1e891e95d2d52097bb95abff361434916d99dc1305f127`
  - `test/sample.wav` + `test/sword.wav` imported verbatim into the fixture
    corpus (zlib-licensed upstream test assets).

## The adaptation is a MECHANICAL TRANSFORM, not a hand edit

`logs/2026-08-20/529b-evidence/adapt.mjs` regenerates the adapted
`__SDL_wave.h`/`__SDL_wave.c` from the pristine copies; every edit is an
exact-string replacement asserted to apply EXACTLY ONCE, with post-conditions
(no `SDL_GetHint`/`SDL_LogDebug`/… survives). `embed.mjs` splices them into
compiler.js. A reviewer runs both and diffs — the decoder body is
upstream-verbatim outside the ledger (`upstream.json`, entries H1 + E1–E8):
zlib notice + altered-source marking retained; includes and scaffolding
mapped to builtin equivalents; a private FILE*/const-mem IO adapter spelled
with the upstream names as TU-LOCAL STATICS (so every decoder call site stays
byte-verbatim while public `SDL_IOStream` stays absent); `SDL_HINT_WAVE_*`
frozen to their 3.4.0 defaults; the two debug-log functions removed;
`SDL_LoadWAV_IO` made static. **Zero decoder-math or malformed-block edits
were forced by the compiler** — the ledger's only behavior notes are the four
declared divergences (A1 OOM always sets the SDL error; A2 ILP32 2-GiB seek
clamp; A3 IO-layer error wording is the adapter's own; A4 upstream's
unreachable fmt-stream leak preserved verbatim).

## The demand-link hook (`__require_source_if`) — new compiler surface

`<SDL.h>` declares `SDL_LoadWAV` and carries
`__require_source_if("SDL_LoadWAV", "__SDL_wave.c")`: after the require drain
reaches a fixed point, the source joins the TU set only if the symbol is
referenced-but-undefined across the parsed program (the post-tree-shake decl
lists; a user definition or import suppresses the builtin), then the drain
re-runs — to a fixed point, so a fired source can require further sources.
Under `--no-fold`/`--no-undefined` the decl lists keep everything and the
hook degrades, conservatively, to always-link. This is what makes the ~74 KB
decoder TU free for every program that doesn't use it:

- **Byte-identity:** a no-LoadWAV SDL program compiled on this branch is
  BYTE-IDENTICAL to the same program compiled by the base compiler
  (`cmp` pass, 18,346 B both ways).
- **Compile cost:** no-LoadWAV ~0.26 s (base ~0.26 s — no change); a
  referencing program pays ~+40 ms and +27,083 B wasm (default flags).
- Pinned by `tests/host/test_sdl_loadwav_diff.js` (no-decoder-literal witness
  + positive control + user-definition suppression control).

## Differential corpus — 92 fixtures, byte-identical with upstream

`tests/unit/sdl_load_wav_fixtures/`: 90 generated fixtures
(`gen-fixtures.mjs`, seeded-LCG deterministic — ADPCM payloads are arbitrary
bytes on purpose: ANY nibble stream is valid decoder input and the ORACLE
defines the expected decode) + upstream's own `sample.wav`/`sword.wav`.
Coverage: every codec/width, mono/stereo/3ch/4ch IMA, extensible headers
(incl. IMA-via-validbits and the MS+extensible refusal), odd padded chunks,
unknown chunks (cue/smpl/bext/LIST/JUNK), fmt/data ordering, valid/lying/
short/duplicate fact chunks, RIFF-size zero/lying, headerless WAVE form,
truncated data (mid-frame, mid-ADPCM-block, mid-block-header), zero-length
data per codec family, blockalign-0 force-to-1, invalid alignment/rate/
channels/bit-depths, wrong/missing/short MS coefficients, bad MS predictor
index, the frozen 10000-chunk limit (a 10,001-chunk flood), and both real
upstream WAVs.

The oracle is the REAL upstream loader: `529b-evidence/oracle.c` built
natively against the pinned static SDL3 (recipe in the file; no hints set =
the exact defaults we froze). `gen-manifest.mjs` commits its verdicts as
`manifest.json`: success/spec/len/sha256(decoded bytes)/EXACT error string.

**Result: 92/92 byte-identical** — same success/failure, same spec, same
length, same decoded bytes, same error STRINGS (nothing weaker than string
equality is accepted, because the adaptation preserved upstream's wording
verbatim). In-tree: `tests/host/test_sdl_loadwav_diff.js` (registered),
one dumper run over the whole corpus + comparator red controls.

## Failure injection + ownership

`__sdl_wave_alloc_countdown` (TU seam, reserved name, no header): N ≥ 0 fails
the (N+1)th allocation in the decoder TU once, then disarms.
`tests/unit/sdl_load_wav/main.c` sweeps k = 0… per codec family until
success; every injected failure must zero every output, set a named error,
and leave the heap BALANCED (`__inspect_heap` before/after). The first
succeeding k pins each codec's allocation-site count: **PCM 4, PCM24 5,
law 5, MS 6, IMA 6** — a site appearing or vanishing moves a pinned number.
Also pinned there: upstream `InvalidParamError` wording for NULL params,
unopenable-path zeroing, zero-sample success (NULL buffer + len 0 + REAL
spec), `SDL_free` ownership + reload, and a B→A composition leg (decoded U8
through a #722 stream to S16, crc-pinned).

## Real C integration (kernel e2e)

`tests/kernel/test_audio_e2e.js` grew a `loadwav` leg (existing member — no
registry change): the app plants two COMMITTED fixtures at real filesystem
paths (`fwrite` through the process fs), `SDL_LoadWAV`s them, and pushes into
one device stream. `float32_stereo.wav` matches the device-ingest spec, so
its decoded bytes must reach the captured kernel output ring BYTE-EXACT vs
the committed file's own data chunk (modulo the mixer's [-1,1] clamp, applied
to the expectation); `imaadpcm_mono.wav` decodes to S16/1/22050 and crosses a
#722 MEMORY stream to F32/2/48k — the app prints the crc of exactly what it
pushed and the driver requires the ring to match. Headless-deterministic; no
acoustic inference. PASS (solo run; the file does not take the heavy lock —
it boots lightweight worker processes, not the OS).

## Performance (per codec; 5 s stereo 44.1 kHz programs; warm pool)

`529b-evidence/perf723.c` → `perf-output-tip.txt`:

| codec | decoded bytes | min | p50 | live heap | balanced |
|---|---|---|---|---|---|
| PCM16 | 882,000 | 0.42 ms | 0.43 ms | 882,016 | yes |
| PCM24→S32 | 1,764,000 | 1.32 ms | 1.33 ms | 1,764,016 | yes |
| float32 | 1,764,000 | 1.01 ms | 1.05 ms | 1,764,016 | yes |
| mu-law | 882,000 | 1.58 ms | 1.59 ms | 882,016 | yes |
| MS ADPCM | 441,232 | 1.70 ms | 1.72 ms | 441,248 | yes |
| IMA ADPCM | 441,378 | 3.43 ms | 3.46 ms | 441,400 | yes |

Live heap ≈ decoded size + ≤ 24 B. One measurement gotcha, run down with a
pure-malloc control (`529b-evidence/growdiag.c`): TLSF pool GROWTH costs a
one-time 8-byte used sentinel per grown segment — zero SDL involvement — so
the perf tool warms the pool to its high-water mark before its baseline.
Source cost: adapted TU 73,846 B + header 6,351 B inside compiler.js.
B stays `heavy` — no reclassification proposed.

## REDs (on exact base `36e6a26f`, before any change)

`529b-evidence/red-723-transcript.txt`: call form and address-taken form both
fail `Undeclared identifier 'SDL_LoadWAV'` (exit 1); `mksdlindex --check`
green with `SDL_LoadWAV` in the mechanically-verified ABSENT list. The fill
inverted the pin in the same change (the PRINCIPLES.md two-sided edit):
`SDL_LoadWAV` left the ABSENT list (whose generation gate would otherwise
REFUSE), joined the audio group + `see` anchors, and `SDL_LoadWAV_IO` is now
pinned absent in its place. `os/doc/sdl-gucos.md`'s "does not exist yet"
stanza became usage guidance; image.json bumped 274 → 275 (baked docs
changed).

## Deliberate omissions / boundaries

- `SDL_LoadWAV_IO`: ABSENT (no public `SDL_IOStream`; absence is honest).
  Now mechanically pinned absent by mksdlindex.
- `SDL_HINT_WAVE_*`: the store round-trips the names but this loader never
  consults them (frozen 3.4.0 defaults, documented in the header + ledger).
- `os/sounds.h` migration: NOT done, per the proposal ("optional, strictly
  after B is green, only if fire-and-forget lifetime stays identical") — a
  follow-up decision, not silently skipped.
- Genuine >2 GiB WAVs and true size_t-overflow REDs are unreachable from
  honest small files on ILP32 (declared divergence A2); the overflow guards
  are upstream-verbatim and the lying-length fixtures pin the reachable
  clamping behavior.

## Counter-pass (review round 1: RED, two blocking findings — both FIXED with one mechanism)

The independent review (thread `01a01c50-…`) confirmed the adaptation,
provenance, and 92/92 differential independently (it rebuilt the oracle and
re-derived every row), and returned two real findings against the demand-link
hook. Both were fixed by ONE change rather than rebutted, because a fix
strictly better than the available rebuttal existed:

1. **Function-only generality (blocking).** `demandSymbolWanted` read only the
   function decl lists, so a variable-keyed `__require_source_if` silently
   never fired. **Fix:** the decision now reads the AST REFERENCE BAGS
   (`referencedFunctions`/`referencedVariables` — pure on-demand AST getters,
   the same bags `gcSectionsPass` walks), and suppression consults
   `definedVariables` alongside functions/imports. Variables now fire and
   suppress exactly like functions.
2. **Mode-dependent cost (blocking).** Under `--no-fold`/`--no-undefined` the
   old decl-list read degraded to always-link: +458 B and the decoder TU's
   compile cost for non-referencing programs (reviewer's tip-vs-base
   measurement). The bag read alone was NOT sufficient: those modes skip the
   per-TU tree-shake, and this linker demands a definition for EVERY surviving
   declaration — a **pre-existing property of the modes**, measured on the
   base compiler with no #723 code (`529b-evidence/mode-matrix-counterpass.txt`:
   any unused undefined declaration is a link error there). So the fix has a
   second half: **a conditional declaration that never fired is WITHDRAWN**
   before link (bodiless decls dropped — exactly what the default-mode
   tree-shake would have done; user definitions keep theirs; referencing
   programs fired anyway). Result, on the reviewer's exact test file
   (`tests/unit/sdl_get_ticks/main.c`), tip-vs-base: **cmp exit 0 in ALL THREE
   modes** (default 18,407 B; `--no-fold` 22,771 B; `--no-undefined` 22,116 B —
   identical to the reviewer's base figures). The "degrades to always-link"
   caveat is deleted with the behavior.

Reference-route determinations the review asked for, proven behaviorally in
`test_sdl_loadwav_diff.js` (16 legs now):

- **EInitList / designated initializers bubble**: `static struct ops O =
  { .load = SDL_LoadWAV }` fires (the bag getters recompute from current
  children, so the parser-mutated init lists are covered) — proven, not
  assumed.
- **Dead STATICS cannot over-link in default mode**: the per-TU tree-shake
  prunes them (and static globals) from the very lists the bag walk reads,
  BEFORE the demand check runs — so this is "not fired", not
  "fired-then-stripped". Proven by the dead-static leg.
- **An extern-linkage never-called function DOES fire** — its reference is
  real until the whole-program link decides its fate (per-TU cannot know), so
  this is deliberately CONSERVATIVE: the TU compiles (cost paid) and the
  dead-literal prune sheds every byte (leg proves zero decoder bytes shipped).
  Under `--no-fold`, dead statics fire too — consistent with a mode whose
  point is keeping everything.
- The variable-keyed test legs key on `__sdl_wave_alloc_countdown`, the
  subject of follow-up **#727** (the production-linked-seam class, filed to
  cover #722's `__sdl_audiostream_failalloc` and this seam together). If #727
  later moves or renames the seam, those two legs break FROM THAT COUPLING,
  not from a demand-link regression — re-key them to whatever variable the
  decoder TU then defines.

The P2 (seam production-linked) was REBUTTED and the rebuttal accepted: a
test-build-only seam would mean the shipped decoder is not the decoder the
injection suite tested, and #722's identical seam is already in main —
filed as #727, one decision for the class.

## Second counter-pass (re-review round 2: RED, one blocking finding — FIXED)

The re-reviewer found a real C **linkage bug** in the first counter-pass:
demand suppression (and the withdrawal pass, which repeated the identical
test) treated ANY `definedVariables` entry of the keyed spelling as a
program-wide definition — including **internal-linkage (`static`) file-scope
variables**, which cannot define, satisfy, or conflict with an external
symbol of the same spelling in another TU. Reproduction: an unrelated TU with
`static int SDL_LoadWAV = 7;` made a legal SDL_LoadWAV-calling TU fail
`Undefined symbol` at link.

**Root cause — a data-model asymmetry worth remembering:** the FUNCTION lists
are split by linkage (`definedFunctions` vs `staticFunctions`), but the
VARIABLE lists are NOT — the parser routes only `EXTERN` declarations to
`externVariables`, so **`definedVariables` holds external AND static
file-scope objects: it is the analogue of `definedFunctions` PLUS
`staticFunctions`**. "Treat variables exactly like functions" was the right
intent applied to the wrong list shape. The next person touching these lists
will make the same assumption — hence this paragraph.

**Fix:** one linkage-aware helper, `demandSymbolDefined` (external-linkage
definitions and imports only; a `static` variable is excluded by an explicit
storage-class check), now used by BOTH suppression and withdrawal — the two
sites had drifted into the same bug twice, so they no longer have separate
copies of the test to drift.

**Class answers** (asked by the review, answered empirically on the defective
tip before fixing, all pinned as legs in `test_sdl_loadwav_diff.js` — 20 legs
now):

- **Static FUNCTION shadow: was NEVER broken.** Suppression reads
  `definedFunctions`/`importedFunctions`; a `static int SDL_LoadWAV(void)`
  lives in `staticFunctions` and never suppressed. Correct by list
  construction — proven on the defective tip (`ok len=100`) and pinned as a
  leg anyway.
- **`importedFunctions` is linkage-correct:** an IMPORT is a host-provided
  external symbol by nature (`StorageClass.IMPORT` — there is no static
  import), and linking the builtin over one would produce a duplicate.
  Suppressing on imports stands.
- **Withdrawal's name-only filters on `externVariables`/
  `localExternVariables` cannot hit a different legitimate symbol:**
  withdrawal only runs when the name is unreferenced (the bags) and not
  externally defined, an extern declaration of exactly that spelling in that
  state is dead weight (precisely what the default-mode tree-shake removes),
  and internal-linkage entities of the name live in lists withdrawal never
  touches (`definedVariables`, `staticLocals`).
- **The withdrawal drift site was live**, not theoretical: the same static
  shadow plus a NON-referencing SDL TU under `--no-fold` reproduced the
  undefined-symbol error on `b9ca346c` (withdrawal skipped for the same wrong
  reason) — fixed by the shared helper and pinned as a leg.

**Deliberate non-fix, per the coordinator:** `git diff --check` flags trailing
whitespace / EOF blanks in the committed pristine upstream copies
(`529b-evidence/upstream/`). Those bytes are upstream's, byte-for-byte, and
the SHA-256 provenance plus `adapt.mjs`'s regeneration property depend on
them staying exact. They stay.

**Honest gap declared by the re-review, not yet closed:** the seven
first-counter-pass legs (and by extension the three new linkage legs) have
not each been mutation-broken to prove red-control sensitivity. Not claimed
proven.

## Third counter-pass (re-review round 3: RED — the CLASS closed, not the instance)

Round 3 found the mirror image of round 2: the **reference** side (`bagHas`)
still matched by spelling, so a live reference to an internal `static` of the
keyed spelling falsely FIRED the conditional source (compile cost paid; bytes
hidden by the dead-literal prune — which is also why the bytes-based legs
missed it). Rounds 1–3 were one disease: **the mechanism identified symbols
by SPELLING where C identifies them by linkage.**

**The class fix: external-linkage symbol identity throughout.** The parser's
unit decl lists encode scope and linkage at construction (verified at the
push sites, table in the code comment): `definedFunctions` /
`staticFunctions` / `importedFunctions` / `externVariables` /
`localExternVariables` are linkage-pure; `declaredFunctions` and
`definedVariables` are MIXED (a `static int f(void);` forward decl lands in
`declaredFunctions`; file-scope static objects land in `definedVariables`);
**locals, params, and static locals are on NO list at all**. So
`externalNodesNamed(X)` builds the set of AST decl nodes that DENOTE the
external symbol X (mixed lists storage-class-guarded), and firing tests the
reference bags by **node identity** against that set. A reference the parser
resolved to an internal static, a static local, a parameter, or a block-scope
auto can never fire, whatever it is spelled — the parser already did the
scope resolution; the mechanism now respects it.

**Every comparison site in the mechanism, enumerated** (the review's demand —
what identity each uses now):

1. `externalNodesNamed` — the ONLY spelling comparison left, used to BUILD
   the identity set from linkage-known lists (explicit `storageClass !==
   STATIC` guards on the two mixed lists; guards also on the pure lists
   where a storage class exists, as drift-proofing). Never classifies a
   reference.
2. `bagHas` (firing) — **node identity** (`Set.has`) against
   `externalNodesNamed(X)`. No names.
3. `demandSymbolDefined` (suppression, shared with withdrawal) — names over
   `definedFunctions` (external-pure by construction; guarded anyway),
   `importedFunctions` (imports are external by nature — there is no static
   import), and `definedVariables` (mixed; guarded). Linkage-sound.
4. Export directives — fires on `ext.has(decl)` (identity). Two declared
   fallbacks: a resolved decl not on any list fires on
   name + non-static (defensive); a directive with NO resolved decl fires on
   the bare name — **deliberately conservative and loud**: an export
   surfaces an externally-visible symbol, so an unresolved one can only be
   satisfied by the demand source. A directive that resolved to a static
   does NOT fire (the static satisfies the export internally). The round-4
   review established the no-decl fallback is currently UNREACHABLE
   (`parseTokens` pushes an export directive only when lookup resolves a
   DFunc) — it stays as declared defensive depth, not live surface.
5. Withdrawal filters — `declaredFunctions`/`localDeclaredFunctions` by name
   with an explicit **keep-statics guard** (a static forward declaration of
   the spelling is a different symbol whose decl→definition pairing must
   survive — this was a live fourth instance found while closing the class,
   pinned by the `fwd_static` leg); `externVariables`/`localExternVariables`
   by name alone, which is identity-exact because those lists are
   EXTERN-pure by construction.
6. `conditionalSources` dedup and `requiredSources.has` — string comparisons
   of directive ARGUMENTS and source names, not symbol resolution. No
   linkage dimension exists there.

No site relies on unstated list purity; the one bare-name site (export
fallback, no decl) is declared and conservative-loud, never silent.

**The instrument fix** (the review's second point): bytes-based legs cannot
distinguish "never compiled" from "compiled then pruned". The suite now
carries ADMISSION legs — each keys a conditional on a deliberately MISSING
source, so `unknown required source missing_723_probe.c` is a loud oracle
for "the demand fired". Eight probe legs: external ref fires (the
instrument's own positive control), static var (round-3 repro) / static fn /
block-scope local do NOT fire, block-scope `extern` DOES fire, dead
extern-linkage fn fires (the conservative case, now PROVEN not claimed),
dead static does not fire in default mode, and the static forward-decl
pairing survives withdrawal. The bytes-based legs remain for the bytes half
of the contract, renamed to claim only what they measure. 28 legs total.

**Extra instances found and closed while sweeping the class** (not in the
review): block-scope locals/params of the keyed spelling falsely fired
(no linkage — now unreachable by construction), and withdrawal could strip a
static forward declaration (see site 5).

**The round-2 regression leg's instrument** (reviewer supplement): the
`shadowvar` leg pins SUPPRESSION, and for that claim run-success is the
direct signal (a wrongly-suppressed demand is a loud undefined-symbol
failure, which pruning cannot fake) — its comment now says so. The ADMISSION
half of the same shape is pinned by the missing-source probes: `p_staticvar`
(single-TU) and the new `p_crosstu` (the exact cross-TU rooted-accessor
shape under the admission oracle).

**Corroborated independently by the re-review** (bounded "in the paths
inspected", not exhaustive — recorded as such): `importedFunctions` is
populated only with `StorageClass.IMPORT` DFuncs (supports
import-is-external-by-nature), and no concrete wrong withdrawal of
`externVariables`/`localExternVariables` was found.

**Mutation-sensitivity campaign** (full ledger:
`529b-evidence/mutation-ledger.txt`): six mutations, each reintroducing a
defeated disease, run against the 31-leg suite with cmp-verified restores.
M1 (name-based reference matching, the round-3 disease) initially produced
**ZERO reds** — every probe leg's external-identity set is empty, so the
ext-set-emptiness fast path masked the spelling comparison; the `p_identity`
leg was added in response (unreferenced extern decl of the spelling keeps
the set non-empty under `--no-fold`; rooted internal-static reference must
still not fire) and is now the one leg that pins node-identity matching —
RED under M1, green on correct code. M2 (round-2 disease) reddens 3 legs,
M3 (round-1 disease) 2 legs, M4 (withdrawal disabled) 4 legs, M6 (mechanism
replaced by `return false`, the #718 vacuity analogue) 16 legs including the
whole differential. Legs not mutation-broken are enumerated in the ledger
rather than implied covered.

**Round-4 correction — the original M5 claim was WRONG.** This log (and the
ledger) originally said M5 (the withdrawal keep-statics guard removed)
reddens nothing and that the guard is "contractual, not behaviorally
load-bearing / unpinnable-by-behavior". The round-4 review disproved it with
a probe my selection missed: a static forward declaration of the keyed
spelling that is **never defined**, compiled `--no-fold`. With the guard the
linker's real diagnostic survives (`Undefined symbol 'probe_m5'`, no wasm);
with M5 the declaration is withdrawn and the undefined internal function
**silently disappears** (exit 0, wasm emitted). The guard is load-bearing —
it preserves a compiler diagnostic — and M5 is directly pinnable. My two
probes both supplied a later definition, which is precisely the input on
which the guard is unobservable: the zero-red conclusion came from
incomplete probe selection, not from the guard's nature. Pinned now by the
`p_m5_undef_static` leg (probe verbatim from the review; RED verified under
M5). The round-4 re-audit of the other "declared not proven" entries under
the same lens converted two more to pinned — M7 (suppression dead → both
user-definition suppression legs RED on duplicate definitions) and M8 (the
alloc-injection seam disarmed inside the embedded TU → the unit sweep's
pinned site counts collapse, RED) — leaving only two entries with
principled coverage stories (the byte-witnesses delegate their byte half to
#722's own pinned prune controls; the comparator red controls are
self-testing by construction). Standing lesson, now general per the
coordinator: **"unpinnable" carries the same evidentiary burden as
"covered"** — it requires showing the discriminating probe does not exist,
not that one's own probes did not fire.

## Suites run

- At `5c10caa8` (pre-counter-pass tip): the coordinator's authoritative FULL
  gate ran GREEN — 26 suites unfiltered/unresumed, kernel 192/192, sweep
  65/65 (preserved at `~/git/meta/meta/notes/723-evidence/
  control-5c10caa8-GREEN/`), so any red on the counter-pass tip is
  attributable to the fix. Author-side at that tip: host, unit, todos,
  blockfs, and all 19 py categories green.
- At the counter-pass tip: host suite (incl. the 16-leg differential), unit
  `sdl_load_wav`, `test_audio_e2e.js` solo, and the three-mode cmp matrix —
  green; the coordinator re-gates the tip in full.
