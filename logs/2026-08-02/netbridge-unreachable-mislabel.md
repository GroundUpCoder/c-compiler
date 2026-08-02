# #393 — the "bridge unreachable" mislabel, and why the fix has four sites

Ticket #393 (filed off the #391 root-cause pass): `createNetFetch`'s rejection
handler branded EVERY bridge-fetch rejection *"net bridge unreachable … is
tools/net-bridge.js running?"* / `ENETUNREACH`. The message is only true for a
transport failure — but rejections happen for other reasons, all of which a
perfectly healthy bridge can cause. #391's diagnosis stalled precisely because
the reporter went looking for a dead bridge that was up the whole time.

## Why "any rejection = unreachable" was wrong in practice

The fulfilled path already named bridge HTTP statuses honestly, so the mislabel
lived entirely in what could REJECT despite a live bridge:

1. **The wrapper's own encapsulation.** The target url/method/headers ride in
   HTTP header values (`x-guc-*`), which fetch caps at Latin-1. One char past
   0xFF — a `π` in a path, an emoji in a header — and `fetch` rejects with a
   ByteString TypeError *before any packet is sent*, which the handler then
   blamed on the bridge. This is the exact pre-fix repro:
   `net bridge unreachable at … (Cannot convert argument to a ByteString
   because the character at index 24 has a value of 960 …)`.
2. **The bridge's 403 origin-refusal carried no CORS headers** (and the
   preflight 403'd outright). In a browser both are an opaque TypeError —
   indistinguishable from a dead bridge by construction. Node-only tests never
   saw this because Node fetch ignores CORS.
3. **The bridge's 413 destroyed the socket mid-upload** (`req.destroy()`), so
   the client could see a connection reset instead of the answer. Timing-
   dependent: on loopback the response often wins the race, which is why this
   never showed in the e2e — but "often" is not a diagnostic contract.

## The fix, by site

- **`os/os-common.js` (bridgeFetch)** — make the hop transparent rather than
  rejecting: the url normalizes to `new URL().href` (ASCII by construction —
  percent-encoded path/query, punycoded host — the same bytes direct fetch puts
  on the wire, so no semantic change); the header JSON ASCII-escapes everything
  past 0x7F with JSON's own `\uXXXX` mechanism, which the bridge's existing
  `JSON.parse` reverses losslessly (astral pairs included) — **zero wire-format
  change, works against any deployed bridge**. What remains invalid (unparsable
  url, non-token method) rejects `EINVAL` naming the value. The fulfilled path
  now says "the bridge at … is RUNNING but answered HTTP N" (403 keeps EACCES;
  502 is explicitly EIO + the upstream's text per the NETWORK.md ruling; a bare
  200 without `x-guc-status` is called out as not-the-bridge-protocol — the
  wrong-server case). The rejection handler keeps `ENETUNREACH` + the old
  message for what's left — genuine transport failure — and now surfaces
  `err.cause.message`, where undici hides `connect ECONNREFUSED …`.
- **`tools/net-bridge.js`** — same mislabel class one hop over: the 403
  refusal now carries CORS headers (echoing the refused origin only lets that
  page READ the refusal; nothing is proxied), the preflight answers for every
  origin (it only unlocks *sending*; enforcement stays on the POST, which is
  now readable), and every early answer (400/403/404/413) drains the request
  instead of racing or destroying it. 413 gets a body naming the cap.
- **`tests/kernel/test_netbridge_e2e.js`** — Leg B's "preflight from a
  disallowed origin: 403" assertion encoded the old opaque behavior; replaced
  with 204-preflight + readable-403-POST + still-proxied-nothing.
- **`tests/run.js`** — `tools/net-bridge.js` now also maps to `host`, because:
- **`tests/host/test_netbridge_wrapper.js` (new, registered in host/run.js)**
  — the cheap firing test the acceptance demanded: fake bridges for the status
  labels, a dead port for the preserved ENETUNREACH leg, an echo server
  asserting the wire values are pure ASCII and round-trip losslessly, and the
  REAL net-bridge.js for the 413-drain and CORS-refusal legs. Red control run
  and recorded: 13/21 checks fail with the fixes stashed (exit 1).

## Notes

- Deliberately NOT mapped: 400/413 to specific errnos beyond the recorded
  ruling (403→EACCES, 502→EIO). Unpinned statuses take the kernel's EIO
  default; the message carries the status either way.
- The residual ambiguity is honest: in a browser, a rejection with CORS-less
  intermediaries can still only say "(Failed to fetch)". Everything the bridge
  itself answers is now labelled with its real status, which is the boundary
  this ticket asked for.
