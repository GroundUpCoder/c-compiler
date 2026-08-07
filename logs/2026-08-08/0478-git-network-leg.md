# #478 — git network leg: clone / fetch / pull / push (lane-478, re-dispatch r2)

Base: `f7c0bbcc` (origin/main at dispatch). Branch `lane-478`.
Model note: this lane runs on **Fable** (verified by the dispatcher against thread
readback), so the Opus/Codex second-agent review protocol in the ticket body does
NOT bind. If a later resume of this lane runs as Opus, the protocol binds again.

## Survey — every ticket claim re-measured at HEAD

The ticket's engine claims were measured at `481421fb`; re-verified at `f7c0bbcc`:

- **The hook point holds.** `vendor/libgit2/missing_stubs.c:73` —
  `git_smart_subtransport_http` returns -1 (moved from `:58`; the file grew the
  #473 init-honesty comments). `git_socket_stream_new` at `:65`, same shape.
- **The engine is COMPLETE as claimed.** The bin.json moved: `vendor/fakegit/bin.json`
  no longer exists — the CLI build is `os/git/bin.json` (211 sources, exactly the
  count the ticket measured). All the smart machinery is in it: `transports/smart.c`,
  `smart_pkt.c`, `smart_protocol.c`, `transport.c`, `git.c`, `local.c`, plus
  `indexer.c`, `pack.c`, `pack-objects.c`, `odb_pack.c`, `push.c`, `fetch.c`,
  `clone.c`, `remote.c`, `refspec.c`, and the auth side `transports/auth.c`,
  `credential.c`, `credential_helpers.c`. `transport.c:38-39` already routes
  `http://` and `https://` to `git_transport_smart` over
  `http_subtransport_definition = { git_smart_subtransport_http, 1 (rpc), NULL }` —
  implementing the real function lights both schemes up with zero registration code.
- **Helpers present in the compiled set**: `src/util/net.c` (`git_net_url_parse`,
  with username/password fields), `src/util/str.c` (`git_str_encode_base64`),
  `merge.c`/`annotated_commit.c`/`graph.c` (pull's fast-forward analysis).
- **The transport substrate (todos/0417)**: HTTP transfers are ordinary fds.
  `__http_open(method, url, headers, body, blen, headers_ms, idle_ms)` stages
  binary bodies of ANY size chunk-wise (`host.js createHttp` pages through
  `HTTP_BODY`, verified at `host.js:6952-6965`), responses STREAM through
  `read(2)` with kernel backpressure (`HTTP_BUF_CAP`), redirects are followed
  with the final URL surfaced as the synthetic `x-guc-final-url` header line
  (#359), and `__wait` + `__http_status` give the WAIT-first consume loop
  (`os/curl/libcurl.c` is the reference consumer). The predecessor lane's
  final claim ("kernel contract fully understood — binary bodies stage
  chunk-wise, responses stream with backpressure, redirects followed") is
  **CONFIRMED against code**, not carried on trust.

## Scope argument — the soft edges #362/#391 (ordered, not blocking)

The coordinator's comment on the ticket asks each taker to argue whether this
lane's scope touches the off-origin bridge path those tickets gate.

- **#391** (relative URLs die at the bridge): git remote URLs are ALWAYS absolute
  `http(s)://` — a relative remote is not expressible. Does not gate any part of
  this ticket.
- **#362** (shipped `https://groundupcoder.com` origin cannot reach the
  127.0.0.1 bridge — PNA/preflight failure at the SHIPPED origin): this gates the
  *production-origin* browser configuration only. The in-browser acceptance here
  runs on a localhost dev origin (serve.js), where the bridge measurably works
  (`test_netbridge_e2e.js` exists and is green on main). Off-origin git from the
  SHIPPED deploy inherits #362's fix with zero git-side change, because the
  subtransport sits entirely above the netFetch choke point.

So: neither soft edge blocks; both are honestly inherited seams. Recorded here as
the dispatcher requested.

## Design decision — the subtransport speaks to the Tier 2 transport DIRECTLY, not through curl_easy_perform

The ticket's phrase is "one `git_smart_subtransport` over the EXISTING Tier 2
`curl` veneer". Measured against code, the *easy interface* cannot carry this
cleanly, and the ticket's own risk list says why: `curl_easy_perform` is a
PUSH-model API (WRITEFUNCTION callbacks fire inside one blocking call), while
`git_smart_subtransport_stream.read()` is a PULL-model API the smart protocol
calls incrementally. Bridging push→pull inside one single-threaded wasm process
requires buffering the ENTIRE response before the first `read()` returns — for a
clone that is the whole multi-MB packfile held in memory, and it discards the
kernel's streaming backpressure (todos/0417's core property).

The curl veneer is itself a thin consumer of the same kernel primitives
(`__http_open` / `__http_status` / `read` / `close` / `__wait` — libcurl.c:58-68
declares them exactly as any consumer may). The subtransport consumes those same
primitives with the same WAIT-first discipline. "Over the Tier 2 transport" is
satisfied; the easy-interface detour is not taken.

**Rebuttal condition (pre-authorized):** if the coordinator reads "over the curl
veneer" as literally binding to the libcurl API, the cost to comply is
whole-response buffering of every fetch/clone plus a curl dependency edge in
os/git/bin.json — I argue that is strictly worse on memory, on streaming, and on
code (the perform loop would be re-implemented as a buffer walk anyway). A ruling
the other way needs only the stream layer swapped; the action/auth/redirect logic
is independent of it.

## Bridge fitness — measured, not assumed (the ticket's ONE thing)

See "bridge probe" below (build/bridge-probe-478.log). Wire-contract reading
first (tools/net-bridge.js + os-common.js createNetFetch, both at HEAD):

- Request bodies: forwarded VERBATIM (`init.body` → POST /fetch body → Buffer
  concat → upstream `init.body`). Binary-safe. **Declared cap: 32 MB request
  body** (`BODY_CAP`, loud 413) — a >32 MB push through the BRIDGE fails loud;
  headless direct fetch has no such cap. Recorded as an inherited, declared limit.
- `content-type: application/x-git-*-request` and `accept:` request headers:
  forwarded (not in STRIP_REQ; only hop-by-hop names are stripped).
- Response: streamed with backpressure (`res.write` + drain), content-type
  forwarded in `x-guc-headers` JSON (STRIP_RESP drops only framing/encoding
  names). No response-size cap.
- Redirects: bridge follows and surfaces the final URL (`x-guc-final-url`),
  which the kernel already turns into the synthetic header line the subtransport
  reads. Same semantics in direct mode via `Response.url`.
- Blocking `curl_easy_perform` vs streaming: moot at this layer — the kernel fd
  model decouples the fetch from the consumer; the subtransport's read() pulls
  under `__wait`, and bridge/direct modes are indistinguishable above the
  netFetch choke (that is the choke's contract).

**LIVE MEASUREMENT (2026-08-08, `build/bridge-probe-478.cjs`, log at
`build/bridge-probe-478.log`): PROBE PASS, 16/16.** The far end of every request
was the HOST'S REAL git (`tests/kernel/lib/gitserve.js`, upload-pack/receive-pack
in --stateless-rpc mode); the bridge was the real `tools/net-bridge.js` on an
ephemeral port; baseline = the identical requests over direct Node fetch.

```
  ok   adv: bridged status == 200
  ok   adv: content-type forwarded            (application/x-git-upload-pack-advertisement)
  ok   adv: bytes identical to direct
  ok   adv: advertisement is smart
  ok   pack: bridged status == 200
  ok   pack: content-type forwarded           (application/x-git-upload-pack-result)
  ok   pack: response is multi-MB             (5248444 bytes raw)
  ok   pack: demuxed pack payload identical to direct (5244921B)
  ok   pack: bridged payload contains a PACK header
  ok   pack: bridged pack passes host git index-pack
  ok   push: bridged status == 200            (REAL binary pack as POST body)
  ok   push: report-status says unpack ok
  ok   push: SERVER-side ref == pushed sha
  ok   push: server fsck --strict clean
  ok   redirect: followed to 200
  ok   redirect: x-guc-final-url names the REAL repo
```

One probe iteration was needed to get the oracle right, and the failure it fixed
is worth recording: RAW response byte-identity failed (5248424 vs 5248444 bytes,
different hashes) because every POST spawns a fresh `git upload-pack`, and
side-band-64k FRAME BOUNDARIES are that invocation's own buffering artifact.
The demuxed band-1 pack payload is byte-identical, and the bridged pack indexes
clean under host `git index-pack --fix-thin`. Not a bridge defect — a wrong
oracle, corrected.

**Verdict: no bridge ticket is needed.** The one inherited, declared limit:
`BODY_CAP = 32 MB` on bridge request bodies — a >32 MB push THROUGH THE BRIDGE
fails as a loud 413 (headless/direct fetch is uncapped). Not silently widened
here; recorded as the bridge's documented v1 posture.

## What landed

- **`vendor/libgit2/http_subtransport.c`** (new): the real
  `git_smart_subtransport_http` — the four smart-HTTP actions over the kernel
  HTTP fd primitives (`__http_open`/`__http_status`/`read`/`close`/`__wait`,
  the WAIT-first discipline). Stateless rpc=1: one stream = one request;
  write() buffers the request body (platform fetch cannot stream uploads —
  the curl veneer's documented posture), first read() performs, then the
  response STREAMS through the backpressured fd (a clone pack never sits
  whole in process memory — the reason the subtransport speaks to the
  primitives rather than through `curl_easy_perform`, argued above).
  Content-type validated (dumb protocol = loud error), 401 → Basic auth via
  URL userinfo then `git_transport_smart_credentials` (≤3 attempts →
  GIT_EAUTH), redirect re-base from the #359 `x-guc-final-url` line.
  Public-header-only deps (own grow-buffer/base64/userinfo parse) — no
  internal libgit2 headers, matching the missing_stubs.c posture. The stub in
  `missing_stubs.c` is deleted; `transport.c`'s builtin table lights up
  http:// and https:// with no registration code.
- **`os/git/git.c`**: `clone` / `fetch` / `pull` / `push` / `remote
  [-v|add|remove]`. pull is FAST-FORWARD ONLY (no merge verb exists; a
  diverged branch is a loud fatal, never a guess); `git pull <remote>`
  integrates THAT remote's branch (the configured upstream only serves bare
  `git pull`). push DWIMs a bare branch name into a full refspec (libgit2
  wants full refspecs) and preserves `+` force. Credential callback reads
  git's own credential-store format (`$HOME/.git-credentials`, then
  `$HOME/.config/git/credentials`) IN-PROCESS; values are never echoed. A
  server per-ref refusal prints `! [rejected]` and exits nonzero.
- **Enrollment**: both bin.jsons + `mkgit2srclib.js` regenerated
  (`git2_srclib.h` 211 TUs, `--check` green) — the srclib package ships the
  subtransport too. `packages/git.json` 0.2 → 0.3.
- **Tests**: `tests/fakegit/net_verbs/` (offline surface: parse guards, remote
  round-trip, the loud transportless-clone error — 27/27 category green);
  `tests/kernel/test_git_net_e2e.js` + `tests/kernel/lib/gitserve.js` (the
  server's far end is HOST git via `upload-pack`/`receive-pack
  --stateless-rpc`; registered in the kernel run.js member list per #314).

## Acceptance evidence (headless)

**Kernel e2e: 31/31 ALL OK** — clone (multi-MB pack, blob sha256 byte-exact
vs host), fetch + FF pull + "Already up to date.", push judged SERVER-SIDE by
host git (`rev-parse` == in-OS sha, `git fsck --strict` clean, log subject and
blob content round-tripped), non-FF push refuses loud + server unmoved, auth
(credential-less clone fails NAMED; URL-embedded and ~/.git-credentials both
work; authed push lands), 301 redirect clone with the POST provably re-based
(server request log shows `POST /repo.git/git-upload-pack`, nothing on
`/moved.git`).

**Real remote, real internet** (manual, headless `node os/boot.js`):

```
Cloning into '/root/hw'...
Enumerating objects: 13, done.
Total 13 (delta 0), reused 0 (delta 0), pack-reused 13 (from 1)
7fd1a60b01f91b314f59955a4e4d4e80d8edf11d        <- in-OS rev-parse HEAD
```
Host `git ls-remote https://github.com/octocat/Hello-World.git HEAD` says the
same `7fd1a60b…` — gucOS cloned GitHub over https and agrees with GitHub about
where HEAD is. `log`/`cat README` render correctly.

**Breakage evidence** (`build/breakage-evidence-478.log`): the single break
(`git_smart_subtransport_http` early `return -1`, the pre-#478 stub) reddens
BOTH instruments — fakegit `26 passed, 1 failed` (net_verbs) and the e2e
(clone/push legs FAIL) — and the revert restores fakegit `27 passed` and the
e2e `ALL OK`. Negative control = the same suites green on the unbroken tree,
shown in the same log.

## One infrastructure gotcha worth keeping

The first cut of the e2e ran gitserve IN-PROCESS and every in-OS request rode
the 30 s headers deadline into ETIMEDOUT: `driveBoot` is **spawnSync**, so the
test process's event loop is dead for the whole boot. The server must be a
CHILD process (`spawnGitServer`, request log via `GET /__requests`). The
gotcha is now documented in gitserve.js itself — it will bite any future e2e
that serves HTTP to a driveBoot'd OS.

## Committed assertions this change invalidated (declared before touching)

- `os-git-cli.mjs` help-text check pinned *"merge, tag, reset and the network
  commands are not implemented"* and the `git version 0.2` line. Both became
  false the moment the network verbs landed. Re-cut with **MORE** coverage,
  not less: the help assertion now additionally requires `clone`/`fetch`/`push`
  to be listed (a network verb that silently vanished from help would fail it),
  and the version pin moved to `0.3`. The `unimplemented[]` verb list in git.c
  shrank (clone/fetch/pull/push/remote removed) — the fakegit `w_unknown_option`
  golden is unaffected (it tests `--wibble`, not a verb name), verified green.

## Declared bounds (no silent caps)

- Request bodies are buffered whole (fetch cannot stream uploads) — a push
  pack lives in process memory once; through the BRIDGE it is additionally
  capped at 32 MB (loud 413).
- pull is fast-forward only; merge/tag/reset remain unimplemented and say so.
- Auth is HTTP Basic only (TLS is the platform's; token hosts speak Basic).
  No credential helpers protocol, no askpass — the store file or the URL.
- Protocol is smart v0/v1 (no `Git-Protocol: version=2` header sent —
  libgit2 1.9's smart machinery is v0/v1; servers fall back transparently).

## GATE — `node tests/run.js --diff origin/main` (run 1, 2026-08-08)

Plan: **host, projects, fakegit, kernel, sweep** (per `--dry-run`; `os/git/`,
`vendor/libgit2/`, `packages/git.json` pull kernel+sweep+fakegit+projects+host).
Elapsed **~49 min** (2967671 ms). Log preserved at
`build/gate-478-run1-1786125140-preserved.log`.

Judged from the RUN-LEVEL artifact `build/test-run/summary.json`
(mtime 1786128119, post-dating the gate start 1786125140 — this run's record,
`filter: null`, all five suites present):

| suite | status |
|---|---|
| host | pass |
| py[projects,fakegit] | pass |
| kernel | pass (incl. `test_git_e2e.js`, `test_git_net_e2e.js`) |
| sweep | **fail (exit 1)** — one file |

**The sole sweep failure is `os-loopguard.mjs` — attributed to the KNOWN
intermittent #562, NOT to this lane.** Attribution by the four-step recipe:

1. **Can the diff reach it?** No. The diff is entirely git/libgit2
   (`os/git/`, `vendor/libgit2/`, `packages/git.json`, git test files).
   `os-loopguard.mjs` exercises the SDL blocking-loop refusal heuristic in the
   SDL veneer — no shared code, no shared suite total, no shared fixture.
2. **Do the file's own later legs contradict the failure?** Yes. The failing
   leg was *"callbacks app presenting in SDL_AppInit runs clean"* (a
   misclassification → exit 69), yet the SAME run's later leg *"callback-model
   SDL_Renderer app still presents (30 frames) after refusals"* PASSED — the
   callback model itself works; one heuristic leg flaked under load.
3. **Re-run alone on the IDENTICAL tree** (`os-sweep.mjs --repeat 3
   --filter=os-loopguard`): **3/3 passed, flake 0%, stable**. (This filtered
   re-run overwrote `build/test-browser/summary.json`; the run-level
   `build/test-run/summary.json` is the preserved gate authority.)
4. **Flaked elsewhere?** Yes — the kickoff names #562 (`os-loopguard.mjs`,
   ~60% under load, filed P0) as a live intermittent, and it false-redded a
   gate hours earlier.

Per the standing rule I did NOT repair the flake in this ticket and did NOT
re-run the gate until green. **My two git sweep members both passed in the
full run** (`os-git-cli.mjs` 18.0s, `os-git-net.mjs` 9.5s), as did both kernel
git e2es. The gate is GREEN for this lane's change set modulo the attributed
#562 flake.

**Handoff to @master:** merge on this targeted green — the only red is #562,
attributed with evidence above. The full pre-deploy sweep (rule 5) will re-run
the whole sweep on the composed tree at ship time; if #562 flakes there it is
the same known-flake call, not this lane.
