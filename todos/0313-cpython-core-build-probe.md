# 0313 — M0 probe: can our compiler build CPython core? (throwaway, decision-maker for the pygame arc AND for un-parking 0117 R2)

- **Status**: DONE — **verdict YES-BUT**. Full report:
  `logs/2026-07-27/cpython-m0-probe.md`.
- **M1 update (2026-07-28)**: the ladder's M1 is now **M1-clang** — funded by
  decider call executing jku's python-clang lean (meta note
  `fable-decider-python-primary-2026-07-27.md` §jku LEAN), designed in
  `todos/CPYTHON.md`, executed by `todos/0340` → `todos/0331`. The clang
  toolchain sidesteps the 0336 startup wall; the our-compiler `/bin/python`
  stays gated on 0336 (+ a post-0319 re-link per the reprobe harness) and
  inherits the same vendor tree when it lands.

## Answer (2026-07-27)

**YES-BUT.** CPython 3.13.5 compiles with `compiler.js` (7 MB wasm, 173 TUs,
23 s) and the result runs `python -c "print(1+1)"` → `2` and reports
`sys.version` 3.13.5. Verified against a pristine, un-instrumented CPython tree.
A clang+wasi-sdk-25 `python.wasm` was built first as a positive control, so
every failure below is attributable to us.

Front end: **200/205 core TUs** parse (the 5: `socketmodule.c` needs
`netinet/*`, and 4 are legitimately-empty Tier-2 TUs). Link: 419 → 0.

The three upstream premises (wasm32-wasi tier 2, pthread stubs, no-dlopen
`Modules/Setup`) were **verified against the 3.13.5 source** before any build;
all three hold. Citations in the report.

**Punch-list, classified — nothing "genuinely infeasible":**

- compiler defects (each with a minimal repro): `todos/0319` (P0, compound
  literal in a declaration initializer clobbers the caller's stack frame — the
  one real miscompile), `todos/0320` (P0, preprocessor stack overflow at ~70k
  tokens), `todos/0321` (P0, `static` re-declared after its definition becomes
  undefined — 168 of 173 link errors)
- compiler strictness / compat: `todos/0323` (cross-TU declared-type mismatch
  rejected — P1, confirmed by @master; becomes a HARD PREREQUISITE once an M1
  CPython port is funded), `todos/0322` (empty TU)
- missing libc surface: `todos/0324` (`<stdatomic.h>`), `todos/0325` (the
  CPython + numpy libc gap list, grouped by whether a port can configure around
  each)

**numpy: answered at compile-stage confidence; not linked, not run.** The key
finding is that implementing C99 `_Complex` is **not** a prerequisite — numpy
2.x already has a struct-complex path gated on `__cplusplus`; extending 7 guard
sites to `|| defined(__STDC_NO_COMPLEX__)` took the sweep from 5/164 to
**83/164** TUs with zero compiler changes. Of the remaining 81, 33 are the
probe harness's missing generated headers, not numpy findings.

**Abandon trigger: did not fire**, and the shape was the opposite — the list
shrank monotonically and converged in a day, not two weeks.

**`todos/0117` R2: KEEP PARKED.** R2 was parked on exactly one question — is a
real CPython `/bin/python` buildable. M0 says yes, so the condition resolved in
the direction that keeps R2 parked. Caveats: M1 is unfunded, and the route is a
decider call jku has not ratified — if he overturns it, R2 un-parks immediately.
0117 **R1 is unaffected** and stays foregrounded.

Nothing vendored, no `bin.json` entry, no `os/image.json` bump, no rebake.

---

- **Original status**: open
- **Difficulty**: heavy (timeboxed 1–2 weeks — **abandon is a valid, cheap outcome**)
- **Design**: this file + `~/git/meta/meta/notes/pygame-design-passes-synthesis.md`
  (the consolidated result of four Fable design passes, 2026-07-27). **Read the
  synthesis before starting** — it carries the numbers this ticket only summarises.
- **Provenance**: **(jku ask)** for the goal — *"My other ultimate goal is kind of
  to allow Pygame games to run unmodified on gucOS. Basically, I have friends who
  make games in Pygame."* The *route* (real CPython rather than a MicroPython C-API
  shim) is a **(decider call)** from Fable design pass A at ~85% confidence,
  routed to jku and not objected to. He may still overturn it.

## Why this ticket exists, and why it is a PROBE and not a project

Pass A's recommended route to "real pygame games run unmodified" is **real CPython
+ real pygame-ce, compiled by our compiler, running as ordinary gucOS processes**
(~2.5–3.5 months total). Every downstream milestone (M1 `/bin/python`, M2 SDL
groundwork, M3 pygame-ce, M4 breadth) is worthless if the very first step is
impossible. So M0 deliberately front-loads the highest-risk item:

> **Can our compiler compile CPython core at all?**

Nothing else in the arc gets funded until M0 answers. M0 is **throwaway by
design** — build it in `/tmp`, do not vendor anything, do not add a `bin.json`
entry, do not touch `os/image.json`. The deliverable is a written ANSWER with
evidence, not code we keep.

