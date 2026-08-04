# #428 — narrowing the `os/` diff-rule triggers, and the pre-deploy full sweep

**Branch** `ticket-428` off `origin/main` @`481421fb`. Ticket #428 (P1, light),
filed off the headless-under-Node investigation
(`~/git/meta/gucos/notes/headless-node-architecture-2026-08-02.md`, §6), bumped
P2→P1 by the 08-03 midday decider and named by #446 as "the load-bearing saver".

## The complaint

`tests/run.js` RULES had one line for the whole reference OS build:

```js
[/^os\//, ['kernel', 'sweep'], 'seeded OS sources restale the image; e2e + browser cover it'],
```

`os/` is where nearly all light gucOS work lives, and the heavy lock makes
kernel and sweep mutually exclusive machine-wide, so "targeted green"
degenerated into the full heavy pair (~17 min + ~19 min, serialized) for
exactly the tickets that are meant to be cheap.

## What I would NOT do, and why it matters more than what I did

The ticket's framing invites dropping `sweep` from `os/` broadly and leaning on
a pre-deploy sweep for the residue. **I declined that**, and the decline is the
main finding of this lane.

The premise for a broad narrowing is the investigation's §5 fidelity claim: the
sweep's *unique* coverage is compositor furniture, page lifecycle, the DOM
shell, pointer lock, GPU transport, serving semantics, and real event timing —
everything else is duplicated by the 89 headless e2es that drive full OS boots.
That claim is about what the sweep *uniquely tests*. It is not the same claim as
"a change under `os/` cannot break the sweep", and the estate has a recent,
concrete counter-example: on **2026-08-03**, batch #1 (`batch1-gate` @49f20e1a)
went **kernel-green 151/151 and sweep-RED** — `os-paint.mjs` failed on a
`waitPixel` TEAL probe because #434's `os/image.json` Desktop-launcher removal
re-flowed the icon grid. Product bug or test-pin gap is beside the point: the
sweep held an assertion about the composed image that no headless test held, and
a broad narrowing would have hidden it.

So the bar I used is the one in the kickoff, taken literally: **a path only
loses a suite when that suite is structurally BLIND to it** — not "unlikely to
catch anything", not "covered elsewhere in practice". Blind.

## What actually qualifies

gucOS has two hosts over one kernel: the browser page (`os.html` + its workers +
the WebGPU compositor) and the headless Node twin (`os/boot.js`). Six files
under `os/` belong to exactly one host **and** are not bake inputs. Both halves
are needed — "not loaded by the other host" alone is not enough, because a file
that becomes blob bytes is observable through the image even if nobody `require`s
it.

| path | host | other suite's blindness |
|---|---|---|
| `os/os.html` | browser page | `boot.js` is its twin; no kernel test opens it |
| `os/osk.js` | browser page | reached by one `<script src>` in `os.html` |
| `os/compositor.js` | browser page | headless never constructs one — `wmScreenshotScreen` is its twin |
| `os/kernel-worker.js` | browser page | `boot.js` is its twin |
| `os/process-worker.js` | browser page | `kernel.js`'s `BOOT_SOURCE` is its twin |
| `os/boot.js` | headless Node | no browser test loads it |

The "not a bake input" half is **not asserted by me**: `os-common.js`'s
`BAKE_INPUT_SKIP` already declared five of the six runtime-only, and
`tests/host/test_bakeinput_sources.js` pins that with an independent scan over
the fat manifest. I used that as the oracle rather than re-deriving it.

Verifications behind the table, done by grep rather than assumed:

- `tests/lib/image-fixture.js` and `serve.js` bake through `tools/mkimage.js`,
  never `os/boot.js` — so no browser boot comes out of `boot.js`. The only
  mention of `boot.js` anywhere under `tests/browser/` is a comment.
- No kernel-suite or `os/boot.js` reference to `os.html` / `osk.js` /
  `compositor.js` / `kernel-worker.js` / `process-worker.js` except comments and
  the bake-input pin itself.
- `osk` appears in **no** manifest (`os/image.json`, `packages/*.json`) — it is
  page glue, not blob content.

**`os/os.html` keeps one extra suite:** `tests/serve/test_first_run.js` (host
suite, seconds) asserts serve.js advertises and serves `/os/os.html` 200. That
is a real, cheap observation of a rename/delete, so the rule is `['sweep',
'host']` rather than `['sweep']`. Naming it costs nothing and a silent
`os.html` rename would otherwise survive to a browser boot.

`os/welcome.html` deliberately stays wide: despite the name it is **not** page
glue — it is the netsurf package's start page (`/opt/netsurf/res`), i.e. blob
content, consumed by `test_netsurf_content_e2e.js`.

## Mechanics — why a negative lookahead

Rules UNION, so a later rule cannot SUBTRACT from `^os/`; the shared rule has to
not match the six in the first place. The exception list is one array
(`OS_BROWSER_ONLY` + `OS_HEADLESS_ONLY`) and the shared regex's lookahead is
*built from it*, so the lookahead and the carve-out rules cannot drift.

Two prophylactic rules already in the table — `^os/ksvc(/|\.js$)` and
`^os/gcode/`, both added "explicit so a future `^os/` rule split can't orphan
it" — did exactly their job: this is that future, and both paths still resolve
to kernel+sweep from either rule.

## `osk.js` joins `BAKE_INPUT_SKIP`

Scope-adjacent, and I judged it in-scope rather than left as a note: the rule
comment claims `osk.js` is runtime-only, so the estate's *other* statement of
"runtime-only" must agree or the narrowing rests on a premise the freshness gate
contradicts. It was simply missed when the OSK landed (the doc comment says
"os.html, boot.js, the workers, the compositor"). Verified not-blob-content
above. Side effect: an `osk.js` edit no longer forces a ~3-min rebake of a blob
whose bytes it cannot change.

