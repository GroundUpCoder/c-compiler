# Networking — the tier model

Status: designed 2026-07-09 (discussion log
`logs/2026-07-09/roadmap-network-desktop.md`); queue items `0052`
(loopback AF_INET — live ticket **#3**), `0054` (relay transport — live
ticket **#7**), `0182` (/bin/curl CLI).
**Tier 2 is LANDED** (2026-07-13): the kernel HTTP transport is
`todos/done/0172`, the curl easy veneer is `todos/done/0173` (which
superseded the original `0053` item — closed 2026-07-15); only the
`/bin/curl` tool remains (`0182`).
**Tier 2.5 is LANDED** (2026-08-01, ticket #349 Stage 1): the
off-by-default localhost HTTP bridge, below.

## Platform truth (don't re-litigate the constraint)

A browser page cannot open a raw TCP or UDP socket. Chrome's Direct
Sockets API exists only inside Isolated Web Apps — not the open web, not
designed around. What the platform gives us: **fetch** (full HTTP/1.1–3
via the browser stack), **WebSocket** (message-framed bytes over TCP; the
server must speak WS), **WebTransport** (QUIC streams + unreliable
datagrams), **WebRTC data channels** (P2P, needs signaling). Everything
below is built from those.

Headless (Node) has none of these limits. The browser/headless asymmetry
is permanent; each tier documents it rather than hiding it.

## Tier 1 — loopback AF_INET (`0052`)

`127.0.0.1` TCP implemented entirely in kernel.js: the AF_UNIX OFD
machinery (todos/done/0008) plus a kernel port table instead of BlockFS
rendezvous nodes. **No web constraint at all** — identical in browser and
headless. Unlocks the large class of client/server software that never
leaves the machine (httpd→client, nc, anything "listen on a port").
Non-loopback destinations fail `ENETUNREACH` until Tier 4 is configured.

## Tier 2 — HTTP via fetch, behind a curl facade (LANDED — `done/0172` + `done/0173`)

POSIX has no HTTP API; the de-facto standard C API is **libcurl's easy
interface**. We own the libc, so we do NOT port real libcurl (it wants
sockets underneath) — the shipped shape is a `<curl/curl.h>` easy-API
subset as an app-side library (`os/curl/`, todos/done/0173) backed by the
kernel fetch RPC family (opcode space 0x06xx, todos/done/0172; see
KERNEL.md "HTTP transport"). `curl_easy_perform` blocks via the deferred-RPC
machinery; the kernel worker does the actual `fetch()`. The `/bin/curl`
CLI did not fall out for free — it is `todos/0182`, done 2026-07-23:
`os/curl/curl-cli.c` over the unchanged easy veneer (`-s -o -X -H -d -f
-L`, curl-idiom exit codes), seeded as `/usr/bin/curl` (image v152).

Asymmetry: in the browser this is **CORS-gated** (same-origin +
CORS-permissive hosts only); headless Node fetch is unrestricted.
Documented, not hidden.

## Tier 2.5 — the localhost HTTP bridge (LANDED — ticket #349 Stage 1)

Tier 2's browser asymmetry (CORS-gated fetch) lifted by an OPT-IN
localhost proxy: `tools/net-bridge.js`, a single-file dependency-free
Node process THE USER RUNS THEMSELVES. With the cfgstore `net` setting
ON (`bridge on`, `url http://127.0.0.1:8199`; layers
`~/.config/net` > `/etc/net` > `/usr/share/net` — since #391 the baked
layer ships `bridge off` + the default url, so the layer paths exist
and the effective default stays **off, byte-identical to a build
without the feature**), the kernel embedder's fetch wrapper (os-common.js
`createNetFetch`, wired identically in kernel-worker.js and boot.js so
the two embedders never diverge) re-posts every transfer to the bridge,
which performs the real request with the user's native network identity
and streams the encapsulated response back. The Control Panel Network
applet is the switch; the toggle is LIVE via `kernel.watchPath` on the
store layers (the display-zoom pattern) — no reboot.

**This is NOT Tier 4's relay.** `tools/net-relay.js` stays the RESERVED
name for the unbuilt raw-TCP websockify relay below; the bridge speaks
HTTP only — request in, response out, one hop, no socket OFDs, no
shared wire format. The bridge rides the EXISTING Tier 2 transport
(KERNEL.md "HTTP transport") entirely above the kernel: the kernel sees
an ordinary fetch.

Security posture (Stage 1, deliberate): strict `127.0.0.1` bind with no
widen flag (a LAN-reachable bridge is an open proxy — that conversation
is Tier 4's); Origin allowlist (no-Origin local clients allowed;
browser origins must match localhost:any-port, the shipped deploy, or
`--allow-origin`); CORS + Private Network Access preflight answers
(the platform facts in Tier 4's list apply to the bridge too).

**Same-origin passthrough ruling (ticket #391, decided 2026-08-02,
landed 2026-08-09).** jku's standing invariant: **bridge ON must be a
strict superset of bridge OFF; bridge OFF a strict subset that fails
loudly where unsupported.** The wrapper therefore resolves every target
against `location.href` when a location exists (the browser embedder):
a target on the embedder's OWN origin takes the BASE fetch even with
the bridge explicitly ON, and everything off-origin goes bridged
ABSOLUTIZED (the relative form a caller used never reaches
`x-guc-url`). Rationale: the bridge exists to lift CORS and change the
identity of EXTERNAL egress; a same-origin fetch is never CORS-gated
and the origin already served the entire OS, so bridging it buys
nothing while adding real failure modes — a REMOTE bridge
(net-bridge-ssh) fetches the embedder-origin URL from its own loopback
(unreachable by construction, which is exactly how the Software
Manager broke: the shipped repo base is the relative `/packages`), a
dead-but-enabled bridge takes down the package system, and cookies
drop. Headless has no `location`: nothing resolves, nothing passes
through — a relative url fails loudly (EINVAL), the correct
strict-subset behaviour.

**Errno ruling (settled here, 2026-08-01 — the two documents used to
disagree and ticket #349's acceptance imported the wrong one).**
KERNEL.md's `fetch: null` → **ENOSYS** is about CAPABILITY: this
embedder has no HTTP at all (standalone pages stay offline) — that path
is untouched and still answers ENOSYS. A bridge that is configured ON
but not answering is a different condition: the capability exists, the
TRANSPORT is unreachable — so the wrapper pins **ENETUNREACH** on the
rejection (kernel.js honours a string `err.errno`; the C name/number
101 landed with #349), consistent with this file's existing uses of
ENETUNREACH for exactly that meaning (Tier 1's non-loopback refusal,
Tier 4's absent-relay refusal). The failure is prompt (localhost
connect refusal, bounded by the e2e at 3s), never a hang. Bridge-level
policy refusal (403) = EACCES; a bridge-reported upstream failure
(502) = EIO with the upstream's error text, matching direct-fetch
connect-failure semantics.

Stages NOT built (approved scope was Stage 1 only): Stage 1.5
(redirect/upstream-header observation — the bridge follows redirects
bridge-side like the kernel's `redirect:'follow'`), Stage 2 (raw TCP
socket broker — that is ticket #7's relay), Stage 3 (UDP).

**Remote egress — `tools/net-bridge-ssh.js` (ticket #380).** "The user's
network identity" is not always the WORKSTATION's: sometimes a request
should leave from some other machine. `node tools/net-bridge-ssh.js HOST`
runs the SAME bridge on HOST over ssh and `-L`-forwards it to the local
`127.0.0.1:8199` the `net` store already points at — so nothing in `os/`
changes, `net-bridge.js` is not modified, and the applet switch is the
switch it always was. Posture is UNCHANGED and arguably tighter: the
bridge still binds loopback, now on HOST where it is unreachable from
HOST's network too, and the ssh tunnel is the only path in; the origin
allowlist is enforced remotely, untouched. The remote needs only sshd, a
POSIX shell and node >= 18 (global `fetch` — checked in preflight, since
otherwise it surfaces as a bare `fetch is not defined` at the FIRST
proxied request rather than at startup). The bridge source is shipped
INLINE per run into a per-run `/tmp` file, never scp'd to a stable path:
a persistent remote copy running an older wire contract against a newer
`createNetFetch` is the drift class this repo refuses. Teardown is three
layered guarantees, because no single one covers every exit — a remote
stdin-EOF watchdog (the only one that survives `kill -9` of the wrapper,
since nothing local runs then), remote shell traps for a dropped channel,
and a bounded `pkill -f <per-run-token>` reaper on graceful shutdown.
Two gotchas are load-bearing and commented in the file: the watchdog must
read a SAVED fd (`exec 9<&0`), because POSIX assigns an async list's stdin
to `/dev/null` in any non-interactive shell — read fd 0 and it EOFs
instantly and kills the bridge on startup; and the reaper's pattern is
bracketed (`[g]uc-nbssh-…`) so it cannot match its own command line, which
otherwise kills the reaper's shell instead of the bridge. Not CI-testable
end to end (needs a reachable sshd); `--dry-run` prints the composed ssh
argv and starts nothing.

Tests: `tests/kernel/test_netbridge_e2e.js` (the paired
positive-control run: OFF/ON/OFF/ON-dead flipped live by one process,
the bridge's request counter as the discriminator; + the #391
bridge-ON relative-url headless leg) + `tests/host/
test_netbridge_wrapper.js` (leg E: path selection under a mocked
`location` — passthrough/bridged/no-location proven by counters) +
`tests/browser/os-gucman.mjs` (bridge-ON leg: gucman works with the
bridge ON via passthrough, the /fetch counter as the which-path
discriminator) + the ctlpanel e2e's Network-applet leg.

## The ticket bridge — filing a ticket OUT of gucOS (LANDED — ticket #451)

A SECOND single-file host bridge, the same shape as Tier 2.5's and
deliberately separate from it: `tools/ticket-bridge.js` on
**127.0.0.1:8210**, serving `POST /file` and `GET /health`. It lets the
in-OS `/usr/bin/file-gucos-ticket` client (`os/file-gucos-ticket.c`) file
a ticket — or raise an alert — on the host that is running the OS.

**The PATH-command contract, which is the entire interface.** On a valid
request the bridge runs a command named **`file-gucos-ticket`**, resolved
from the HOST's PATH, with **fixed argv, the request JSON on stdin, never
through a shell**, and relays that command's stdout and exit code. That
command is NOT part of this repo and this repo does not describe it: the
ONE fact the tree knows about the outside world is that such a command
MAY exist. What filing a ticket means — which tracker, which project,
which credentials — lives entirely on the host side of that wire. A host
without the command installed is answered **501** ("no ticket handler
installed"), so the OS gets a truthful answer instead of a mystery, and
the e2e drives everything against a FAKE handler it plants on a private
PATH dir (acceptance must never depend on real tooling existing).

Transport is the plain Tier 2 HTTP seam (`__http_open`), so the client
needs no kernel opcode and no host.js import of its own, and it transits
the Tier 2.5 net bridge whenever the `net` store says `bridge on` with
no special-casing at either end. Wire: one JSON object
`{kind, title, body?, priority?, difficulty?}` (`--body -` reads stdin);
`kind` is `ticket` or `alert` and the HANDLER decides what an alert
means. Base URL from a new `ticket` cfgstore (`url` key; layers
`~/.config/ticket` > `/etc/ticket` > `/usr/share/ticket`, nothing baked),
default `http://127.0.0.1:8210`.

Posture is net-bridge's, copied wholesale and for the same reasons:
strict loopback bind with no widen flag, `originAllowed` verbatim,
CORS/PNA preflight answered for every origin with enforcement on the
real request as a READABLE 403 (#393). No auth token — 127.0.0.1 +
the Origin allowlist is the gate, and revisiting that is a decision
about BOTH bridges at once. Because this endpoint **spawns a process**
it adds abuse limits net-bridge does not need: 64 KB request body,
256 KB handler stdout, a 30s handler timeout (then SIGKILL), and 2
in-flight execs behind a bounded queue (503 past it).

The encapsulation convention carries over, and it is what keeps the two
failure classes apart: a handler that ANSWERED gets **200 +
`x-guc-exit: N`** (CORS-exposed) carrying its stdout — so a nonzero exit
is reported in-OS as *the host handler rejected your ticket*, with its
own words — while every bridge-level refusal is a bare status with no
`x-guc-exit` (400 non-JSON body, 403 origin, 413 cap, 501 no handler,
502 handler died/timed out/overflowed, 503 too busy) and is reported as
*the bridge refused the request*.

Not built, deliberately (v1 scope): no Control Panel applet and no
auto-start/process manager (net-bridge has neither either — the user
runs `node tools/ticket-bridge.js`).

Tests: `tests/kernel/test_ticketbridge_e2e.js` — the real client against
the fake handler in BOTH net modes (the net-bridge `/fetch` counter is
the bridge-ON transit proof), every negative leg above, and a
`driveBoot` leg running the SHIPPED binary out of the baked image.

## Tier 3 — DNS via DoH (folds into the HTTP stack `done/0172`/`0173`, on demand)

`getaddrinfo` backed by DNS-over-HTTPS (the public DoH endpoints are
CORS-permissive) — plain fetch, no relay. Until then: static
`localhost` → 127.0.0.1 only.

## Tier 4 — arbitrary hosts via a pluggable relay (`0054`)

websockify pattern: the kernel dials `ws://localhost:PORT`, the relay
(`tools/net-relay.js`, ~100 lines of Node we ship) dials TCP and pumps
bytes into the socket OFD.

Key platform facts making the **localhost relay** work even when the
page is hosted elsewhere (e.g. a public https host):

- `localhost`/`127.0.0.1` is a *potentially trustworthy origin*, so
  `ws://localhost:PORT` from an https page is allowed in Chrome and
  Firefox (Safari is the holdout — compat note, not a blocker).
- WebSocket is not CORS-gated; the relay chooses which `Origin` values
  to accept (allowlist option).
- Chrome's Private/Local Network Access rules: the relay answers the
  preflight (`Access-Control-Allow-Private-Network: true`); newer Chrome
  adds a one-time user permission prompt — acceptable.

The localhost relay is a **feature, not just a workaround**: it runs
with the user's network identity, so the in-browser OS can reach their
LAN, dev servers, databases. A server-side `wss://` relay would give
zero-setup networking but makes the host an open TCP proxy
(auth/abuse) — NOT the default; the transport stays pluggable on the
kernel embedder (like the Dawn tier: absent → `ENETUNREACH`). Headless
transport is a direct `net.Socket` (no relay needed; tests may point at
the relay anyway to exercise it).

## Decisions

- **Order**: loopback first, curl facade second, relay last. Each tier
  is independently useful; none blocks another.
- **Pluggable transport** on the embedder; loopback always works.
- **TLS boundary**: the OS does not grow a TLS stack. https = Tier 2
  (the browser/Node fetch stack owns TLS); Tier 4 dials plain TCP.
- **UDP/SOCK_DGRAM**: only meaningful via WebTransport datagrams through
  a relay — on demand, no speculative build.
- P2P (WebRTC data channels — two OS tabs networking directly) is a
  recorded stretch idea, unscheduled.
