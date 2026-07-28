# 0392 — NetSurf B: runtime binding probe + a MEASURED HTML/CSS/JS support statement replacing the inherited README claims

- **Status**: open
- **Priority**: 2
- **Difficulty**: medium
- **Blocked by**: `0389`, `0390`, `0391` — this deliverable is the **product of A**, plus its
  own probe. It cannot be written before the corpus numbers exist.
- **Design**: `~/git/meta/gucos/notes/netsurf-corpus-plan.md` (work-stream **B**).
- **Provenance**: jku human-origin 2026-07-28 → router `019fa6e2` → meta-gucos `019fa6e6` →
  filed by master cont-130.
- **Feeds**: `0290` (Lane D binding fills). 🔴 **Do not duplicate `0290` — measure FOR it.**

## Goal
Two things, one ticket:
1. A **targeted monkey probe** that answers, at RUNTIME: do `querySelector` / `requestAnimationFrame` /
   canvas `fillRect`|`beginPath` actually **execute, throw, or silently no-op**?
2. **Replace the inherited HTML/CSS/JS support claims** in `vendor/netsurf/README.md` (and the
   meta docs: the kickoff, the corpus plan, `gucos/notes/netsurf-probe-findings.md`) with
   **measured numbers** from `0389`/`0390`/`0391` plus this probe.

## What is ALREADY RESOLVED — do not re-litigate, do CONFIRM at runtime
Read from the binding **bodies** (meta-gucos, 2026-07-28), so these are source-confirmed:
- **No-op stubs** — declared in IDL, code-generated, validate args, `return 0`, **no binding
  body, do not even throw**: the vector canvas API
  (`fillRect`/`strokeRect`/`beginPath`/`fill`/`stroke`/`setLineDash`),
  `requestAnimationFrame`/`cancelAnimationFrame`, `querySelector`/`querySelectorAll`.
- **Real hand-written bodies** (carry a `#line ....bnd` marker): `getImageData` / `putImageData`
  — blitting into the canvas backing bitmap (`priv->bitmap`) then `redraw_node`. ⭐ **That is
  the ONLY working canvas route.**
- **Genuinely absent**: `getBoundingClientRect`, `offsetLeft` (source comment `uievents.idl:43`).

🔴 **This is UPSTREAM NetSurf's state** — `nsgenbind` emits a stub when the `.bnd` has no body.
**Our port did not strip anything.** jku has already been answered on canvas/rAF by email.

⭐ **THE LESSON THAT MAKES THIS TICKET NECESSARY: `genjs` symbol presence proves NOTHING.**
`genjs/duktape/` *contains* generated functions for all of the above, which made "absent" look
wrong. Reading the bodies settled it the other way. **Read the body / check for a `#line ....bnd`
marker — never infer capability from a symbol name.** The probe exists to confirm this at
runtime rather than by inspection alone. [[extending-a-claim-launders-its-mechanism]]

## Plan
1. Probe each declared-but-suspect binding at runtime; record execute / throw / no-op per symbol.
2. Collect the A1–A3 counts.
3. Rewrite the support statement — HTML parse, CSS, JS — **in numbers**, and delete the
   inherited prose claims it supersedes.

## Acceptance
- A per-symbol runtime verdict table: **executes / throws / no-ops**, one row per binding.
- 🔴 The probe carries a **POSITIVE CONTROL** — a binding known to work (`putImageData`) must
  register as *executes*. A probe whose "everything no-ops" result could also be produced by a
  broken probe is worthless.
- `vendor/netsurf/README.md`'s support claims are **replaced**, not appended to.
- 🔴 **Any bound stated LOUDLY IN NUMBERS.** No "ran 200 of 6000 and called it done."
- Unblock costs for rAF and canvas-vector are recorded **for `0290` to fund** — 🔴 **measure
  BEFORE funding; do not hand-pick canvas+rAF in a vacuum, that is building to a demo.**
- `todos/LIABILITIES.md` re-anchored or retired in the same commit.
