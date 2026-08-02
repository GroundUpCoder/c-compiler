# #415 — the gate-cost model + the adopted gate-batching rule, into CLAUDE.md

jku ruled "adopt the gate batching — yes" (2026-08-02), and the rule lived
only in coordinator handoff prose, which lanes never read. It is now a
section of `CLAUDE.md` ("Gate cost + gate batching"), placed directly after
the heavy-suite RAM policy it leans on: the measured suite-cost table, the
heavy-lock ceiling (exit 3, no queue — worktrees parallelise editing, never
the gate), the batching rule with both guardrails (within one suite target;
never `--resume` across a batch; behaviour-neutral only, for red-gate
attributability), the #309+#307+#365 / #111–#116 worked examples, and the
transitive-contention rule (os-gcode.mjs → os-harness.mjs → heavy lock).

One wrinkle vs the ticket text: the ticket says to qualify "the existing
worktree-parallelism guidance in that file" — but `CLAUDE.md` carried NO
worktree guidance at all (grep: zero hits). The convention lives in kickoff
prose, which is the same disease the ticket exists to cure. The new section
therefore states the qualification itself, as the file's first and only
worktree-parallelism text.

The authority line is preserved verbatim in the section, ahead of the
table: the dry-run is the only authority on the mandated suite set, and an
absent `build/test-run/summary.json` means "did not finish", never a green.
