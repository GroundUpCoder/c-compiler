# GUCODE-EPIC — dormant `gucode` successor epic

## Status: DORMANT METADATA ONLY

`gucode` is the exact lowercase product and CLI name. This document and its
ticket graph do not activate it. `GAMEDEV-EPIC.md` remains PRIMARY AND
EXCLUSIVE in allocation; its ranking, recurrence, and standing promotions are
unchanged. No inventory, feasibility gate, production design, implementation,
deployment, or recurring `gucode` pass is authorized before the gates below.

Approved source artifacts:

- installable proposal: thread `01a005b6-6a37-7def-81d8-0609ffc8a225`,
  message `01a005c0-c0de-75c0-b6d3-0e546516e06a`;
- independent installation GREEN: thread
  `01a005c4-8b90-77b0-8540-61a19c27ae2c`, final assistant verdict;
- architecture: thread `01a0058f-085d-788f-abbe-bf62ac27cdd2`, message
  `01a005a3-af05-70b7-84fc-8eee35f1d69a`;
- architecture GREEN: thread `01a00598-e0bb-71fb-a83b-8778950430b0`,
  message `01a005a7-adfd-7fa1-8f80-b3bbdb069f75`.

The architecture GREEN permits only the two measured feasibility
investigations after valid activation. It does not authorize production.

## Tracker limitation and mandatory warning

Hard dependencies and `needsHuman` gate derived readiness and normal
`ticket next` scheduling. They are not authorization controls. Current tracker
semantics permit direct `claim` or `done` without checking readiness,
dependencies, actor identity, or required outcome content. A blocker is
satisfied solely when its ticket status is `done`.

Every `epic:gucode` ticket carries this exact warning:

> **Procedural authorization warning:** hard dependencies and `needsHuman`
> gate derived readiness and `ticket next`; current tracker semantics still
> permit direct `claim` or `done`. Do not claim, execute or close this ticket
> unless its recorded prerequisites and exact external rulings have been
> independently verified.

No tracker field proves that jku personally made a ruling. The coordinator
must verify the exact external message and the ticket event history.

## Governing architecture

- `gucode` is a traditional desktop application built with user32 standard
  controls and a custom GDI-rendered retained transcript.
- Application code uses no raw SDL; SDL remains below the Win32 veneer.
- `gucode` and terminal `gcode` are peer frontends to one authoritative
  `gcode` core. Neither frontend duplicates or reconstructs provider
  orchestration, tools, context, configuration, cancellation, compaction,
  persistence, journals, or ownership.
- Standard Win32/user32/GDI names meet their documented contracts inside an
  explicit supported subset. Unsupported or platform-impossible semantics
  remain absent, fail loudly and documentably, or use unmistakably custom
  names. Standard names are never approximate.
- Manual Win32, gcode Win32, and gucode Win32 + games remain distinct,
  required, mechanically recurrent pass families after authorization.

## Activation and allocation

### GUC-A0 — activation evidence packet

GUC-A0 begins deferred, P1/medium, with no dependencies. It is reopened only
when jku asks whether activation should occur. Its packet records:

- current gamedev Pass A/B rounds and findings;
- evidence for “various games / very stable / very enjoyable”;
- unresolved gamedev P0 stability and contract violations;
- build health and remaining blockers by weight;
- proposed `gucode` capacity cost and candidate allocation modes;
- explicit confirmation that gamedev recurrence does not end automatically;
- current repository and queue revisions; and
- the exact artifact/message containing the packet.

Relabel it heavy before work if the actual investigation is heavy.

### GUC-00 — exact jku activation and allocation ruling

GUC-00 is P1/light, `needsHuman=decision`, and hard-blocked by GUC-A0. It may
close as successful activation only after an exact jku message states:

1. whether `gucode` activates;
2. allocation mode: dormant, secondary, bounded concurrent lane,
   shared-primary, or exclusive successor;
3. whether M/G/U receive standing heavy promotion after dependencies clear;
4. whether existing gamedev recurrence continues unchanged;
5. the concurrency/capacity limit; and
6. the exact activation packet considered.

