# #595 — mkpkg version-ordering guard (a downgrade must be stated, never silent)

`tools/mkpkg.js`'s additive upsert (#580) assigned a rebuilt entry straight
over the previously published one — no version comparison anywhere in the
file. Publish `cpython-clang` 0.9 after 1.2 shipped and every gucman client
was offered 0.9 as current, silently. Tolerable while the only publisher is a
human at a terminal; fatal once #596's intake pipeline makes the publisher an
unattended host-side step, where nothing between an in-OS `version` edit and
the served index looks at the number at all.

## What landed

- **The guard** sits at the upsert in `main()`: a rebuilt entry whose version
  orders strictly below `prev.packages[n].version` refuses at exit 1, naming
  the package and both versions (the schemaVersion guard's shape). The index
  publishes by atomic rename at the very end, so a refusal leaves the served
  repo untouched — verified by the test re-reading `index.json` after each
  refusal.
- **The comparison rule** (`verCompare`): rpm/dpkg-style token comparison,
  chosen because published versions are free-form `[A-Za-z0-9._-]+` in
  practice ("0.10.5", "1.28-3", "15.0.06", "9f", git SHAs like "1a706d7") —
  a semver library would reject most of the real set, and a string `<` gets
  the ticket's own headline case backwards ("0.10" < "0.9"). Versions split
  into digit runs and letter runs (`.`/`_`/`-` delimit and vanish); digit
  runs compare numerically (leading zeros stripped: "06" == "6"), letter runs
  ASCII-lexically, digits outrank letters, and a proper token prefix is older
  ("1.0" < "1.0.1").
- **Equal is not a downgrade.** Every routine rebuild republishes the
  unchanged version over itself — that is the payload-reuse path's whole
  reason to exist, and every deploy rebuilds the full set at mostly-unchanged
  versions. The guard refuses only a STRICT decrease; reading the ticket's
  "non-increase" literally would have broken every deploy on day one.
- **The override**: `--allow-downgrade`, documented in the usage block. A
  rollback is a real operation; only a *silent* one is the bug. Git-SHA-style
  versions have no meaningful order, so a legitimate SHA move that trips the
  guard uses the same escape.
- **Test**: `tests/serve/test_mkpkg_version_guard.js` (host suite, registered
  in tests/host/run.js) drives the real tool through a publish sequence:
  fresh, equal republish, refused downgrade (index proven untouched), stated
  rollback, `0.9 → 0.10` increase and `0.10 → 0.9` refusal (the two-digit
  case, both directions), prefix ordering both directions, and the
  leading-zero equality republish.

## minBase: not this guard, and no new ticket proposed

The ticket asked for an assessment. `minBase` is already policed at both
ends — build-side, buildPackage refuses a declared value that is not an
integer in `[0, current image version]` (#518, pinned by
`test_mkpkg_minbase.js` plus its pure-data lint), and install-side,
`gucman.c` refuses a package whose `minBase` exceeds the running base's
os-release VERSION_ID. What it does not have is a monotonicity invariant for
this guard to borrow: across publishes it legitimately moves in BOTH
directions (an undeclared minBase tracks the rising image version by #518
design; a declared over-claim gets corrected downward). The residual risk is
semantic — "does the payload really run on the claimed base" — which no
publish-time comparison can adjudicate. So: not in this guard, and no
concrete hole left that merits its own ticket.
