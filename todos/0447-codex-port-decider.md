# 0447 — codex on gucOS: port `codex exec` or write a native client on the same wire protocol

- **Status**: open
- **Design**: `todos/RUST.md` §4 — this ticket **is** unit **D1**. §1 carries the goal and
  §3 carries the six invariants that bind any answer here.
- **Blocked by**: `todos/0445` (hard). See "Why this is filed blocked" below — the gate
  named in `RUST.md` is satisfied, and it is **no longer the whole gate**.
- **Provenance**: filed by @master (cont-216) on 2026-07-30, after `todos/0417` merged
  (`1cc04833`) and gucOS image v199 shipped. `RUST.md` §4 held D1 as "named but not filed";
  a unit that never enters `todos/` does not exist, so it is filed here rather than left in
  prose.

## 🔴 READ FIRST — this ticket decides, and it must not pre-judge

The question is **port `codex exec`** versus **write a native gucOS client that speaks the
same wire protocol**. `todos/done/0418-rust-std-decider.md` §"Result" item 9 recorded a
refusal to pre-judge that choice, and this ticket inherits that refusal. **Neither arm is
the expected answer.** A lane that arrives already preferring one has failed before it
starts.

`RUST.md` §4: *"A decision taken without those inputs is a guess."* That sentence is the
whole reason this ticket is blocked rather than ready.

**The deliverable is a ruling document, not an implementation.** Write no Rust and no
port. Nothing in `os/`, `kernel.js`, `host.js`, `tools/` or `packages/` changes. The ruling
files the follow-on implementation tickets; it does not do their work.

## Why this is filed blocked, and what the gate actually is

`RUST.md` §4 states two inputs: the `todos/0418` ruling and `todos/0417`. **Both are now
discharged** — 0418 merged and ruled option (b), wasip1; 0417 merged and shipped in image
v199. On the letter of that sentence this unit is ready.

🔴 **The letter is stale, because the gate list was written before `todos/0445` existed.**
0445 was filed 2026-07-30 at jku's request, and its own text states its purpose: *"This
ticket produces MEASUREMENT, so that when D1 is filed the decision rests on numbers instead
of an estimate."* 0445 is therefore an input to this ticket by its own definition, and it
has not run.

What 0445 closes is not a detail. The 2026-07-29 census partitioned 838 crates in the
`codex-exec` graph for `wasm32-wasip1` and left **class D = 197 crates unmeasured** — and
**83 of those are codex's own workspace crates**, which are the actual subject of a port.
The probe never reached one of them. ⇒ **Today, nobody has measured whether codex's own
crates compile for this target.** A port-versus-native ruling made now would rest on an
estimate of exactly the quantity that decides it.

This is the `(FA)` failure mode recorded in `~/git/meta/meta/notes/master-traps.md`: a
ticket's input list ages, a different ticket becomes a genuine input, and the original list
still reads as satisfied. **Do not unblock this ticket by re-reading `RUST.md` §4 and
observing that 0418 and 0417 landed.** That is the trap.

## 🔴 Premises — MEASURED versus ASSUMED

Per `(FC)`: a framing premise is a claim. Verify every ASSUMED item before you rule, and
say so in the ruling if one fails.

**MEASURED (evidence in the tree; cite it, do not re-litigate it):**

1. Rust runs in gucOS on a **stable** compiler for `wasm32-unknown-unknown`
   (`todos/RUST.md` §5, `todos/done/0413`).
2. `gucos-sys` is the single Rust binding to the `"c"` ABI (`todos/done/0414`).
3. A real `-rust` tool works over BlockFS (`todos/done/0415`).
4. The standard-library path is **`wasm32-wasip1`**, a stable tier-2 target; **no path in
   this program needs a nightly compiler** (`todos/done/0418`, ruled option (b)).
5. An HTTP transfer is an **ordinary fd**, waitable through `select`; the `HTTP_READ` and
   `HTTP_CLOSE` opcodes are retired (`todos/done/0417`, shipped in image v199).
6. Of 838 crates: 543 compiled (A), 76 host-only (B), 22 failed (C), **197 unmeasured (D)**
   — the 2026-07-29 census, `~/git/meta/gucos/notes/rust-p0-codex-wasm-census.md`.

**ASSUMED — check each one, and re-derive it against the tree at the time you rule:**

1. That the wasip1 shim (`todos/0442`) covers what codex actually calls. 0442 is not
   closed, and its own `(FA)` pass found that "an unserved import fails loud" is free from
   the engine while its Plan step 1 asks for `ENOTSUP` stubs — **a stub cannot also
   `LinkError`**. The split now recorded in 0442 is: served-but-meaningless ⇒ present,
   returns `ENOTSUP`; not-in-the-shim ⇒ absent, `LinkError`. Read 0442's current body; do
   not carry this paragraph.
2. That codex's transport can reach the gucOS HTTP ABI at all **from Rust**. 🔴 It cannot
   today — see the reopen trigger below.