**M0 also gates `todos/0117` R2.** 0117 R2 (MicroPython stdlib breadth) is
currently PARKED specifically because a real CPython `/bin/python` would supersede
it. If M0 says CPython is not buildable, **R2 un-parks immediately as the real
plan** and jku's existing approval of the module-selection approach carries over
without a re-ask. That conditional is the reason 0117 R2 is parked rather than
cancelled — record it wherever you report M0's result.

## What the design passes already settled (do NOT re-litigate these)

0117's three standing objections to CPython were re-argued with citations and
mostly dissolve. Take these as inputs, and *verify them against upstream as your
first cheap step* rather than re-deciding them:

- **threads** — CPython has an upstream-maintained **wasm32-wasi tier-2,
  single-threaded** build using pthread **stubs** (cpython#90473, #111046).
  `import threading` imports; `Thread.start()` raises. That is an upstream config,
  not our invention. (todos/0006 still stands: threads genuinely do not work —
  they fail LOUDLY, which is the acceptable shape.)
- **no dlopen** — the WASI build **is** a no-dlopen static-extension build
  (cpython#115983); `Modules/Setup` is the mechanism, and pygame-ce would link the
  same way.
- **configure-less** — hand-write `pyconfig.h` starting from the WASI one. This is
  a bounded chore and it is the same hand-listed `bin.json` path that sqlite, lua,
  busybox and NetSurf all took in this repo.

Also settled and **OUT of scope**: the CPython-C-API shim over MicroPython (passes
A and B agree, ~90% confidence — `mp_obj_t` is not a pointer, so borrowed refs
have no owner to pin against; 313 distinct CPython API symbols; unbounded
correctness tail). **HPy is a dead end** (dormant since Oct 2023, alpha, no
MicroPython backend, no pygame port). **`.mpy`/dynruntime is a red herring** (no
wasm native-code arch, no dlopen). Do not spend probe time on any of these.

## Plan — highest-risk-first, with an explicit abandon trigger

1. **Cheap upstream verification first (hours, not days).** Confirm the
   wasm32-wasi tier-2 config, the pthread stubs, and the `Modules/Setup`
   static-extension path actually exist upstream as described. If any of the three
   is materially misstated above, **stop and report** — the route's premise moved.
2. **Get CPython core through the front end.** Hand-write `pyconfig.h` from the
   WASI one; drive our compiler over the core sources. Expect a **conformance
   punch-list** — CPython core is ~500–800k LOC, bigger than sqlite and comparable
   to NetSurf, which this repo has already absorbed (NetSurf's own probe surfaced
   3 P0s, which is the order of magnitude to plan for).
3. **Triage every failure into: compiler defect / missing libc surface / genuinely
   infeasible.** This classification IS the deliverable. A raw failure count is
   not an answer; "these 6 are compiler defects, here are the reduced repros" is.
4. **Get to a running `python -c "print(1+1)"` if the punch-list allows.** That is
   the success signal. Falling short is fine if the punch-list is characterised.
5. **FOLDED-IN PROBE — can our compiler build real numpy?** Nobody has costed
   this: pass A assumed numpy away, and pass C answered the *ulab* question inside
   a MicroPython framing that the route choice makes moot. numpy is a large C
   extension with heavy C99 float semantics and its own build generation, so it is
   a genuinely different stress than CPython core. **This is a probe, not a study
   — do NOT spawn a design pass for it.** Note that pass C's corpus work found the
   numpy need "unambiguous given the unmodified goal" (it counted games importing
   numpy for their own logic — grids, physics, noise — not just `surfarray`), and
   pass A's "small minority, not on the critical path" was **withdrawn**. So a
   numpy answer materially changes the arc's cost.
6. **ABANDON TRIGGER (state it before you start, honour it):** if at 2 weeks the
   punch-list is still growing faster than it is shrinking, or if any single
   failure is classified "genuinely infeasible" and is load-bearing, **stop and
   report the abandon** rather than extending. A clean abandon at 2 weeks is a
   SUCCESS for this ticket — it un-parks 0117 R2 and saves ~3 months.

## Acceptance

- A written report answering **yes / no / yes-but** with the punch-list, each
  entry classified (compiler defect / missing libc surface / infeasible) and each
  compiler defect reduced to a minimal repro **and filed as its own ticket**.
  A gap that does not enter `todos/` does not exist.
- An explicit **numpy** answer at the same confidence level, or an explicit "did
  not reach numpy, here is why" — do not let it silently drop off the end.
- An explicit **recommendation on 0117 R2**: un-park it, or keep it parked, with
  the reason.
- **Nothing vendored, nothing in `bin.json`, no `os/image.json` bump, no image
  rebake.** If you find yourself wanting to keep the build, that is a follow-up
  ticket (M1), not this one.
- Work in a **worktree** (`~/worktree/c-compiler/cpython-m0`) — other lanes are
  live in this repo.

## Notes

- `todos/LIABILITIES.md` is machine-checked by the `todos` suite. If your change
  rewrites a line anchored by a register entry the gate goes RED — re-anchor or
  retire it in the same commit.
- Related: `todos/0117` (MicroPython — R1 foreground, R2 parked on THIS ticket),
  `todos/0314` (statement-body inlining — the performance lever this arc would
  eventually lean on), `todos/0006` (threads), `todos/SDL3.md` + `todos/0224`
  (the SDL/main-loop story — note 0224 already shipped the cooperative
  `SDL_Delay`, so the "blocking `while True:` loop" is **not** a risk).
