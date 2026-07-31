# #349 — Tier 2.5 HTTP bridge, Stage 1 (branch 0349-http-bridge)

Off-by-default localhost HTTP proxy + Control Panel applet. jku approved
**Stage 1 only** ("for the http I just want stage 1"); Stage 1.5
(redirect observation), Stage 2 (raw TCP broker) and Stage 3 (UDP) are
explicitly NOT built and NOT scaffolded for.

## What the seam actually is (the ticket's `_fetch` was fictional)

The ticket body named a kernel-worker `_fetch` reroute; no such symbol
exists. The real seam is `Kernel({fetch})` (kernel.js `this._fetch`,
KERNEL.md "HTTP transport") — the kernel runs whatever fetch the
embedder hands it, and neither embedder passed one before (both fell to
the bound global). So the reroute lives entirely ABOVE the kernel:
os-common.js `createNetFetch()` returns a wrapper both embedders now
pass at construction, and `netFetchAttach()` resolves the cfgstore
`net` overlay and re-resolves on every settled layer write via
`kernel.watchPath` (the display-zoom precedent). kernel.js itself
changed by ONE clause: `_httpStart`'s rejection handler honours a
string `err.errno` pinned by a wrapper. The kernel keeps seeing an
ordinary fetch; standalone pages, no-fs kernels, and every `fetch:
null` path are byte-untouched.

## The errno ruling (the two documents disagreed; settled in NETWORK.md)

The acceptance imported Tier 4's `ENETUNREACH` sentence; KERNEL.md says
`fetch: null` → `ENOSYS`. Both are right about DIFFERENT conditions,
and the ruling separates them by what is absent:

- **ENOSYS = no capability.** This embedder has no HTTP at all.
  Untouched — the existing path still answers it.
- **ENETUNREACH = transport unreachable.** The capability exists, the
  bridge is configured ON, and nothing answers at its URL. That is the
  same meaning this repo already gives ENETUNREACH twice (Tier 1's
  non-loopback refusal, Tier 4's absent-relay refusal), so the bridge
  joins the convention rather than inventing a third code.

Mechanically that needed `ENETUNREACH` to EXIST: the libc had
`EHOSTUNREACH` (113) but not `ENETUNREACH` (101), and host.js's
`setErrnoName` THROWS on unknown names — a kernel reply naming it would
have crashed the process worker. Landed as the first commit (errno.h
`#define` + strerror + host errnoMap + the kernel passthrough). The
failure is prompt — localhost connect refusal, asserted under a 3s
bound in the e2e — never a 30s headers-deadline hang.

Mapping table carried on the wrapper: bridge 403 (origin policy) →
EACCES; bridge 502 (upstream fetch failed) → EIO with the upstream's
error text (matches direct-fetch connect-failure semantics, and the
curl veneer's exit-7 mapping); wrapper-level bridge-unreachable →
ENETUNREACH; abort stays abort (close(2) semantics, not reachability).

## The bridge's security posture (tools/net-bridge.js)

- **Strict 127.0.0.1 bind, no widen flag.** A LAN-reachable bridge is
  an open proxy; "the user really wants that" is a Tier 4 relay
  conversation, not a CLI flag on this tool.
- **Origin allowlist.** No Origin header = a non-browser local client
  that already owns the machine's network — allowed. With an Origin:
  localhost/127.0.0.1 on any port (dev serve.js), the shipped deploy
  (https://groundupcoder.com), plus `--allow-origin` additions; `*` is
  an explicit opt-in. The threat model is arbitrary OTHER websites
  driving a user's bridge from a background tab — the two legitimate
  embedder origins default in, everything else is refused 403.
- **CORS + Chrome Private Network Access preflights answered**,
  including `Access-Control-Allow-Private-Network: true` — a public
  https page fetching 127.0.0.1 preflights every request.
- **Encapsulated responses** (`x-guc-status`/`x-guc-headers` on a
  bridge 200): "upstream said 403" stays distinguishable from "the
  bridge refused you" — bridge-level answers are plain statuses and
  never carry `x-guc-status`.
- **Naming:** deliberately NOT `tools/net-relay.js` — that name stays
  reserved for Tier 4's unbuilt raw-TCP relay (NETWORK.md), and the two
  share no wire format. Prose in both files keeps them distinct.

## Testing shape — the (HP) pairing, and two traps hit

The headline acceptance ("setting OFF: suite green, zero change") is an
absence claim an empty diff satisfies. So the e2e's leg A is ONE C
process that flips `/etc/net` OFF → ON → OFF → ON-dead live and the
assertion is the PAIR: all three OFF/ON fetches succeed AND the
bridge's `/fetch` counter reads exactly 1 (0 = reroute never engaged,
2+ = OFF leaked through). The red control (run pre-gate, per the gate
discipline) disables the wrapper's ON branch: every OFF check stays
green and all 7 positive controls go red — that spread is the proof
the pairing can see its subject.

Traps for the next author:

- **The embedder watch callback is a deferred `setTimeout(0)`
  coalescer** (kernel.js `_watchCbArm`) — a C program that writes the
  store and immediately fetches races it. No C-visible marker exists,
  so the e2e uses content-keyed ACK FILES: the harness registers its
  own `watchPath` AFTER `netFetchAttach`, and same-delay setTimeout
  FIFO guarantees the wrapper re-resolved before the ack lands. No
  fixed sleeps.
- **`driveBoot` is `spawnSync` — it freezes the test process's event
  loop.** A target HTTP server hosted in the test process deadlocks
  every in-OS fetch aimed at it (the first leg C draft did exactly
  that: curls hung to the headers deadline against a server that
  could not accept). Any server a spawnSync-driven boot talks to must
  be a CHILD PROCESS — leg C uses the bridge's own /health. Same
  class: fetch()'s pooled keep-alive socket dies during the block, so
  the health probe uses a fresh-connection `http.get`.
- **Agent needles are EXACT-match** (`agent_find` strcmp), not prefix —
  the applet Test-button verdict is asserted by waiting on the exact
  final STATIC text, and that leg lives in the netbridge e2e (which
  owns a running bridge) rather than the ctlpanel e2e (which does not).

## What was refused / left un-built

- Stage 1.5/2/3 — not approved, not scaffolded.
- No browser-sweep test: the browser-only delta is worker-global-fetch
  vs Node fetch inside the SAME wrapper + the bridge's CORS/PNA
  answers, which leg B exercises as a simulated browser (spoofed
  Origin, real preflight). A sweep test would need a bridge child
  inside the os-harness for marginal coverage; recorded here, not
  hidden.
- No baked `/usr/share/net` default: absence IS the off state, and it
  keeps os/image.json untouched (the image bump is the coordinator's).
- The bridge buffers request bodies (32 MB cap, loud 413) instead of
  streaming uploads — v1 kernel bodies are whole-buffer anyway
  (KERNEL.md), so streaming would be dead generality on this tier.

Live ticket refs resolved while writing NETWORK.md: legacy 0052 →
ticket #3 (loopback AF_INET), legacy 0054 → ticket #7 (relay
transport) — both open.