The close outcome contains a verbatim or lossless ruling, exact external
thread/message or email ID, allocation mode, promotion decision, concurrency
limit, gamedev-continuation decision, and packet ID. Before closure, reread the
ruling directly. After closure, reread GUC-00's complete event history and
outcome, every downstream ticket and full hard set, and the global ready view.
Compare readiness with the allocation ruling. If closure was invalid, reopen
GUC-00 immediately, stop released work, and report the temporarily wrong
readiness. A “remain dormant” ruling does not successfully close GUC-00; the
recommended behavior is to leave it open.

## Exact-artifact review and production topology

```text
GUC-00 activation
  -> GUC-01 Win32/GDI inventory
       -> GUC-02P protocol/lifecycle feasibility execution
            -> GUC-02R independent exact-artifact review
       -> GUC-03P retained-transcript feasibility execution
            -> GUC-03R independent exact-artifact review
GUC-02R GREEN + GUC-03R GREEN
  -> GUC-04D measured production design
       -> GUC-04R independent exact-artifact review
            -> GUC-04J jku post-gate production authorization
                 -> GUC-05 authoritative core/protocol extraction
                      -> GUC-06 gucode shell/transcript
                           -> GUC-07 core workflow
                                -> GUC-U1
```

A review ticket closes `done` only for an independent GREEN that records the
exact artifact and source commit/message and for which no later change exists.
AMBER or RED leaves it open: record findings, send them to a separate
counter-pass, produce a new exact artifact, and re-review it. Any changed tip
voids approval. Before downstream work proceeds, reviewer and coordinator
reread the review ticket, linked thread, exact artifact, and live readiness.

Feasibility execution tickets may close when the measured investigation
artifact exists even if its technical result is adverse; they never call
themselves GREEN. Their review tickets close only on exact-artifact GREEN.

GUC-04D hard-blocks on GUC-00, GUC-02R, and GUC-03R and synthesizes the
measured design without preserving disproved assumptions. GUC-04R reviews its
exact final artifact. GUC-04J is P1/light, `needsHuman=decision`, and requires
GUC-00, both feasibility review GREENs, and GUC-04R. Its exact jku ruling must
acknowledge both measured verdicts, cite the exact GREEN design, authorize or
decline production, resolve first-release scope/concurrency, and fix numeric
acceptance thresholds or assign a named threshold decision gate. Production
extraction hard-blocks on GUC-04J, not merely on feasibility completion.

## Phase contracts

### Win32/user32/GDI inventory

Inventory current declarations/implementations, A/W variants and conversions,
messages/returns/errors, controls, focus/keyboard, selection/clipboard/scroll,
painting/invalidation/GDI state, dialogs/menus/resources, automation behavior,
loud refusals/approximations, shipped consumers, and current test evidence.
Produce a primary-contract-backed supported subset and compatibility table in
`WIN32.md`, mechanical drift checks where practical, and evidence-backed
findings only. Do not file a speculative ticket per absent symbol. GUC-01
begins medium and is relabeled heavy if the complete inventory proves heavy.

### Approved feasibility gates

GUC-02P proves or rejects owner/manager election, fencing, restart and child
teardown, durable acceptance and no ambiguous rerun, one combined terminal
record, deduplication, bounded replay/reset, malformed/slow clients, mixed
frontend attachment, v1 import, interleavable cancellation, and all twelve
approved cancellation races.

GUC-03P proves or rejects a traditional no-SDL Win32 application using a
standard multiline EDIT composer and custom retained GDI transcript, streamed
appends, virtualization, collapse, anchoring, selection/copy, hit testing,
semantic automation, keyboard/pointer, resize/density, touch/OSK boundary,
realistic long-history responsiveness, and explicit Unicode, shaping, bidi,
IME, and accessibility limitations.

### Production phases

Only a valid GUC-04J authorization permits production. The authoritative
`gcode` core owns providers/credentials, prompt/context, tools/policy,
configuration, workspace identity, cancellation, compaction, journals,
recovery, command ledger, ownership, and mutation serialization.