## Guards — both directions, both red-controlled

Under-gating is silent by construction; a plan that got shorter looks exactly
like a plan that got shorter *correctly*. So the guards assert the wide half,
not just the narrow half:

- `tests/host/test_diff_rules.js` — each of the six selects its own host's suite
  and **not** the other's; each named file **exists** (a stale exception stays in
  the lookahead and would silently pre-narrow a future file that takes the name);
  and, quantified over a **real walk of `os/`** (142 paths, IGNORE-dropped docs
  excluded), every other path still draws BOTH heavy suites. Eight of the
  tempting ones (`wm.c`, `image.json`, `term/term.c`, `win32/user32.c`,
  `ksvc/ksvc.c`, `gcode/gcode.c`, `os-common.js`, `keys.h`) are named explicitly
  too, because a walk-driven assertion goes vacuous if the walk breaks.
- `tests/host/test_bakeinput_sources.js` — cross-checks `tests/run.js`'s
  exception list against the independent bake-input scan. A file narrowed
  without being runtime-only fails here, in a different file, on a different
  mechanism.

**Red control** (deliberate over-narrowing: `wm.c` added to `OS_BROWSER_ONLY`):
`test_diff_rules.js` → 2 FAIL, `test_bakeinput_sources.js` → 1 FAIL. Both
restored green after reverting.

## Evidence — before/after, positive and negative controls

`planFromDiff` on the pre-edit tree vs post-edit (same module `--diff` uses):

| path | before | after |
|---|---|---|
| `os/os.html` | kernel, sweep, todos | **host, sweep, todos** |
| `os/osk.js` | kernel, sweep | **sweep** |
| `os/compositor.js` | kernel, sweep | **sweep** |
| `os/kernel-worker.js` | kernel, sweep, todos | **sweep, todos** |
| `os/process-worker.js` | kernel, sweep | **sweep** |
| `os/boot.js` | kernel, sweep | **kernel** |
| `os/wm.c` | kernel, sweep, todos | kernel, sweep, todos |
| `os/image.json` | kernel, sweep | kernel, sweep |
| `os/term/term.c` | kernel, sweep | kernel, sweep |
| `os/win32/user32.c` | kernel, sweep, todos | kernel, sweep, todos |
| `os/ksvc/ksvc.c` | kernel, sweep | kernel, sweep |
| `os/gcode/gcode.c` | kernel, sweep | kernel, sweep |
| `os/os-common.js` | host, kernel, sweep, todos | host, kernel, sweep, todos |
| `os/welcome.html` | kernel, sweep | kernel, sweep |
| `os/keys.h` | kernel, sweep | kernel, sweep |

And through the authority itself, `node tests/run.js --diff --dry-run`, one path
at a time:

- **positive control** `os/wm.c` → `todos, kernel, sweep` (unchanged — a
  browser-affecting change still pulls the sweep)
- **positive control** `os/os.html` → `todos, sweep, host` (still pulls the
  sweep; only the blind suite left)
- **negative control** `os/boot.js` → `kernel` (sweep dropped)

## Honest sizing — this is NOT the multiplier #446 hoped for

#446 calls #428 "the load-bearing saver". Measured, it is not. It saves one
heavy suite on **six files**. The classes it actually helps are real and
recurring — mobile/OSK, VT tabs, zoom/hires, the fullscreen button, compositor
work all live in `os.html`/`osk.js`/`compositor.js`, and every one of those
lanes now skips ~17 min of a kernel suite that could not have failed because of
them; `boot.js` work skips ~19 min of sweep. But the class #446 was actually
paying for — `wm.c`, `term/`, `win32/`, `image.json` — is **unchanged, by
decision**, and neither was #368's 51-minute gate an `os/` diff at all (it was
`vendor/netsurf/`, which draws both suites through the fat-fixture radius).

The real throughput lever for that class is #446's own decoupling (one gate per
batch instead of per fix) plus rule 5 below — not this table edit.

## The pre-deploy full sweep (CLAUDE.md rule 5)

The narrowing's safety net, and the half of #428 that carries the weight:

- No gucOS image ships without a full `node tests/run.js all` on the exact tree
  being shipped, `sweep` included, `--filter` unset — even when every merge in
  the batch gated green on its own and none of them selected `sweep`.
- Judged from `build/test-kernel/summary.json` + `build/test-browser/summary.json`
  (`done: true`, `filter: null`, `files.recorded === files.total`, zero
  non-`pass`), never from a runner summary line. Never `--resume`; never carry
  results in from an earlier tree.
- Red ⇒ bisect within the batch, do not ship.

Placed as rule **5** in "Gate cost + gate batching" so it extends #415/#440's
text rather than colliding with it. #446's cadence block (still open at time of
writing) says *how often* a ship happens; rule 5 says *what must be green when
it does*. The two are written to compose, and rule 5 says so explicitly.

## Loose ends I did not take

- `[/^image\.json$/, ['kernel','sweep'], 'the bake manifest']` is anchored at the
  repo ROOT, where no `image.json` exists — the manifest is `os/image.json` and
  is (and was) covered by the `os/` rule. The root rule looks vestigial. Left
  alone: verifying it is dead is a separate question from this ticket's, and
  removing a rule is the wrong direction to guess in.
- The narrowing is per-path and conservative; a genuine broad narrowing of
  `os/**.c` would need the sweep's assertions to be *inventoried* against the
  headless suite's, which is a measurement project, not a table edit.
