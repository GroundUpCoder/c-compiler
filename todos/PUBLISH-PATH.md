# PUBLISH-PATH — how in-OS-developed packages reach the served repo (#564)

**Status: RATIFIED — jku signed this off by email on 2026-08-09.** Option 1
(git-push publish) is the accepted design; Option 2 (a direct-upload endpoint)
stays rejected on the trust grounds in §3. Ticket #564, PKGDEV-EPIC ladder
item 4. Implementation is tracked by **#596** (publish T1, host-side intake),
which this sign-off unblocked.

Deliverable: this decision doc + the follow-on implementation tickets proposed
at the end (@master files them). The design is ratified; the code is not yet
written.

**Recommendation in one line: git-push-based publish (Option 1) — the in-OS
developer pushes SOURCE via the landed #478 network leg; a host-side intake
step rebuilds with `tools/mkpkg.js` and publishes via the existing comguc
`--packages-only` deploy. The direct-upload endpoint (Option 2) is rejected on
trust and duplicated-machinery grounds, not on "no customer".**

Everything below was re-measured against the tree at `5c6c19f3` (main,
2026-08-09) and against `~/git/comguc` — file:line citations are to those.

## 1. What "publish" concretely IS today (measured)

The served package repo is `/packages/{index.json,pool/*}` on
`https://groundupcoder.com` — **Cloudflare Pages, pure static**. comguc
(`~/git/comguc`, top-level repo) has no Functions/Workers directory; its
deploy is literally `wrangler pages deploy dist` (`scripts/deploy.mjs:56`).
The chain:

1. `tools/mkpkg.js` builds `dist/packages/` in c-compiler: content-addressed
   payloads `pool/<name>_<version>_<sha16>.pkg.tar.gz` + `index.json`.
   Since #580 the publish is **additive/UPSERT**: entries this invocation
   cannot enumerate are carried forward; only explicit `--prune` drops them
   (mkpkg.js:75-96). One writer per out dir is enforced by `.mkpkg-lock`
   (mkpkg.js:221-270); a shared `--pool` store is append-only (todos/0388).
2. `comguc scripts/build.mjs` assembles `dist/` — and since #580 it has
   **`--packages-only`** (refresh `/packages` in the existing dist, image half
   reshipped untouched, prior image identity carried into provenance —
   build.mjs:97-142, 232-236) and `--image-only` (no mkpkg run). These are the
   two halves of independent cadence: **a package publish no longer requires
   an image deploy.**
3. `comguc scripts/deploy.mjs` uploads dist/ and appends provenance to the
   committed `deploys/log.jsonl` ledger. It refuses a dirty c-compiler tree
   (deploy.mjs:36-42) — reproducibility is already a gate.

The consumer side: gucman fetches `index.json` from ONE repo URL
(`/etc/gucman/repos` first non-comment line, else baked
`/usr/share/gucman/repos` = origin-relative `/packages`; gucman.c:50-51,76-77),
verifies each payload's sha256 **from the index** before extraction, and gates
install on `minBase` vs the running image's `VERSION_ID` (gucman.c:55,940).
**The index is the unsigned trust root** — whoever writes index.json decides
what every gucOS user executes. That fact does most of the work in §3.

## 2. What the in-OS side already has (measured, not assumed)

- **#478 is DONE** (closed 2026-08-08, commit `31fabde3`;
  `logs/2026-08-08/0478-git-network-leg.md`): in-OS `git clone / fetch / pull /
  push` over the real smart-HTTP subtransport
  (`vendor/libgit2/http_subtransport.c`). Push was verified **server-side**
  (host git `rev-parse` + `fsck --strict`), and a live GitHub clone agreed with
  GitHub about HEAD. Auth is HTTP Basic read in-process from
  `$HOME/.git-credentials` — GitHub PATs work through that shape.
