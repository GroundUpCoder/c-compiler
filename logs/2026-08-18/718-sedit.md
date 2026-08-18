# #718 — native C-aware Source Editor

Base: `eee46a7a979b6f318fd74f2e7d82c6fb043fc6b5` (exact `origin/main` at
kickoff). Epic argument: #713 measured missing syntax highlighting, delimiter
matching and compiler-diagnostic navigation across two real C+SDL3 authoring
loops; this closes that manual edit/build/debug friction without changing the
global vi/notepad defaults.

## Shape

- `gucedit.h` is a private, synchronous, generation-bound styled EDIT ABI.
  Generation is compared against an exact reserved byte snapshot at the
  existing `EN_CHANGE` seam, so legacy no-op notifications do not advance it.
- `sedit` owns C policy. It copies text only from a posted private message,
  scans from byte zero in bounded chunks, and publishes only a complete current
  generation. EDIT stays authoritative for input, selection, undo and paint.
- The file layer accepts regular UTF-8 files up to 8 MiB, records a whole-file
  EOL choice, preserves BOM, follows symlinks, detects external byte changes,
  names the physical target, refuses hard-link breaking without consent, and
  fsyncs a same-directory temp before atomic rename. It does not claim directory
  entry crash durability.
- Navigation deliberately follows current `cc` line-only contracts. CLI uses
  literal-`lstat` first; Ctrl+G accepts a positive line, `FILE:LINE`, or one
  complete error/warning/link diagnostic. Column-shaped diagnostics are loud
  refusals.

## Provenance fence

Implementation and fixtures were independently authored from tracked source
and the approved v2 design. The user-owned untracked `projects/` tree and all
user-owned `tests/browser/*sedit*` paths were not read, run, copied, adopted,
edited, cleaned, staged, or used. `os/sha256.h` is the only reused algorithmic
source; its tracked provenance is retained. No ReactOS Notepad, CodeMirror, or
BusyBox vi code/fixtures were copied.

## RED controls and focused evidence

Exact-base absence controls:

- `git cat-file -e eee46a7a…:os/sedit/bin.json` → 128 (absent)
- `git cat-file -e eee46a7a…:os/win32/gucedit.h` → 128 (absent)
- base image search for binary and c/h associations → 1 (absent)

Development REDs were kept and explained, never retried away: an unparenthesized
mixed logical expression; a line/column grammar ambiguity; a missing browser
launch barrier; tty newline parsing; unsynchronized input under load; and a
missing first-styled-frame barrier. Each correction targeted the observed
instrument rather than weakening acceptance. Browser red logs are preserved by
the suite runner under `build/test-browser/`.

GREEN evidence before candidate gate:

- native project compile: `sedit wasm bytes=626244`
- focused kernel: 3/3 (`test_gucedit`, `test_sedit_core`, `test_sedit_e2e`)
- focused browser: 1/1 (`os-sedit`)
- kernel e2e under load: 3/3, 0% flake
- browser e2e under load: 3/3, 0% flake

The 262,144-byte work cap is a responsiveness mechanism, not a performance or
correctness budget. No machine-time assertion is used.

## Rollback

Remove the v273 image binary, Development menu entry and c/h associations
first; defaults stay `default.gui=/bin/notepad` and `default.term=vi`. Then
remove app/docs/tests. Remove `gucedit.h`/user32 support only after confirming no
remaining tracked consumer. A stale explicit user override continues to name
the missing `/bin/sedit` and fails loudly; removing/replacing that override
restores baked/default resolution.

# Readiness counter-pass (2026-08-19)

The authoritative diff gate exposed two `wmctl` readiness timeouts in the
unchanged Win32 source-library e2e.  Candidate/base attribution made the
failure candidate-specific.  A diagnostic boot preserving the legacy 15 s
waits showed the actual earlier failure: the in-OS compiler could not resolve
`gucedit.h` beside packaged `user32.c`, so neither test binary existed.  The
later readiness markers were unconditional shell echoes.  The styled EDIT ABI
header is now explicitly part of the win32 package's `src/win32` payload, the
same physical tree used by the `win32` source-root mapping.

