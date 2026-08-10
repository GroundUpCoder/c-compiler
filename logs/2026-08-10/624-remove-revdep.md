# #624 — `gucman remove` grows the reverse-dependency guard

`gucman remove freetype` with win32 installed used to succeed and silently
break win32's srclib compile — the failure surfaced later as undefined-symbol
errors that read like a broken install. The forward direction (remove win32
does NOT cascade into freetype — FT-SURVIVES) was already deliberate; this is
the missing reverse half. Remove now refuses, names the dependents, and takes
`--force` as the explicit override. The check is generic over the `deps`
graph; no package name appears in the code.

## The design question: where does the guard read `deps` from?

Measured, not assumed:

- **The install DB record did NOT store deps.** `gm_install_one` composes the
  record field by field; `deps` lived only in the repo index.
- **`/opt/<name>/control.json` does not carry deps either** — os-common's
  `packageControl` emits name/version/summary/bin/openwith/commands/menu/
  fonts (+desktop/srclib/seed/scripts). So there was NO offline deps source
  at all, for any installed package.

Decision: record `deps` in the DB record at install (the index entry's array,
`[]` when absent — "known: no deps"), so the guard is offline like the rest
of remove. The record member sits after `sha256`, never last, so a
line-oriented reader of the pretty print is safe.

**Legacy records** (every package installed by shipped ≤ v251) carry no
`deps` member — exactly the users already holding the dangerous state. Those
resolve through the repo index ONCE per remove, and the answer is BACKFILLED
into the record (atomic rewrite), so the DB converges to offline-correct. A
record the index cannot resolve either (unreachable repo, or the package is
no longer published) has UNKNOWN edges — and unknown is not "no dependents":
the remove refuses conservatively, naming the unresolvable records and the
three ways out (go online once, remove them first, `--force`). Post-#624
records never touch the network on remove.

## Gotchas found on the way

- A `--force` removal + reinstall of a shared-tier creator (freetype under
  win32) permanently orphans the srclib **tier-dir recording**: the reinstall
  finds `/usr/local/{include,src}` alive under the dependent's plants and
  never re-records them, so no later remove rmdirs the tiers. Pre-existing
  semantics (any remove+reinstall interleaving did this before #624 too, and
  `--force` makes it reachable again); the e2e's session D therefore asserts
  refusal only and proves `--force` on the synthetic session-RD edge, which
  leaves no shared state. Worth a ticket if tier-dir orphaning ever matters.
- The positive control (test legs vs the pre-#624 binary) fired 19 reds —
  the instrument demonstrably detects the missing guard.

Tests: session D refusal legs + session RD (synthetic `test-rdapp →
test-rdlib` via a private `--packages-dir` fixture repo, third serve.js):
generic refusal, dependent-first ordering, legacy fallback + backfill,
offline refusal off the backfilled record, cannot-verify refusal, offline
`--force`. gucman.c is a bake input → image.json 251 → 252.
