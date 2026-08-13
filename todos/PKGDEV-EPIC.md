# PKGDEV-EPIC — in-OS development of packages (TABLED)

## 🔴 STATUS: TABLED — jku direct email ruling, 2026-08-13

**Do not dispatch PKGDEV tickets.** jku ruled: table PKGDEV now, temporarily
defer its real-GitHub authenticated Git dogfood (return to it in the future —
it is NOT a gate on beginning gamedev), and pivot all work to gamedev full
throttle. `todos/GAMEDEV-EPIC.md` is once again PRIMARY and EXCLUSIVE in
allocation.

Consequences, precisely:

- **#569** (the real-GitHub dogfood, which was the narrowed exit gate) is
  **deferred**. Its lane was STOPPED before completion. **No result from that
  lane may be represented as a passed gate** — the evidence record is on the
  ticket.
- **PKGDEV resumes only on a later explicit jku ruling.** A coordinator may
  NOT restart it by argument.
- **Already-landed PKGDEV capability remains available to gamedev.** A defect
  in landed package/Git functionality may still be selected when concrete
  evidence shows it BLOCKS active gamedev — that is gamedev-blocker work on a
  gamedev argument, not an indirect restart of the PKGDEV backlog.
- The standing **broken-build preemption** is unaffected and still outranks
  everything.

Ruling note: `~/git/meta/meta/notes/ruling-gamedev-full-throttle-pkgdev-tabled-2026-08-13.md`.
Current ranking: `~/git/meta/notes/gamedev-queue-ranking.md`.

Everything below is the RETIRED 2026-08-07 promotion, kept as history for
whoever resumes the epic. **Do not re-apply it while the tabling stands.**

---

**Retired status (2026-08-07 → 2026-08-13): ACTIVE, ranked ABOVE the gamedev
epic.** `todos/GAMEDEV-EPIC.md` was explicitly SECOND: it remained
active and its rules (membership-is-argued, written justification burden,
dogfood-pass mechanics, API honesty) applied verbatim here — only the precedence
changed.

> **jku, 2026-08-07, verbatim:** *"Even higher than the gamedev epic, I'm
> creating and promoting a new epic as P0: in-OS development of packages."*
> And, same conversation: *"Ok, yea, let's promote this epic, make the gamedev
> epic second place, and put all our focus on this work now."*

## 🔴 Queue selection — EXCLUSIVE focus + delegated heavy promotion (jku, 2026-08-07 eve)

Three rulings from the promotion conversation, superseding the softer
"PKGDEV first, gamedev second, rest last" banding for as long as they stand:

1. **EXCLUSIVITY.** jku verbatim: *"I want it so that the work for this epic
   comes before work for anything else. Only once we actually get this epic
   to a good state are we allowed to do anything else."* ⇒ The queue selects
   PKGDEV-advancing work ONLY. Gamedev-advancing and unaffiliated tickets do
   not run — not even dependency-free light ones — until jku declares the
   epic "in a good state". (Broken-build preemption still outranks
   everything, as always.)
