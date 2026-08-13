# PRINCIPLES — contract-anchored correctness and honest implementation shape

**Status: SET IN STONE (jku, 2026-08-13).** This document is canonical for how work in
this repo is classified, prioritized, designed, and reviewed. `CLAUDE.md` carries the
compact normative form and points here; this file carries the full text, the decision
tests, and the reasoning.

> **jku, 2026-08-13, verbatim (email uid 928):**
>
> *"There are two core principles I want:*
>
> *1. Correctness as per what the APIs promise (eg what kernel calls or SDL interface
> says in their docs). So delay taking a bit longer than what you ask isn't the end of
> the world.*
>
> *2. Implementation shape being honest as possible and not taking it. We shouldn't be
> forcing ugly implementation to meet specific behavior. We should be exposing what is
> available as cleanly as possible and match the interface where appropriate but if the
> interface simply doesn't match we shouldn't implement it. Perhaps implement with
> alternative api. But also prefer APIs that already exist to novel ones.*
>
> *Make sure these principles are set in stone … Make sure this is the highest priority
> work. This organization is critical to knowing what work is actually good to do"*

Prior art, and the seed of this document:

> **jku, 2026-08-04, verbatim** (`todos/GAMEDEV-EPIC.md`, "API honesty"): *"It's better
> to not implement at all or have a custom API rather than incorrectly implement or lie
> with API."*

The VLA ruling — *real C VLA or none; never a fake* — is the same principle applied
earlier, and remains binding.

---

## PRINCIPLE 1 — CONTRACT-ANCHORED CORRECTNESS

**Statement.** Correctness is judged against what the documented contract of the API
actually promises — the standard's text, not folklore, intuition, or the caller's hopes.
Behavior the contract explicitly permits (lateness, jitter, implementation-defined
limits, unspecified ordering) is **not a correctness defect**, however unpleasant. It may
still be a **quality defect** worth fixing — but it is filed, prioritized, and reviewed
as one.

### Definitions

- **Contract violation** — the implementation does something the documented contract
  forbids, or fails to do something it requires. Examples: a sleep that returns *early*
  without a reported interrupt; a function returning success while not performing its
  documented effect; `malloc(0)` diverging from this repo's own documented semantics.
- **Quality gap** — behavior inside the contract's permitted envelope that harms real
  use. Example: `usleep(16000)` taking 22.5 ms.
- **Absence** — the symbol or feature does not exist. An absence is **honest**: it fails
  loud at link time. It is never a correctness defect; it is a feature gap.

### The permitted-lateness envelope, verified from primary sources (2026-08-13)

- **POSIX `nanosleep`** (The Open Group): *"The suspension time may be longer than
  requested… But, except for the case of being interrupted by a signal, the suspension
  time shall not be less than the time specified."*
- **POSIX `usleep`** (SUSv3, obsolescent): *"The suspension time may be longer than
  requested due to the scheduling of other activity by the system."*
- **SDL3 `SDL_Delay`** (wiki.libsdl.org): *"waits at least the specified time, but
  possibly longer due to OS scheduling."* `SDL_DelayPrecise` exists upstream as the
  precision-named sibling — a different name for a different promise.
- **SDL3 `SDL_SetRenderVSync`**: *"When a renderer is created, vsync defaults to
  `SDL_RENDERER_VSYNC_DISABLED`."* Unsupported values return `false` and set
  `SDL_GetError()`.

Note the shape of the last two: **the standard itself distinguishes a best-effort delay
from a precise one by giving them different names.** That is Principle 2 practiced by
the standards body, and it is the pattern to copy.

### Decision test (run at filing time, in order)

1. **Name the governing contract** and quote or cite the specific promise. If you cannot
   name one, you are asserting a quality expectation — say so explicitly.
2. **Does observed behavior violate that promise?** Yes → contract defect (P0 under the
   priority policy). No → step 3.
3. **Is the behavior permitted but harmful to a real, articulated use?** Yes → quality
   gap: file at P1/P2 with the harm **measured**. No → step 4.
4. **Is the complaint really "the API I want doesn't exist"?** → feature gap. File as
   feature work, never as a bug.

### Anti-patterns

- *"It feels broken so it's P0."* The P0-bug-first rule is potent precisely because it is
  scoped; laundering quality gaps into it dilutes the queue's strongest signal.
- Retitling a permitted-lateness finding as a "correctness defect in a shipped POSIX
  primitive" to win priority.
- **The mirror error:** using *"the contract permits it"* to dismiss a measured, harmful
  quality gap. **Principle 1 reclassifies; it never buries.** A 60 Hz game loop running
  at 44.5 fps is a real, epic-critical problem — as a quality defect.

### Exceptions and boundaries