# Contract-completion counter-pass (2026-08-19)

Independent review found that the first tip's green tests did not cover the
whole approved v2 contract. The corrected mapping is explicit:

- Commands: Search/Find now has both menu dispatch and Ctrl+F, a modal query,
  wrapped next-match selection, and deterministic focus return to the document.
  Headless and headed automation drive the accelerator and dialog lifecycle.
- Save identity: ordinary Save retains the spelling the user opened and
  re-resolves it before every overwrite. Missing, retargeted, inode-changed, or
  same-inode byte-changed targets return the same external-conflict result; the
  UI names the captured physical target before Overwrite / Save As / Cancel.
  The core probe retargets a real symlink and proves both old and new targets
  remain unchanged.
- Atomic I/O: `SeditIOOps` exists only under `SEDIT_TEST`; production binds the
  POSIX operations directly. Executable controls cover partial write, EINTR,
  create/write ENOSPC, chmod/fsync/close/rename failures, cleanup, content-hash
  conflict, hard-link refusal/break, CRLF preservation, explicit mixed-EOL
  choice, BOM, and no-final-newline. The fake selector is absent from baked code.
- Streaming scan: identifier, number, pending slash/comment opener, block-close,
  quote escape, directive continuation, delimiter stack, and byte offset survive
  feeds. Every split of fixed UTF-8/comment/token/delimiter witnesses equals the
  one-feed result. UI work is capped by 32 KiB feeds, 256 KiB per turn, and an
  elapsed 8 ms deadline, with continuation only through posted `WM_RESTYLE`.
- Styled EDIT: batch arithmetic, count, generation, flags, colors, UTF-8
  boundaries, LF crossing, overlap ordering, and BOX single-scalar/tab rules
  live in `gucedit_core.c` and run as a native executable matrix. Replacement
  allocation is commit-after-copy, with executable OOM preservation. Production
  has no test allocator export. Selection owns syntax fg/bg; UNDERLINE/BOX draw
  afterward in `COLOR_HIGHLIGHTTEXT`, so match marks remain visible.
- Generation and lifetime: exact byte snapshots advance only after a real byte
  change; stale batches have their distinct error; invalid and allocation-failed
  replacements preserve the installed batch; destruction frees both snapshot
  and styles. The executable core plus real Win32 headed/headless paths cover the
  reachable halves.
- Navigation/text formats: positive line, FILE:LINE, primary error/warning, and
  link `at` forms pass; zero/overflow/column/multiline/unrelated forms reject.
  UTF-8 validity, mixed EOL choice, BOM, and no-final-newline are byte-asserted.
- Integration/rollback: `/bin/sedit`, Development menu activation, c+h
  associations, Notepad/vi defaults, package source closure, and binary-absent
  resolver rollback remain covered by the original headless/headed acceptance.

The provenance fence remained absolute: no user-owned `projects/` material or
shared untracked `tests/browser/*sedit*` fixture contributed implementation or
test content.

## Counter-pass 3 — exact-target overwrite, atomic locations, independent controls

Same-reviewer re-review of `2a700722` found three remaining contract gaps. The
save conflict detector noticed symlink retargeting, but explicit Overwrite still
published to the captured old physical target. Overwrite now resolves the user
path again at confirmation, takes mode/link policy from that current target,
atomically replaces that target without replacing the symlink, and refreshes the
document identity. Native controls cover Cancel, Overwrite, and Save As and name
the exact target/inode invariants.

Path-bearing Ctrl+G and CLI locations are now distinct from bare line numbers.
Missing paths report a named error, and another document's requested line is
validated before the loaded document is committed. The registered kernel member
drives real Ctrl+G and CLI missing/out-of-range/literal-colon cases and asserts
the original document and caret remain unchanged on failure.

The lexer control now includes a separately written slow scanner which calls no
production lexer helpers. Seeded insert/delete/replace/split/join sequences are
compared after every edit and every feed split. The production pp-number state
admits `+`/`-` only immediately after `e/E/p/P`, with `1+2`, `1e+2`, and
`0x1p-3` as readable witnesses. The I/O fault matrix now executes hash and
cleanup-unlink faults as well as create/write/chmod/fsync/close/rename, asserting
dirty state, exact operation text, unchanged original bytes, and the precise
temp cleanup state after every injected failure.