2. **HEAVY PROMOTION IS DELEGATED for this epic.** jku verbatim: *"Yea,
   promote the heavy stuff as needed."* ⇒ A PKGDEV-advancing heavy ticket
   (#568 D1, #478, #563, the dogfood rounds…) runs when it is the right next
   epic work — the coordinator decides, no per-ticket jku ask. This is a
   scoped exception to the standing "only jku promotes heavy work" rule; it
   applies ONLY to tickets carrying a written PKGDEV justification. The
   weight sort still orders WITHIN the epic (prefer the lighter
   epic-advancing ticket when both are ready and unordered by the ladder).
3. **A BLOCKING BUG IS EPIC WORK.** jku verbatim: *"if there's a general bug
   blocking this epic from working well, that's a part of it, so make sure to
   keep that in mind as well when deciding how to order the work."* ⇒ Any
   bug — however far from packaging on its face — that measurably impedes
   the in-OS dev loop (crashes/wedges under the loop, toolchain defects,
   bridge/network faults like #362/#391, gcode tool failures like #504,
   platform instability the dogfood rounds hit) is IN the epic and ordered
   by bug-fix-first within its tier. The membership test remains an
   argument: write down what the bug blocks.

Within the epic band the standing weight sort applies (light → medium →
heavy, Pn inside a tier), dependency edges outrank the sort, and the
justification burden is unchanged. Tickets advancing both epics ride at
full PKGDEV standing.

## The goal

**Package/app development happens inside gucOS itself.** gcode, the games,
NetSurf-adjacent apps, decks — anything that codes against the gucOS
interface (libc, SDL3, win32 veneer, WM protocol, curl veneer) — should be
developable by a person or an agent sitting inside the running OS: clone,
edit, build, run, test, commit, push, package, publish, without touching the
host. gucOS **proper** and its interfaces (kernel, wm, compositor,
compiler.js, host.js, SDL shim, veneers) continue to be developed host-side
for now; that boundary may move later.

The intent line this epic promotes (from #473/#475/#478): *"I want to get to
a point where gucOS can do work independently on its own."* Reading is not
independence.

## Where we are (measured 2026-08-07)

The edit-build-run loop already works in-OS: `/bin/cc` (kernel-side
compiler.js via `__compile`; srclib `__require_source` replaces make/-l),
hush + 81 coreutils + vi + term + strace + curl, gcode as the in-OS agent,
gucman with srclib packages (headers → `/usr/local/include`, sources →
`/usr/local/src`) and the #407 `<name>-sources` companion packages carrying
every binary's full compile closure — `gucman install gcode-sources` + edit +
`cc` rebuild works today (`test_gucman_sources_e2e`). git is read-only
porcelain over a write-capable libgit2 (41/41 e2e); BlockFS/OPFS persists
repo-sized trees.

## The ladder

1. **Source control** — `#475` (git write set: init/add/commit/branch/
   checkout; approved 2026-08-04) → `#478` (git network: ONE
   `git_smart_subtransport_http` over the curl veneer; smart-protocol
   machinery already compiled in). The net-bridge bugs `#362` and `#391` are
   effective sub-blockers for off-origin; `#478` names binary-POST/streaming
   through the bridge as an unverified risk.
2. **DX hardening (already queued)** — `#464` (FreeType srclib), `#498`
   (unlinkable baked headers), `#545` (gucman upgrade path — without it you
   cannot install your own new version), `#518` (explicit minBase; in flight).
3. **In-OS packaging (NEW)** — a `gucman build`-shaped verb: package def +
   tree → deterministic `.pkg.tar.gz` + index entry, inside gucOS. tar/gzip/
   zlib/sha256 all exist in-OS; the design question is artifact identity
   (host mkpkg compiles via the bake pipeline; an in-OS build compiles with
   the running image's compiler — coherent with the running system by
   construction).
4. **Publish path (NEW, design-first)** — how an in-OS developer's work
   reaches the served package repo. Leading candidate: git-push-based (in-OS
   dev pushes source via the #478 leg; host CI builds + publishes — reuses
   the whole existing pipeline). Direct upload endpoint is the alternative
   (auth + server work on comguc).
5. **Self-contained in-OS documentation (NEW, jku direct ask)** — markdown
   under **`/usr/doc/`** fully describing how to do development inside gucOS
   (toolchain, srclib, sources packages, git loop, packaging, publishing), so
   the system is self-describing once the functionality lands. Note the
   existing convention bakes docs at `/usr/share/doc/` (`sdl-gucos.md`);
   implementation should reconcile the two paths (e.g. `/usr/doc` symlink)
   rather than fork the convention silently.
6. **Separation (NEW)** — (a) DECISION: a separate repo `gucos-packages/`
   for package definitions and package-side apps (jku raised it as "we might
   want" — scope it, don't presume it); (b) classify the open queue
   OS-proper vs package-side so the two streams stop running as one blob.

**Gating posture for v1: dev in-OS, gate on host.** The acceptance estate
(tests/kernel, the browser sweep) stays host-side; an in-OS-developed change
reaches main by push (once the git legs land), then rides a normal host lane
gate. Moving gates in-OS is future work, not part of this ladder.

## Dogfood drivers — the test of the epic IS the epic (jku direct ask)

> *"As a test of all of these changes working, I want multiple tickets that
> have threads that will drive the work itself — by making all these changes,
> do builds, etc. and see how well the agent itself can do the changes
> inside."*

So the epic carries **dogfood-driver tickets** where the executing thread
does the assigned development work FROM INSIDE gucOS (driving gcode / the
in-OS toolchain, not host editors), measures how well that goes, and files
every friction point as a ticket:

- **D1 — edit-build-run (runnable TODAY, no blockers):** change a real app
  from inside gucOS via gcode + `*-sources` + cc; run it; file findings.
- **D2 — source-control loop (blocked by #475, #478):** clone → edit →
  build → commit → push from inside gucOS.
- **D3 — full package lifecycle (blocked by the in-OS packaging + publish
  tickets):** develop, package, publish, and `gucman install` a package
  without ever leaving gucOS.

Dogfood mechanics are inherited verbatim from GAMEDEV-EPIC.md: each round is
its own thread; findings become tickets with BOTH keys (`--difficulty` and
`--priority`) plus evidence; rounds recur via the hard-`blockedBy` chain
(done for round N = findings filed + round N+1 filed + N+1 hard-blocked on
N's findings — **the recurrence is an edge, never the word "recurring"**);
passes report and file, they do not land platform fixes mid-pass; screenshots
and evidence go under `s3://groundupcoder/gucos/<topic>/<date>/`.

## Justification burden (unchanged, extended)

Every queued ticket still needs a WRITTEN epic justification in the kickoff
and the coordinator's state note. The argument now names which epic(s) it
advances; anything on the path of a developer building and shipping a
package inside gucOS qualifies here — toolchain, source control, packaging,
publish, docs, in-OS agent capability, platform stability under the in-OS
dev loop. Membership is argued, not pattern-matched; the burden is on the
selector (GAMEDEV-EPIC.md's three rulings apply word for word).