3. That "the same wire protocol" is a settled, documented surface. Derive what it is from
   the codex source; do not accept the phrase as a specification.
4. Any crate count, file path or symbol you inherit from this ticket body or from a census.
   Re-derive them at the head you rule against. A measured map is valid only against the
   tip it was measured on.

## 🔴 The 0446 reopen trigger — HTTP from Rust is broken right now

`todos/0446` records that `~/git/gucos-rust/crates/gucos-sys/src/http.rs` still binds the
**pre-0417** id-based HTTP ABI. Two of its three breaks are a loud `LinkError`; the third
(`__http_status`) still links and changed semantics **silently**. The module is latent and
uncalled today, so nothing that ships is broken — but **there is no working Rust HTTP
caller in this program.**

HTTP is codex's core transport, so this touches **both** arms of the decision: a native
client needs it directly, and a port needs it because `wasm32-wasip1` has no sockets, so
codex's HTTP must be redirected onto the `"c"` ABI regardless.

0446 is **not** a hard blocker — the ruling can price the work without it having landed.
But:

- The ruling **must** state, for the arm it selects, how HTTP is reached, and it must cite
  0446 as the prerequisite rather than assume a working binding.
- The ruling **must** carry an explicit **reopen trigger**: if 0446 lands and shows the
  Rust HTTP surface costs materially more than the ruling assumed, the ruling is reopened.
  This mirrors how the 0418 ruling parked its option C with a trigger instead of cutting
  it.

## Plan

1. Read the closed inputs first: `todos/done/0418` §Result (all items, not just item 9),
   `todos/done/0417`, and `todos/RUST.md` §1 and §3 in full. The six invariants in §3 are
   binding on both arms — in particular **no third namespace**, **one libc**, **one heap**,
   **the sibling repository produces, this tree consumes**, and **the base image ships no
   Rust**.
2. Read `todos/0445`'s output — the closed census with class D resolved. That output is the
   numeric basis of the ruling. If a number you need is still null there, say so and name
   it as unmeasured; do not fill it with an estimate.
3. Derive the wire protocol from the codex source. State where it is defined, whether it is
   versioned, and what a second implementation would have to track over time.
4. Build the two arms as costed options, each with its own risk list. For each arm state:
   the crates that must compile, the wasip1 surface it needs from `todos/0442`, how it
   reaches HTTP (with 0446 priced in), what it means for the byte-identical base image
   guarantee (`RUST.md` §3 rule 5, guarded by `todos/0416`), and its maintenance load
   against upstream codex churn.
5. Consider and record any third option you find. Park it with a reopen trigger rather than
   cutting it if it is not selected.
6. Rule. Then file the implementation tickets the ruling implies, with
   `node todos/queue.js next-id` for their ids and correct `--blocked-by` edges.

## Acceptance

- A ruling document lands in this tree, and `todos/RUST.md` §4 is updated so that unit D1
  points at this ticket and at the ruling. `RUST.md` must no longer describe D1 as unfiled.
- The ruling **selects one arm and states the reasoning**, or states that the inputs remain
  insufficient **and names precisely which measurement is missing**. "Insufficient" is an
  acceptable outcome only with that name attached.
- 🔴 **The ruling rests on the numbers from `todos/0445`, and cites them.** A ruling whose
  decisive claim is an estimate fails this ticket, even if its conclusion is later correct.
- 🔴 **The ruling names what would CHANGE it.** State the reopen triggers explicitly,
  including the `todos/0446` trigger above. A ruling with no reopen condition is not a
  ruling; it is a preference.
- 🔴 **Every ASSUMED premise in the section above is checked, and the result is recorded —
  including the ones that hold.** A premise that turns out false must be reported loudly,
  not resolved quietly in favour of whichever arm keeps the conclusion alive
  (`(ES)` in `~/git/meta/meta/notes/master-traps.md`).
- The ruling addresses each of the six `RUST.md` §3 invariants for the selected arm, by
  name. An arm that breaks one is rejected or the invariant is explicitly renegotiated with
  its own record.
- The follow-on implementation tickets are filed, with ids from `node todos/queue.js
  next-id` and dependency edges set, and `node todos/queue.js check` returns rc 0.
- No code lands. The gucOS base image is untouched and the deliverable is prose plus
  ticket edits. Report that no image bump occurred.
- The ruling is written in ASD-STE100 simplified technical English, as a document jku
  reads.

## Notes

- Two repositories are in play. The Rust crates live in the sibling `~/git/gucos-rust`;
  this tree consumes artifacts and never invokes `rustc` (`RUST.md` §3 rule 4). Per the
  `(FE)` lesson, when a change spans both, ask what the consumer actually **reads** and
  whether that thing is under version control — an `out-image/`-style build output is not,
  and no git-level check will report it.
- `todos/0445` is the hard blocker. `todos/0442` (the wasip1 shim) is not a blocker, but a
  ruling made before 0442 closes must treat its coverage as ASSUMED, per the premise list.