- **Bridge fitness is measured**, not hoped: the localhost net-bridge carries
  git smart-HTTP bidirectionally, 16/16 probe pass, with ONE declared limit —
  32 MB request-body cap (a >32 MB push through the bridge is a loud 413).
- **Reachability today**: headless (`node os/boot.js`) pushes direct with no
  bridge; a browser on the localhost dev origin pushes through the bridge.
  🔴 The **shipped** `https://groundupcoder.com` origin cannot reach the
  bridge — that is open ticket **#362** (P1). Production-origin browser
  publishing inherits #362's fix with zero publish-path change (the
  subtransport sits above the netFetch choke). #362 is an existing edge, not
  new work for this design.
- **#563** (in-OS packaging, heavy, open) will produce a spec-conformant
  deterministic `.pkg.tar.gz` inside gucOS, and names the artifact-identity
  question: an in-OS build compiles with the *running image's* compiler; host
  mkpkg compiles with the *building tree's* `compiler.js`. The two byte
  streams will generally differ.

## 3. The two options

### Option 1 — git-push-based (RECOMMENDED)

The in-OS developer's unit of publication is **source**: a package definition
(`packages/<name>.json` vocabulary) plus the C sources it references. The loop:

```
in-OS:  clone defs repo (or gucman install <name>-sources) → edit → cc build →
        [#563] gucman build → gucman install ./x.pkg.tar.gz → run   (local test)
        → git commit → git push <branch>                            (#478, landed)
host:   intake: fetch branch → review → tools/mkpkg.js <name>       (rebuild from
        source; ALL existing validation runs) → targeted tests → merge
        → comguc build --packages-only → deploy                     (existing verbs)
```

**What is trusted, and why this is the strong trust model:** the published
bytes are always produced by the host pipeline from reviewed source. The
in-OS-built artifact never ships — it is the developer's *local test* artifact
(#563's local `gucman install` round-trip). The artifact-identity question
from #563 is therefore **sidestepped for distribution by construction**: pool
bytes remain host-built, byte-identical to the bake pipeline
(mkpkg.js:34-39), reproducible from a commit (deploy.mjs already refuses
dirty trees). Review happens where review already happens — on a diff, before
merge — which matters because the in-OS developers this epic serves are
largely *agents*.

**What breaks / what is new:** nothing existing changes. The new work is the
intake automation (§6 T1), a version-monotonicity guard (§5), creds + remote
conventions for the in-OS side (§6 T4), and docs. Everything else in the
chain — #478, mkpkg upsert, `--packages-only`, the deploy ledger — is landed
and verified.

**Costs and honest limits:**
- A publish has host latency: it waits for an intake run, not a keypress.
  The intake step is automatable (a lane/coordinator job today; real CI
  later — open question §7.1); the developer's own job ends at `git push`.
- Production-origin *browser* devs wait on #362 (headless and dev-origin work
  today). Push packs >32 MB through the bridge hit the declared 413 cap —
  source pushes are far below it (the 82 MiB figure is the whole repo pack,
  not a delta push; a package's source delta is KBs).
- The push target repo must exist and be clonable at in-OS scale — that is a
  #565 input (§4).

### Option 2 — direct upload endpoint (REJECTED for v1)

Authenticated `POST` of an in-OS-built `.pkg.tar.gz` (+ index-entry fragment)
to the origin; the server merges it into `/packages`.

**Costed honestly, this is a new serving stack plus a new trust system:**

- **Server compute where none exists.** `/packages` is static Pages. An
  upload endpoint means Cloudflare Workers + R2 (or moving /packages off
  Pages entirely), a Durable Object or CAS-etag loop for index single-writer
  (the 0388 interleave lesson replayed server-side — two uploads racing the
  index merge is exactly the base-vs-base race, now on infrastructure with no
  `.mkpkg-lock`), and the payload-before-index publish ordering re-implemented
  in Worker code. That is a second implementation of what mkpkg already does,
  in a second repo, in a different runtime, with its own failure modes.
- **The index is the unsigned trust root (§1).** Today it is written only by
  the deploy machinery from reviewed source. An upload endpoint hands index
  write access to whoever holds a token. The token lives *inside a browser
  OS* (OPFS/`$HOME`) driven largely by agents — an exfiltration surface the
  git model does not have (a leaked git token compromises a branch that still
  faces review; a leaked upload token compromises what users execute).
  Mitigating that properly means package signing: keys, key distribution,
  gucman-side verification, revocation — an entire subsystem that exists
  nowhere today.
- **Intake policing cannot run.** mkpkg's gates (§5) operate on *definitions
  and sources*; an uploaded tarball carries only its self-declared
  `control.json`. The server cannot verify a minBase claim, cannot re-derive
  the payload, cannot run the cmdalt-shadow or drift gates without the defs
  repo — so policing degrades to "well-formed tar + sha matches itself".
- **The artifact-identity question lands here at full force**: the served
  bytes were compiled by whatever image the uploader ran. Not reproducible
  from any commit; the deploy ledger's provenance chain breaks.

The rejection argument is **misalignment, not absence of a customer**: even
built at full generality, Option 2 publishes weaker artifacts (unreviewed,
unreproducible, unverifiable) at higher infrastructure and security cost. The
one genuine capability it adds over Option 1 — *immediate* distribution of an
in-OS-built artifact to another image without host involvement — is better
served, if ever wanted, by a **staging/dev channel** (a second repo URL
serving unreviewed builds, clearly separated from the trusted index). gucman
today reads exactly one repo URL, so that would be its own designed feature
(§7.5), not a fallout of an upload endpoint.

## 4. The #565 coupling — named, not decided

#565 (separate `gucos-packages/` repo, open, awaiting jku on the rev-2 design
note of 2026-08-05) and this design co-constrain at three points:

1. **The push target.** If `gucos-packages/` is minted, the in-OS developer
   pushes THERE — a small data repo (defs + sources), cheap to clone into
   OPFS. If defs stay in c-compiler, in-OS devs clone/branch an 82 MiB-pack
   repo (measured in the rev-2 note) to change one package. This design works
   either way — the flow in §3 says "defs repo" throughout — but the in-OS
   clone cost is a real argument #565 should weigh that did not exist before
   #478 landed.
2. **The build seam.** mkpkg already reads definitions from an overridable
   dir (`--packages-dir`, mkpkg.js:189-193); the rev-2 design's
   "definition-source list" generalization is the same seam the intake job
   would drive. One mechanism serves both tickets.
3. **The cadence machinery.** #580's additive publish + comguc
   `--packages-only` are what make a package-only publish possible at all —
   both this design and #565's "independent authoring" motive consume that
   same property. Intake (§6 T1) should live wherever the defs live, so if
   #565 mints the repo, T1's home moves with it — file T1 with that noted.

Nothing in this design presumes #565's answer; every element (intake script,
monotonicity guard, creds conventions, docs) is repo-location-agnostic.

## 5. The three explicit questions

**Atomicity of the index update.** Two layers, both already correct for
Option 1:
- *Build-side*: mkpkg populates the pool view **before** publishing the index
  (mkpkg.js:938-943, tmp+rename), enforces every-row-servable (a carried
  entry with missing bytes is exit 1, mkpkg.js:921-936), and holds the
  single-writer lock. The 0388 rule generalizes to the origin: **one
  publisher owns `dist/packages`** — intake runs serialize (T1 enforces).
- *Origin-side*: a Cloudflare Pages deployment is one atomic version swap —
  `index.json` and its pool ship in the same deployment, so a client can
  never fetch an index row whose payload 404s. Pool names are
  content-addressed and cached immutable; `index.json` revalidates (comguc
  README). No CDN-window partial state exists to design around. (Option 2
  would have had to build all of this in Worker code.)