The initial `gucode` shell is a conventional Win32 window/message loop with
standard controls, a custom `WM_PAINT` retained transcript, typed structured
events, no terminal scraping, no provider calls, no raw SDL, and a semantic
automation boundary. The core workflow covers managed conversations,
core-owned workspace configuration, structured streaming, tool/result
presentation, multiline drafts, cancellation, indeterminate recovery, recent
navigation, visible model/workspace/owner/error state, terminal/GUI attachment,
approved source/diff/build activation, and measured long-history response.

Do not initially create broader-management or voice implementation tickets.
Broader management is designed after U1 and depends on GUC-00, GUC-04J,
GUC-07, U1, every unresolved applicable U1 finding, and any scope decision.
Voice waits for real native capture, consent/privacy/indicator work, an actual
STT policy decision, provider/engine choice, credentials/egress, retention and
language policy, editable drafts, and explicit jku promotion. Never depend on
a nonexistent future ticket.

## Win32/GDI fidelity and finding policy

Every finding names its primary governing contract and classification:

- **contract violation:** shipped required semantics are wrong or a
  load-bearing effect falsely reports success; P0 unless jku explicitly rules
  otherwise;
- **quality gap:** permitted behavior measurably harms use; P1 if
  epic-critical, otherwise P2;
- **feature gap:** honest absence or correct documented unsupported result;
- **platform-impossible:** absence, loud standard-compatible failure, or a
  differently named gucOS extension.

A custom extension is permitted only when real, generally useful rather than
`gucode`-specific, accurately contracted, explicitly detectable, and clearly
nonstandard. Timing, synchronization, persistence, selection, cancellation,
and data integrity are load-bearing and cannot use benign success degradation.

## Recurring pass contracts

All passes are initially P1/heavy, report-and-file only. GUC-00 explicitly
decides standing promotion; it is never inferred.

- **M — manual Win32:** a skilled agent writes a rotating traditional
  Win32/GDI app inside gucOS using `cc`, real-browser execution, and semantic
  `wmctl` inspection; no SDL. It measures platform contracts and direct DX.
- **G — gcode Win32:** a human-style driver instructs in-OS `gcode` and does
  not write/patch code. It measures whether a human can obtain a correct
  traditional app without expert repair.
- **U — gucode Win32 + games:** a human-style driver uses `gucode` while its
  authoritative core writes code. Every round includes one traditional
  Win32/GDI app and one C/SDL3 game task. `gucode` itself remains Win32/GDI.

Each pass records source, commands/output, applicable prompt transcript and
tool events, contracts, semantic tree, screenshots/pixels, timings, current
commits, and explicit null findings. Screenshots use only
`s3://groundupcoder/gucos/<topic>/<date>/`.

Round N closes only after every finding is filed with priority, difficulty,
classification, evidence, and dormant/activated justification; exactly one
N+1 exists; its complete hard set is computed; one `ticket block --hard`
replaces that full set; and reread proves exact UUID-set equality,
`blockedByOpen` equality, and non-readiness while any prerequisite is open.
Every set includes GUC-00, applicable product/review gates, every finding, and
the current-round closure guard where applicable. A zero-finding successor
depends on round N plus all invariant gates. Before closing a duplicate,
replace its UUID in the successor's complete set with the canonical live UUID,
verify the full set/readiness, and only then close/drop the duplicate.

## Initial dormant ticket manifest

All tickets are P1 and carry this exact justification:

> `epic:gucode justification:` Dormant successor-epic metadata only. This
> ticket is ineligible for allocation until the recorded jku activation ruling
> and every applicable exact-artifact review and production-authorization gate
> are complete. Its existence does not change current gamedev allocation.

They also carry the procedural authorization warning above.