- Where this repo has **deliberately chosen** semantics (`CLAUDE.md` "Semantics decisions
  already made"; `malloc(0)` non-NULL; `fork` → `posix_spawn`), **the repo's documented
  choice IS the contract.** Do not re-litigate it against upstream.
- A permitted behavior can still violate **a different** contract: overshoot is fine for
  `usleep`, but if gucOS ever ships a precise-delay API, *its* documented precision binds.
- **A platform crash from userland is always P0-class**, regardless of any API contract
  (`todos/OS.md`). A stability contract outranks an API contract.

---

## PRINCIPLE 2 — HONEST SHAPE (platform-fit implementation)

**Statement.** An implementation's shape must be honest about what the platform cleanly
exposes. Do not build ugly machinery to mimic behavior the platform cannot naturally
support. Prefer the platform's native primitives and existing repo seams over novel
mechanisms. Where a standard interface *fundamentally* mismatches the platform, do not
falsely implement it: either do not expose it (absence is honest), expose it with an
explicit reported failure, or expose a **differently-named** custom API that tells the
truth about what it is.

### Definitions

- **Cleanly exposes** — the platform has a primitive whose semantics match the
  interface's promise. The compositor's `requestAnimationFrame` **is** a display clock;
  `setTimeout(16)` is **not**.
- **Falsely implementing** — reporting success for semantics you do not deliver (claiming
  vsync while merely coalescing frames), or silently changing a documented default.
- **Ugly machinery** — cross-layer coupling built to fake a semantic: sleeping inside a
  transport function, per-process shadow clocks, busy-waiting inside a general sleep.

### Decision test (run at design time)

1. **What platform primitive carries this semantic natively?** If one exists, the
   implementation must be a thin, honest mapping onto it.
2. **If none exists:** can the semantic be delivered *correctly* another way at
   acceptable complexity? Then build that, at the right level of generality. (The CORE
   PRINCIPLE governs how *well* you build; this principle governs whether the shape
   *lies*.)
3. **If it cannot be delivered correctly:** refuse loudly, return documented-unsupported,
   or design a custom-named API. **Never approximately implement a standard name.**
4. **Layering check:** does the change put policy in a transport, a clock in a timer, or
   app semantics in a kernel seam? Any yes → redesign.

### Anti-patterns

Success-reporting stubs; silent default changes; per-layer duplicate clocks; busy-waiting
a general sleep to fake precision; "it passes the demo" shapes; and — the subtle one —
**implementing the letter of a standard API on a substrate that inverts its spirit** (a
synchronous `SDL_RenderPresent`-blocks-for-vsync on a GPU transport that needs the
worker's event loop is a deadlock dressed as conformance).

### Exceptions and boundaries

- **Scoped-but-honest subsets are fine when the boundary is explicit** (standing jku
  position): the SDL_ttf classic API without `TTF_Text`; the win32 veneer's loud
  `ERROR_CALL_NOT_IMPLEMENTED` stubs. **The boundary must be declared, not discovered.**
- **A capability-selected backend behind one honest contract is fine.** The contract stays
  one; the machinery may vary.

- 🔴 **Declared benign degradation is a fourth honest option** *(Amendment A, Pass 2;
  prior art: winmm `SND_RESOURCE` silent success, `SND_LOOP` plays once)*. A
  standard-named symbol may report success without delivering its full effect **ONLY when
  ALL FOUR hold**:
  1. the divergence is **declared** at the declaration/docs and in the compat ledger;
  2. it is **inventoried loudly at least once at runtime** (the `WIN32_UNSUPPORTED`
     one-shot is the model);
  3. the return is **non-load-bearing** — no caller decision or downstream semantic rests
     on the faked effect, beyond the absence of the effect itself;
  4. the choice is **argued from the caller's harm**, in writing.

  **A timing, pacing, or synchronization semantic is always load-bearing**, so
  vsync-by-coalescing can never pass this gate. An undeclared or unreported degradation
  remains a success-reporting stub — forbidden. Enrol each such decision in
  `todos/LIABILITIES.md` rather than opening a new ledger.

- 🔴 **Resource backpressure at a transport seam is not a semantic claim** *(Amendment C,
  Pass 2)*. Clamping or coalescing to protect a finite platform resource (the #484/#551
  GPU producer gate) is honest **so long as no API reports vsync or pacing semantics
  because of it**. The boundary: **backpressure protects the platform and stays invisible
  to the API contract; vsync is a promise to the application and must be explicit,
  opt-in, and real.**

### Why per-process animation clocks are rejected *(Amendment B, Pass 2)*

Not because the API is absent — **worker `requestAnimationFrame` has been Baseline since
March 2023**, and the older "nested workers get no rAF" phrasing is stale as a
platform-API claim. The three real grounds are:

1. a synchronous blocking wasm main loop **starves its own worker's event loop**, so rAF
   callbacks cannot fire in exactly the processes that need pacing;
2. N per-process clocks compete with the compositor's one real display clock — **one
   display, one clock**;
3. this repo's own measurement (`todos/0100`) found no working rAF in this nesting in
   practice.

**Ground 1 is structural and sufficient on its own.**

---

## PART 2 — IMPLICATIONS FOR PROCESS

### Filing

Every defect ticket **names its governing contract** and classifies itself as one of:

`contract-violation` | `quality-gap` | `feature-gap` | `stability`

A quality-gap ticket states the **measured harm** and the permitted-envelope
acknowledgment in the same breath.

🔴 **A mechanism claim in a ticket body is a HYPOTHESIS until someone re-derives it from
current source — label it as one.** This is not a theoretical risk. Ticket #492 asserted
the path `sdlDelay → pumpWait → kernel FS_WAIT`; the actual substrate is
`Atomics.wait` timeout-expiry in the process worker, and `FS_WAIT` is a different path
entirely. Ticket #500's premise was stale against #551. Ticket #560's premise had already
been fixed on main. **Cite the file and line you read, and the commit you read it at.**

🔴 **An absence assertion is a MAINTAINED CLAIM with an owner.** An absence is honest
(Principle 1), but a *test that pins an absence* becomes stale the moment the absence is
honestly filled — and it goes red at exactly the moment someone does the right thing.
Live specimen, 2026-08-13: a gcode-orientation check asserting *"absent symbols: SDL_Log,
SDL_snprintf, SDLK_r, SDLK_R all fail as undeclared"* turned the gate red when #601
implemented `SDL_Log`. **Filling an absence is therefore a two-sided edit:** implement
the symbol *and* retire or invert the assertion that pinned its absence, in the same
change.

### Priority

- **P0** = contract violations in shipped features, platform-stability breaks, and
  broken-build preemption.
- **Quality gaps** default to **P1** when epic-critical, **P2** otherwise.
- **Nobody self-promotes a quality gap to P0 by rhetorical reclassification.** jku can
  promote anything in one sentence.
- Do not silently demote an existing **user-set** priority — establish provenance first.

### Acceptance criteria

State acceptance in the contract's own terms, **split by instrument**:

- **Contract assertions** — hard and binary (*"never returns early absent EINTR"*).
- **Quality targets** — statistical (*"p99 overshoot ≤ X ms on the reference box, by the
  committed ladder"*). Never a mean alone; percentiles or it is not a measurement.
- **Display-cadence assertions** — in **ticks**, not milliseconds.

**A quality target going red is a quality red, not a "correctness regression."** The words
matter for the next bisect.

### Implementation review checklist

Add to the reviewer's pass (and to the implementer's self-check):

1. Does any **standard-named** symbol report success for undelivered semantics?
2. Does the change **silently alter a documented default**?
3. Does **policy leak into a transport**, or **a clock into a timer**?
4. Is every **refusal path loud and named**?
5. Does the diff's **claimed mechanism match the source's actual path**?
6. If the change **fills an absence**, does it also retire the assertion that pinned it?

---

## How these compose with the rules already in force

- **vs the CORE PRINCIPLE (build to the goal, not to the demo).** No conflict — two
  orthogonal axes. Build-to-goal governs **breadth** (do not cut in-scope generality);
  honest shape governs **fidelity** (do not fake what the platform cannot carry).
  Build-to-goal's escape hatch gains a third, sharper exit: **fundamental platform
  mismatch**, where the honest answers are refusal, documented-unsupported, or a custom
  API — and choosing one of those is **not** scope-cutting, because a false implementation
  was never in scope. **The tell:** scope-cutting deletes capability the platform *could*
  carry; honest refusal declines capability it *cannot*.
- **vs P0-bug-first.** Principle 1 **sharpens** it rather than weakening it: reserving P0
  for contract violations and stability breaks restores the rule's signal value.
- **vs gamedev primacy.** No tension. Scheduling is (epic filter → weight tier) with `Pn`
  only breaking ties, so reclassifying a ticket off P0 does not deprioritize its subject.
- **vs the "useful, expected, not-too-difficult" pass filter.** Honest shape is the
  **fourth leg**: an expected API that can only be implemented dishonestly gets a
  discussion ticket, not an approximate implementation.

---

## Provenance

Ruled by **jku, 2026-08-13, email uid 928**, which mandated the three-pass shape that
produced this document:

| Pass | Model | Thread | Role |
|---|---|---|---|
| 1 | Fable (`claude-fable-5`) | `019ff9ec-b877-7812-9ef3-ced488fad612` | Drafted the principles and the decision tests. **Read-only.** |
| 2 | Fable (`claude-fable-5`) | `019ff9f4-53e7-74fc-8a5e-da0d5a1eb90f` | Adversarially verified Pass 1; contributed Amendments A–D. **Read-only.** |
| 3 | Opus (`claude-opus-5`) | `019ff9ff-ddcd-70a9-a087-bd0f833c862a` | Landed this document; audited the open queue for violating assumptions. |

Full pass transcripts (preserved verbatim, nothing elided):
`~/git/meta/meta/notes/principles-pass1-decision-2026-08-13.md` and
`principles-pass2-decision-2026-08-13.md`. The ruling chain and the Pass 3 open-queue
audit are in `principles-decision-2026-08-13.md` and
`principles-audit-open-queue-2026-08-13.md` in the same folder.

All repository claims in this document were verified against `main` at **`13d059ba`**.
