# The *-clang packages are always in the deployed gucman index (todos/0337)

Standing instruction from jku: **no clang package in the base image, every
clang app we build available through gucman.** Half of that was already true;
the other half reverted on every deploy.

## What was actually blocking it

Three separate things, only one of which was the obvious one.

**1. The superset index was opt-in, and the reversion was ACTIVE.** The deploy
repo's build took `--clang` to emit the SUPERSET package index. The failure
mode is not that a deployer *forgets* the flag and the clang apps merely stay
as they were — a plain build orphan-prunes the `-clang` pool blobs and rewrites
`index.json` back to base. So every ordinary deploy REMOVED them. The ledger is
unambiguous: `clang:true` on 3 deploys (all the day it shipped), `clang:false`
on the 41 since. A default that undoes itself at the next deploy cannot deliver
"always", which makes the flag the defect rather than an ergonomics wart. The
fix is the inversion: superset ON by default, opting out explicit
(`--no-clang` / `--base-only`; `build:clang` kept as an alias). A missing
sibling under the default is now a LOUD failure that prints the opt-out — a
mis-provisioned box must never silently ship base, which is the whole point of
inverting rather than just flipping a boolean.

**2. Three published apps had no package definition at all.** The sibling
overlay publishes ten `/usr/bin/*` payloads; `packages/` defined seven.
`gameboy-clang`, `stl4` and `sdldemo` would not have appeared even with the
flag on. They were built, and then reached nobody.

**3. Nothing connected the two sides.** That is the interesting one, because
(2) is a symptom. There was no relation anywhere in the tree between "what the
sibling publishes" and "what we package" — the seven definitions were seven
independent facts. So the gap could not be *noticed*; it could only be
stumbled over.

## The gate

`clangDriftCheck` in `tools/mkpkg.js`: under `--clang`, every `/usr/bin/*`
payload the overlay publishes must be claimed by some `packages/*.json`
`clangApp` entry, checked before anything is built. Two deliberate choices:

- **The gate reads the OVERLAY, not a list of names.** Patching three names in
  would leave the fourth omission exactly as undetectable. Keyed off the
  producer, a new sibling project fails the build the first time it is
  published rather than the first time somebody notices.
- **It gates the whole relation even on a one-package rebuild.** `mkpkg
  box2d-clang` still checks every definition, or a single-package invocation
  would launder the drift away.

Exemptions are explicit and self-checking: `tools/clang-unpackaged.json` keys
a payload to a reason, and an exemption whose payload is gone (or has since
been packaged) fails as stale — a rule nobody re-reads is not a rule. Silence
is never an allowed answer, which is the property that makes this the general
fix and not a patch.

Placement matters as much as the check: with the clang build now the deploy
default, the gate sits on the one path every deploy takes.

## The naming question (stl4 / sdldemo)

`stl4` and `sdldemo` are bare names with no `-clang` suffix. That is correct,
not drift. The sibling's `enforceClangConvention`
(`wasm/tools/mk-overlay.mjs:123`) binds only projects whose `base` is under
`$CC_ROOT/vendor/` — a clang build of something gucOS ALSO compiles with
`compiler.js`, which must get a fresh `/usr/bin/<name>-clang` path so both
toolchains' builds coexist and can be A/B'd. Both of these are in-repo demos of
the sibling itself with no stock twin, so the convention exempts them by its
own rule and there is no name to collide with. No rename is owed — and a
rename would have invalidated published sha256s for nothing.

(Note the convention is a floor, not a ceiling: `box2d-clang`, `imgui-clang`
et al. are also in-repo and take the suffix voluntarily.)

## The ROM the gate could have shipped

The overlay publishes `/usr/share/gameboy/PokemonBlue.gb` alongside
`gameboy-clang` — the sibling's own local bake wants it. The deploy has never
hosted ROMs publicly (it strips the ROM seeds from `image.json` and scans
`dist/` for `*.gb`), so `packages/gameboy-clang.json` deliberately carries the
binary and NOT the ROM; the emulator runs its built-in test ROM bare
(`Using built-in test ROM` / `ROM: TEST`, verified under `host.js`).

But the existing guard would not have caught the mistake. Pool payloads are
content-hashed gzipped tars, so a ROM riding one is invisible to a filename
scan of `dist/`. That was tolerable while clang packages shipped three times
ever; with the superset as the default it is one careless `clangFile` entry
away from a Nintendo ROM on the public origin. The guard now gunzips every
pool payload and walks its ustar member names. The lesson generalizes past
ROMs: a content-addressed artifact defeats every guard that reads file *names*,
so guards have to follow the data into the container.

## Verified

- `mkpkg --clang` against the real sibling: `clang drift: 10 overlay app(s),
  all packaged ✓`; index carries all 10.
- Full deploy build with NO flag: 25-package index (15 base + 10 clang),
  `build-info.json` `clang: true`. The 15 base entries are byte-identical to
  the pre-change index, `baseVersion` 177 → 177, `os/image.json` untouched.
  Nothing `requires` is ever baked — `foldPackages` excludes it by
  construction, so "no clang in the base image" is structural, not a
  convention.
- The three new payloads run: `stl4` prints its report and `OK`; `sdldemo`
  reaches its 30-frame limit and quits; `gameboy-clang` boots its built-in ROM.
- Gate legs in `tests/serve/test_mkpkg_clang.js`: unclaimed app → exit 1,
  explicit exemption → clean, stale exemption → exit 1.
