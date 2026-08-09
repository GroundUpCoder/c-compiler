# #362 — the net bridge from the shipped https origin (Chrome Local Network Access)

Lane: lane-362, branched from `5390e0ef`. Ticket #362 asks 1, 2 and 4
(ask 3 — the baked `/usr/share/net` — landed with #391 at `6d52c8a8` and
was re-verified on the base: `os/image.json` defines it; reported
already-satisfied, not redone).

## The platform rule, pinned empirically (ask 1's research)

The ticket's measurement — 3/3 targets `ENETUNREACH`, the bridge healthy,
its `/fetch` counter at ZERO, zero preflights — is exactly what Chrome's
**Local Network Access** (LNA, the Private Network Access successor)
produces. LNA shipped enforcing in **Chrome 142** (the sweep pins
Chromium **149**; Playwright 1.61): any fetch from a *public* origin to
loopback/private space requires a one-time user permission
(`local-network-access`), and a **worker-context fetch cannot raise the
prompt** — it is silently denied with a bare `TypeError`, before any
bytes (preflight included) reach the wire. Sources: the Chrome
developers blog "New permission prompt for Local Network Access"
(developer.chrome.com/blog/local-network-access), which also states
that worker requests require the origin to have been granted the
permission beforehand.

Probe against the pinned Chromium 149 (a fake public https origin via
`--host-resolver-rules=MAP prod.test 127.0.0.1` +
`--ip-address-space-overrides=127.0.0.1:PORT=public`, fetching an http
loopback server from page / worker / nested-worker contexts):

| variant | page | worker | nested worker | wire |
|---|---|---|---|---|
| default (no grant) | TypeError | TypeError | TypeError | **zero requests** |
| `grantPermissions(['local-network-access'])` | 200 | 200 | 200 | GET /health |
| `--disable-features=LocalNetworkAccessChecks` | 200 | 200 | 200 | GET /health |

So this is **not** a pure honest-negative: the platform permits the hop
behind a user grant — but the grant can only be *raised* from the page.
The old PNA preflight answer (`Access-Control-Allow-Private-Network`)
the bridge already sends is neither sufficient nor consulted for the
permission; CORS itself still applies once the permission is granted.

## Hypotheses formed and refuted (so nobody re-spends them)

- **"The bridge's PNA/CORS preflight answer must be wrong."** Refuted:
  with the permission granted, the *unmodified* bridge completes the
  preflighted POST /fetch from a genuinely public https origin
  (os-netbridge-https.mjs leg 2). The preflight was never the blocker —
  under LNA the request is denied before any preflight is attempted,
  which is why the counter AND the OPTIONS path both read zero.
- **"Mixed content blocks https→http://127.0.0.1."** Refuted for
  Chromium: loopback is a potentially-trustworthy origin and is exempt
  from mixed-content blocking (the probe's granted leg succeeds with a
  plain `http://127.0.0.1` URL, no `targetAddressSpace` annotation
  needed — the hostname is an IP literal, classified pre-resolution).
- **"`permission: 'prompt'` means the browser is blocking."** Refuted on
  LOCAL origins: on `http://localhost` (dev serve.js) Chrome reports
  'prompt' while gating nothing — local→local is exempt. Measured live
  in the os-gucman bridge leg; it forced the ctlpanel verdict to require
  an https page origin before blaming the browser (a dead bridge on a
  dev origin must stay a dead bridge).

## What landed (ask 1, both halves)

1. **Page-side permission priming** — the fix half. The kernel worker
   announces the effective `net` config to the page
   (`netFetchAttach(netFetch, kernel, kfs, onChange)`, the
   displayAnnounce pattern; boot.js passes nothing and is unchanged).
   os.html, when the bridge is ON with an off-origin url, probes from
   window context: `permissions.query({name:'local-network-access'})`,
   then a `/health` fetch — **the fetch is what raises the prompt**,
   right at the applet click that enabled the bridge — then re-reads the
   permission (the user may have just answered) and re-probes on later
   grants via `PermissionStatus.onchange`. The verdict posts back and
   the worker records `/run/net-status` (`writeNetStatus`, the
   /run/host-platform pattern: per-boot fact, no layering).
2. **Honest product reporting** — the say-so half. The Network applet's
   Test (`net_fail`) consults `/run/net-status` on an ENETUNREACH
   failure: https origin + permission denied/prompt → "Result: blocked
   by the browser, not the bridge" + "Allow local network access for
   this site, then retest."; https origin + unsupported → "Result:
   unreachable from an https origin" (non-Chrome browsers have no such
   permission and block the hop outright); local origin or granted →
   the generic strerror (dead bridge). A new detail STATIC carries the
   actionable second line (applet 292→320 tall). The wrapper's
   ENETUNREACH message also names the permission when the page is https
   and the bridge loopback (errno semantics untouched — error-TEXT
   plumbing through the kernel transport is #392's, left undone).

## Coverage (ask 2)

- `tests/browser/os-netbridge-https.mjs` (new sweep member, discovered —
  no registry edit): the REAL `createNetFetch` in a worker on the fake
  public https origin against the REAL `tools/net-bridge.js`. No-grant
  leg pins the platform block (rejects ENETUNREACH, message names the
  permission, ZERO wire requests — the prod measurement as a permanent
  record; a Chromium bump changing the story fails this loudly).
  Granted leg proves the full hop: preflighted POST, decapsulation,
  #359 final-url readable cross-origin. **Red control run**: stripping
  `x-guc-status` from the bridge's `access-control-expose-headers`
  fails 4 checks (exit 1) — the browser-only CORS class no same-origin
  test can see.
- `test_netbridge_e2e` leg C2: the four Test verdicts headless against
  a planted `/run/net-status` (headless has no page writer). Sub-case
  order is load-bearing: consecutive expected labels must differ or a
  wait is satisfied by stale text.
- os-gucman bridge leg: the real page-probe pipeline (announce → window
  probe → `/run/net-status`) in a booted browser — the one place the
  real writer runs; headless can only plant the file.

## Doc (ask 4)

`todos/NETWORK.md`: the Stage 1 parenthetical "(the platform facts in
Tier 4's list apply to the bridge too)" replaced — the bridge is a
`fetch()` and IS CORS-gated (Tier 4's "WebSocket is not CORS-gated"
asserted the opposite for this tier); only the trustworthy-origin
carve-out transfers. Plus the #362 measurement + resolution paragraph.
One hunk; nothing else in the file touched.

## Notes for the merge

- `os/image.json` version line untouched (lane-505 owns it). ctlpanel.c
  is a bake input, so the persistent-browser-OPFS image needs the
  version bump that #505's merge is already taking — no action here,
  but the ship that carries this lane must include a bump.
- What a real interactive user sees on prod now: enabling the bridge in
  ctlpanel raises Chrome's "access devices on your local network"
  prompt; Allow → bridge works (worker fetches inherit the grant);
  Deny/dismiss → Test says "blocked by the browser, not the bridge".
  Non-Chromium browsers keep the honest "unreachable from an https
  origin" negative.