| Label | Exact title | Difficulty | Initial state / complete symbolic hard set |
|---|---|---|---|
| GUC-A0 | Assemble the gucode activation evidence packet | medium | deferred; `{}` |
| GUC-00 | jku activation and allocation ruling for the dormant gucode epic | light | `needsHuman=decision`; `{GUC-A0}` |
| GUC-01 | Inventory and specify the gucOS Win32/user32/GDI fidelity boundary for gucode | medium | `{GUC-00}` |
| GUC-02P | Feasibility execution: managed gcode protocol, ownership and lifecycle | heavy | `{GUC-00,GUC-01}` |
| GUC-02R | Independent exact-artifact review: managed gcode protocol/lifecycle feasibility | heavy | `{GUC-00,GUC-02P}` |
| GUC-03P | Feasibility execution: retained Win32/GDI transcript and EDIT composer | heavy | `{GUC-00,GUC-01}` |
| GUC-03R | Independent exact-artifact review: retained Win32/GDI transcript feasibility | heavy | `{GUC-00,GUC-03P}` |
| GUC-04D | Synthesize the measured production design for gucode | heavy | `{GUC-00,GUC-02R,GUC-03R}` |
| GUC-04R | Independent exact-artifact review: measured gucode production design | heavy | `{GUC-00,GUC-02R,GUC-03R,GUC-04D}` |
| GUC-04J | jku post-gate authorization for gucode production implementation | light | `needsHuman=decision`; `{GUC-00,GUC-02R,GUC-03R,GUC-04R}` |
| GUC-05 | Extract the authoritative gcode engine and managed-v2 frontend protocol | heavy | `{GUC-00,GUC-02R,GUC-03R,GUC-04R,GUC-04J}` |
| GUC-06 | Build the traditional Win32 gucode shell and retained transcript | heavy | `{GUC-00,GUC-04R,GUC-04J,GUC-05}` |
| GUC-07 | Complete the first-release gucode core agent workflow | heavy | `{GUC-00,GUC-04R,GUC-04J,GUC-05,GUC-06}` |
| GUC-M1 | Manual Win32 pass round 1: build and iterate a traditional GDI application | heavy | `{GUC-00,GUC-01}` |
| GUC-G1 | gcode Win32 pass round 1: drive gcode to build and iterate a traditional application | heavy | `{GUC-00,GUC-01}` |
| GUC-U1 | gucode Win32 + games pass round 1 | heavy | `{GUC-00,GUC-04R,GUC-04J,GUC-07}` |

The live ticket number/UUID mapping is appended only after checkpointed ticket
creation and verification.

## Acceptance thresholds remain decisions

Before production authorization, GUC-04D proposes and GUC-04J rules on
transcript scale, layout/input latency, scroll jumps, replay/frame bounds,
cancellation bounds, recovery time, zero duplicate execution, zero draft
loss, test app/game set, friction sampling and pass threshold, Unicode/IME/
bidi/shaping/accessibility boundary, and keyboard/pointer/touch surfaces.
Until ruled, “responsive,” “realistic,” and “enjoyable” are not acceptance
claims.

## Dormant coexistence and installation audit

Before activation, A0 is deferred, GUC-00 is human-blocked and hard-blocked by
A0, every downstream ticket hard-blocks on GUC-00, normal readiness is false,
and `ticket next` cannot select them. This is a scheduler property, not actor
authorization. Gamedev tickets, order, dependencies, states, recurrence, and
promotions remain untouched.

`ticket block --hard` replaces the complete hard-dependency set. Every use
supplies all intended UUIDs once, then rereads and verifies stored set
equality, unresolved-subset equality, and `derived.ready == false`. Installation
stops on the first mismatch. The global audit compares every `epic:gucode`
ticket with this manifest, requires none ready or in progress, proves all hard
sets, proves omitted future tickets absent, and records the direct-verb bypass.

Only after jku requests activation may A0 reopen and assemble its independently
inspected packet. Only the exact GUC-00 ruling may select allocation. Each
feasibility P ticket produces a measured artifact without implying GREEN; each
R ticket stays open until exact-artifact GREEN. Only after GUC-04D, GUC-04R
GREEN, exact GUC-04J authorization, full history rereads, and readiness audit
may GUC-05 enter normal allocation.