Selected BOX/UNDERLINE and tab geometry moved into `gucedit_core.c`, the same
seam consumed by production `user32.c`. The executable ABI probe rasterizes the
returned plans and checks exact selected-mark pixels, highlight contrast, tab
stops, and the empty-style no-style pixel control; the prior source-regex mark
claim was removed.

## Counter-pass 4 — current navigation text, published-save state, paint spans

Same-reviewer re-review of `5bc4383a` found four remaining evidence and state
gaps. Bare-line navigation now takes one fresh EDIT snapshot after parsing the
target and uses that same allocation for bounds and offset selection; it no
longer falls back to the loaded document buffer when an edit cancelled the
lexer snapshot. The existing registered Ctrl+G acceptance remains green. An
attempted additive growth/shrink UI control was kept RED while diagnosing
`wmctl` multiline and focus behavior, then removed rather than claiming flaky
evidence; the current-text invariant is enforced directly by the production
snapshot lifetime and line-offset core controls.

Atomic save now distinguishes pre-publication failure from successful rename
followed by identity-refresh failure. Post-rename stat/hash faults return a
published-but-refresh-failed result, retain dirty state, invalidate the cached
identity, and surface a distinct UI title. Cleanup-unlink failure is appended to
the primary failure instead of replacing or hiding it. Native fault controls
assert published bytes, inode and snapshot state, retained temp state, and the
combined primary/cleanup diagnostic.

Styled EDIT now resolves foreground, background fill, selection precedence,
tab geometry, and BOX/UNDERLINE mark output through one complete paint-span
operation consumed by production drawing. The executable probe materializes
those spans into exact pixels and proves syntax fg/bg/underline, selected
highlight precedence, tab-gap background/underline, stale/no-style equality,
and a discriminating styled-vs-default control.

Every seeded randomized lexer schedule is now compared to the independently
implemented reference scanner, not merely to another production feeding mode.
A fixed independently encoded comment/string/delimiter witness and a deliberately
broken reference control prove that token spans and pair maps discriminate the
defect class.

Counter-pass 4 evidence before the authoritative candidate gate:

- standalone core and ABI probes: green
- native `os/sedit/bin.json` compile: green
- focused kernel: 3/3
- focused browser: 1/1 (`os-sedit`)
- kernel e2e under load: 3/3, 0% flake
- browser e2e under load: 3/3, 0% flake

## Counter-pass 5 — durable navigation evidence and invalid identity retries

Same-reviewer exact-tip review of `61ea2895` accepted the source-level current
EDIT fix but required a production-consumed executable seam. Navigation now
routes the one authoritative post-dialog EDIT allocation through
`sedit_navigation_apply`. The native control models immediate post-EN_CHANGE
growth and shrink directly: a newly added fourth line is accepted at its exact
offset, while a removed fourth line is rejected without changing selection or
the status/navigation line. The initial control was captured RED because the
production seam did not yet exist, then GREEN after `prompt_line` consumed it.

Published-but-unrefreshed saves now set an explicit `identity_invalid` state.
An ordinary retry returns the conflict disposition before any temp creation or
publication; only explicit Overwrite or Save As can proceed. A sequenced native
control injects post-publication refresh failure, performs an external rewrite,
proves an ordinary retry preserves those external bytes, then proves explicit
Overwrite refreshes the original lane. A second post-hash sequence proves Save
As refreshes the new lane while preserving the externally rewritten original.

The lexer's negative control is now an actual test-local scanner implementation
with no block-comment state. On the independently encoded fixed witness, the
correct reference and production token/pair maps agree while the broken scanner
treats comment contents as live source and disagrees. Randomized independent
reference comparisons and fixed expected spans/pairs remain intact.

Counter-pass 5 focused evidence:

- native sedit core and gucedit probes: green
- native `os/sedit/bin.json` compile: green
- focused kernel: 3/3
- focused browser: 1/1 (`os-sedit`)
- kernel e2e under load: 3/3, 0% flake
- browser e2e under load: 3/3, 0% flake