**Version / minBase policing at intake.** Because intake *rebuilds from
source*, mkpkg's whole validation set IS the intake gate, for free: minBase
must be an integer in `[0, current image version]` (mkpkg.js:742-748);
compiled payloads are auto-stamped `minBase = building image version` — the
#518 rationale, which a hand-declared lower number would rot against; name/
version grammar; the cmdalt-shadow refusal (mkpkg.js:659-677); srclib/seed
shape checks; the sibling drift gates; the 25 MiB Pages-cap warning.
**One real gap found:** the #580 upsert overwrites an index entry with
whatever version the build produced — nothing refuses a version *downgrade*
against the published index, and nothing flags changed bytes under an
unchanged version (legitimate for first-party input-driven rebuilds; a
policing signal for third-party intake). That is T3. Whether the 25 MiB warn
should harden to a refusal at intake is left open (§7.4).

**What "publish" means for #565**: publish = "merge to the defs repo + a
`--packages-only` comguc deploy". It is an *operation on comguc*, never a
merge into c-compiler's image cadence — exactly the independence the rev-2
#565 note names as jku's lead motive. See §4.

## 6. Follow-on implementation tickets (proposed — @master files)

- **T1 — intake pipeline (medium).** A host-side script (working name
  `tools/pkg-intake.js`; home moves per #565) driving: fetch ref → diff-scope
  the changed package set → `mkpkg <names>` (validation + build) → the T3
  monotonicity check → report for review. Serializes publishes (one intake at
  a time — the 0388 origin rule). Who *invokes* it is §7.1, deliberately
  outside the ticket.
- **T2 — publish runbook + ledger shape (light).** Document
  `comguc build --packages-only && deploy` as THE package-publish verb;
  verify/extend the `deploys/log.jsonl` record so a packages-only deploy is
  distinguishable and names the defs-repo SHA it built from (build.mjs
  already carries the prior image identity; the defs-side provenance is the
  new field).
- **T3 — version-monotonicity guard (light).** In mkpkg (or T1): refuse an
  index-entry version downgrade vs the previously published index without an
  explicit force flag; surface changed-bytes-same-version as a warning.
- **T4 — in-OS publisher conventions + docs (light).** How a developer inside
  gucOS configures the defs remote and `~/.git-credentials` (never reading
  cred contents into any transcript), branch naming, and what happens after
  push. Lands as the publish chapter of the #566 `/usr/doc` work — file with
  an `--after` edge on #566, content-owned here.
- **Edge retarget, not a ticket:** #570 (D3)'s publish edge currently points
  at this DESIGN ticket; retarget its hard block to T1+T2 (+#563) once filed.
  #362 stays the production-origin-browser enabler — already open, P1, no new
  filing needed.

Suggested edges: T1 after #563 lands its def-vocabulary decisions (soft);
T2 depends on T1 (soft); T3 independent (can land first); T4 after #566
exists (soft). None hard-block each other except D3 → {T1, T2}.

## 7. Open questions (left open deliberately)

1. **Who runs intake.** A coordinator/lane job on the mac mini (works today,
   zero new infra) vs real CI (GitHub Actions could run mkpkg + host suite
   for defs-only changes, but the heavy estate and the Cloudflare deploy
   credential are jku policy calls). The design is agnostic; T1 is the same
   script either way.
2. **External contributors.** Auth, package-name ownership, and namespace
   policy only matter if non-jku publishers are ever in scope. Until then the
   publisher identity is the existing deploy machinery and review is the
   gate. Explicitly not designed here.
3. **#565 itself** — awaiting jku on the rev-2 note; §4 names the couplings.
4. **25 MiB intake posture** — keep mkpkg's warning, or harden to refusal at
   intake (a payload over the cap builds fine and then silently never
   deploys)?
5. **A staging/dev channel** (second repo URL serving unreviewed in-OS-built
   artifacts for cross-image testing). gucman reads one repo URL today; this
   would be a designed gucman feature (multi-repo or `--repo=` override), not
   a side effect. Named as the honest home of Option 2's one unique
   capability, unscheduled.
