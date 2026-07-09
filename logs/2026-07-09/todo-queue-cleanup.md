# Queue hygiene: dropped corpses out, sweep 3 numbered, order re-cut

A consistency pass over `todos/` after the Win32 pivot (`WIN32.md`,
`win32-direction.md`) left a few seams. No new work committed — this is
bookkeeping so the queue's own invariants hold again.

## What changed and why

- **`0047` (microui) and `0056` (MVU) moved to `todos/done/`.** Both were
  marked DROPPED by the Win32 pivot but still sat in the open queue,
  breaking the "`ls todos/*.md` is the open queue" invariant. The 0006
  precedent (delete outright) didn't fit — both files carry trade-study
  text that WIN32.md/TOOLKIT.md reference for history — so they keep
  their DROPPED status headers and live in `done/`. README §1 now
  records both conventions: move-with-DROPPED-header when the text is
  worth keeping, delete-with-log-rationale when it isn't.
- **`0064` allocated: WM bug sweep round 3.** The pointer-lock HUMAN
  check has now been deferred by BOTH sweep rounds (0033, 0039) while
  living only in a README parenthetical — "whenever that gets a number"
  was how it kept slipping. It has a number now; the item makes the
  human check the round's non-negotiable, done FIRST while the operator
  is present. Slotted after the Win32 wave (new WM surface worth
  sweeping) but not blocked by it.
- **The unnumbered WebGPU app port demoted to `WEBGPU.md`'s backlog.**
  It sat at slot 3 of the order of attack with no number, no candidate,
  and no owner since done/0016 — by the queue's own rule ("ideas that
  aren't committed work stay in the topic docs until promoted") it
  wasn't queue material yet. WEBGPU.md now carries it with candidate
  criteria; it gets a number when a candidate is picked.
- **`0046` strace bumped from slot 6 to slot 3.** It's near-free
  (the kernel already brokers every syscall; this is formatting) and
  it's exactly the debugging tool you want *while* bringing up the
  Win32 message loop and kernel32 veneer — cheap tools that de-risk the
  expensive work above them go first.
- **The Win32 line now says to stand `0060`'s harness up EARLY.** The
  old arrow notation (0057 → 0058 → 0059 → 0060) contradicted 0060's
  own philosophy: its missing-symbol log is the *authoritative backlog*
  for 0057–0059 ("real demand, not speculation"), which only works if
  the compile-test harness exists before those items are "finished".
  The order of attack now matches the item.
- **`0053`'s independence made explicit.** The README read as
  0052 → 0053, but 0053 rides fetch, not sockets (its own header says
  0052 is not required). Now noted as pull-forward-anytime.

## Deliberately NOT changed

- **SS-INTEROP stays unnumbered** — its doc explicitly self-classifies
  as "exploratory until promoted"; that's the system working, despite
  four design rounds in one day. If a second slice lands, revisit.
- The noted-only micro follow-ups (boot.js flock guard from 0045,
  busybox killall un-guarding) stay where they are — neither warrants
  a number alone; batch into a tail item if they accumulate.
