# #634 — the freshness walks' `*.md` carve-out, removed

Two commits: `6ae47c10` (regression legs, RED by design at that commit) and
`99e7be9a` (the fix). Base `6d48e552`.

## What was actually wrong

`newestBakeInput` and `newestPkgInput` both excluded `*.md` from their
directory walks (`os/os-common.js:2558`, `:2692` — the ticket named one site,
there are exactly two) on the stated premise ".md can't change blob bytes".
\#566 falsified the premise: nine `.md` files are blob bytes today
(`/usr/share/doc/*`, `/usr/share/gcode/GCODE.md`).

The ticket's account — "nothing is broken today" — verified true, but the
mechanism is thinner than the ticket says. The shipped docs are all `bin`
entries, and `bin` entries are statted **directly** by the manifest/package
closures, bypassing the walk. What the ticket's analysis missed: **`text`
entries are os/-relative FILES** (read via `io.readAsset`; inline strings are
the separate `content` kind), and neither the system-section loop (which stats
only `project` + `bin`) nor `scanPackagesDir` (only `project`/`bin`/`tree`)
stats them individually — they rely wholly on the os/ walk, exactly where the
`.md` carve-out sat. So a `text` entry naming a `.md` — the *natural* entry
kind for a doc; #566 used `bin` by convention only — was a genuinely invisible
bake input at base. No shipped manifest has one yet (all 28 real `text`
entries are `.c`/`.h`/`.html`), which is the only reason this was latent
rather than live.

## The fix shape

Drop `.md` from both walk exclusions; keep `.img` and `.img.tmp-<pid>`
(bake OUTPUTS — an output counted as an input perpetually self-stales the
bake). Narrowing instead (e.g. "only baked .md") was rejected: the walk is
dir-granular over-approximation by design, per-extension holes in it are a
class of invisible inputs, and the protective value of this hole was ~nil —
the high-churn `.md` (todos/, logs/, root docs) are not under any walked root,
so the exclusion never shielded them in the first place.

**Added scope, called out:** `newestPkgInput`'s walk gains the
`.img.tmp-<pid>` exclusion `newestBakeInput` already had. Same
output-as-input class, found while deriving: `demos.json`'s os-root project
walks `os/` itself (the leg-D sanctioned exception), where mkimage's blob AND
its atomic-rename temp land — a temp left by a killed bake would have read as
an ever-newer input and perpetually restaled the demos package.

## Measured cost of seeing `.md`

55 `.md` files join the fat-bake closure: the 9 baked docs (already inputs
via their `bin` stats — zero marginal effect), ~34 vendor READMEs,
`os/win32/PORTS.md`, `os/ksvc/spike/README.md`. None is machine-written
during test runs or bakes (`win32ports.js --check` verifies without writing;
mkimage writes only `.img`/`.img.tmp`, both still excluded), so there is no
perpetual-restale path — the cost is one re-bake after a deliberate,
rare doc edit. That is the code's own "when in doubt, re-bake" direction.

## Guards

`BAKE_INPUT_SKIP` (the six runtime-only names) is untouched; the
`test_diff_rules.js` ⟷ `OS_RUNTIME_ONLY` cross-check and
`test_bakeinput_sources.js`'s runtime-only/narrow-scope pins all still hold
(36/36 legs green at the fix). The four new legs failed at base — reproduced
the coordinator's way: detach `6d48e552`, `git checkout 6ae47c10 -- <test>`,
run → 4 FAIL.

## Image bump: none, argued by container

The diff touches `os/os-common.js` (bake logic, not blob content) and a host
test. Blob BYTES are unchanged — a re-bake at the same version produces the
same image, so the browser's version-only gate needs nothing. Node-side, the
edit restales the blob once through the walk (os-common.js is itself an
input) and the fixture re-bakes once; that is the mechanism working. v257 is
tip, prod serves 256 — irrelevant here since no byte changes.

## Residual surfaced to the coordinator (not enrolled)

`tests/run.js`'s `BAKED_DOCS` derivation (#622 — rescues docs-shaped blob
bytes from the docs IGNORE so they price the heavy suites) reads `bin`
entries and package `tree` payloads, but not `text` entries. A future
text-entry `.md` would now restale correctly (this ticket) yet gate zero
suites (#622's original symptom, one axis over). Nothing hits it today —
same latency class as this ticket had. Filed to the coordinator's judgment.
