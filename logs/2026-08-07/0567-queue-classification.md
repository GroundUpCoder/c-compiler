# #567 — queue classification sweep: OS-proper vs package-side (PKGDEV-EPIC ladder 6b)

## What landed

Every open ticket in the c-compiler cc project now carries exactly one
classification in its `design` field, leading-token structured:
`pkgdev:<os-proper|package-side|mixed> — <one-line reasoning>`. The at-a-glance
snapshot is `todos/QUEUE-CLASSIFICATION.md` (this commit); the DB is the live
truth.

**Counts, verified by a fresh DB re-read after the sweep (not from the write
return values):**

- open set = 255 tickets (245 `open` + 1 `in_progress` (#567 itself) + 9
  `deferred`)
- classified = **255 / 255**, unclassified = 0
- split: **os-proper 158 · package-side 73 · mixed 24**
- class in DB == class in my map for all 255; the three pre-existing `design`
  values (#464, #280, #276) preserved verbatim after ` | prior: `
- #567's own body/status/claim untouched by its design write (spot-checked)

## Scope choice (no silent caps)

The kickoff said "246 open". Measured: `ticket list` default returns only
status `open` (245) and **excludes #567 itself** (`in_progress` since my
claim); 245 + 1 = the kickoff's 246. I additionally included the 9 `deferred`
tickets — they are parked, not dead, and an unclassified ticket re-entering
the queue would silently sink out of the epic filter. So the swept set is
255 = open ∪ in_progress ∪ deferred; done/dropped excluded. Nothing was
sampled, skipped, or truncated.

The `blocked` status filter is a derived VIEW (40 tickets, all status `open`,
strict subset of the 245) — counting it separately would double-count.

## Mechanism — I accept the coordinator's lean; measurements agree

The ticket's Plan offered "cc labels if available, else a marker line
prepended to the body". Labels are a thread mechanism (`label-add` takes a
chatId), so option 1 does not exist for tickets, and body-prepending 255
tickets is the highest-blast-radius option on the table. The coordinator's
lean — `--design` with a structured leading token + a committed snapshot —
survived contact:

- `cc-meta ticket update <uuid> --design <str>` round-trips the em-dash and
  token intact and clobbers nothing (title/body/status/priority/difficulty/
  claim all verified unchanged on the guinea-pig write to #567).
- No rate limiting or `{ok:null}` weirdness across 255 sequential writes
  (0 failures); the whole sweep took ~2 minutes.
- No rebuttal filed: none of the pre-authorised wrongness conditions held.

`ticket list` has no `--design` filter, so the "PKGDEV filter" is a
client-side projection: `items[].ticket.design` matching
`/^pkgdev:(os-proper|package-side|mixed) /`. Caveat for the filter author:
**`design` is omitted from the list projection when empty** — an absent key
means "filed after this sweep, unclassified", not "field doesn't exist".

## Classification rulings (where the ticket's definitions underdetermine)

The definitions put apps/ports/gcode/decks/demos/package-defs package-side
and kernel/wm/compositor/compiler/host/veneers/estate os-proper. The
underdetermined cases, and the line I drew — the operational test being
*"which stream does the work belong to: the platform below the interface, or
the consumers above it (the half that would move to a gucos-packages
repo)"*:

- **gucman and its verbs (#73, #74, #545, #563, #564) = os-proper.** gucman
  is an in-OS app by construction, but it is the package-management
  *platform* — the PKGDEV ladder treats its verbs as platform rungs, and it
  would never move to a package repo. Filed os-proper, not mixed.
- **Tests classify by SUBJECT.** NetSurf conformance lanes (#160–#166, #369,
  #472) and the os-gcode assertion gap (#308) are package-side; suite-runner
  / harness / gate / flake-class tickets (#375, #465, #512, #547, #550, #552,
  #560, #562, #344…) are os-proper. Conformance corpora whose subject is the
  veneer — Wine tests (#339), Petzold micro-tests (#341), SDL testautomation
  (#531, #532) — are os-proper even though the material is vendored.
- **Baked system apps that code wholly above the interface = package-side**
  (term #202/#307, ctlpanel #27/#28/#389, fileman legs, paint #24/#276,
  software manager #149/#203). Being in the base image is a bake decision,
  not an implementation-layer fact. wm.c stays os-proper by the ticket's own
  naming.
- **Dogfood passes (#26, #502, #508, #568–#570) = mixed** — they do
  package-side development in order to measure the platform; both halves are
  the point.
- **Rust/codex program split:** toolchain spikes and the ABI crate (#191,
  #293, #294) os-proper; the codex port itself (#292, #295) package-side.
- **#159 (cpython-clang startup) = os-proper**: the fix is compiler/spawn
  platform work; the package is only the symptom carrier.
- 24 mixed calls, each naming its os half AND its pkg half in the design
  string — none is a "didn't look" dump.

Judgment calls a reviewer might reasonably move by one column: #196 (encoder
seam — I read the body: it is host-seam work, so os-proper, not mixed);
#437 (Noto font packages — package-side; the bake-default axis is a bake
knob, not new platform code); #566 (/usr/doc — os-proper: baked platform
documentation, though its content teaches package-side dev). Moving any of
these is a one-line `ticket update --design`.

## Errors made en route

- First list attempt used a `--json` flag that doesn't exist (output is JSON
  already). No damage; noted so the next lane doesn't repeat it.
- I initially flip-flopped on term/ctlpanel (furniture vs app) before
  settling the interface-layer rule above; the committed calls are
  consistent with it.

## Acceptance state

- ✅ every open ticket carries exactly one classification (255/255 by DB
  re-read)
- ✅ snapshot note committed: `todos/QUEUE-CLASSIFICATION.md`
  (`node todos/liabilities.js check` rc=0 with the note present — 36
  entries, OK)
- ⏳ coordinator confirms the filter can select on it (the grep contract is
  documented in the note's header)
