# #391 — net bridge: same-origin passthrough + URL absolutization at netFetch

Lane `lane-391`, base `e907e954`. P0: with the bridge ON, gucman could not
fetch `/packages/index.json` — the Software Manager showed only installed
packages and every uncached install/remove died "Couldn't connect to server".

## What landed

`os/os-common.js` `netFetch` (the ONE choke point): with a real `location`
(the browser embedder), every target resolves against `location.href`;
same-origin targets take the BASE fetch **even with the bridge explicitly
ON** (T1 — ruled on the decision docket 2026-08-02, jku's invariant "bridge
ON is a strict superset of bridge OFF" is satisfiable only by T1); off-origin
targets go bridged ABSOLUTIZED so a relative form never reaches `x-guc-url`.
Headless has no `location`: no passthrough, relative urls keep failing loudly
(EINVAL) — the correct strict-subset behaviour, deliberately preserved.

Folded in from #362's asks: `os/image.json` now bakes `/usr/share/net`
(`bridge off` + the default url) so all three `NET_LAYERS` watchPaths arm on
an existing path. Effective default unchanged (off). v245 → v246.
`os/netcfg.h`'s "none is baked" comment and NETWORK.md updated to match.

## Decisions the ticket did not settle

- **The ticket's wire symptom had drifted.** It describes the relative url
  reaching the bridge verbatim and 400ing. Since #393, `bridgeFetch`
  EINVALs an unparsable url client-side, so the shipped failure today is a
  prompt `EINVAL: invalid target url "/packages/index.json"` — same class,
  same user-visible "Couldn't connect" after the curl fold, same fix.
  Verified by running the new wrapper leg against the pre-fix os-common.js
  (red control: it dies on exactly that EINVAL).
- **Passthrough hands base the caller's EXACT args**, not the resolved
  href — the browser's fetch resolves relative urls against the same
  location, and it keeps the tail-call transparency the OFF path already
  documents. Absolutization applies only to the bridged path.
- **Opaque origins never match**: a `location.origin === 'null'` (sandboxed
  page) is refused as a passthrough basis — such traffic stays bridged.
  Cheap guard against `'null' === 'null'` false matches.
- **The only relative-but-off-origin shape is protocol-relative**
  (`//host/path`); it now bridges absolutized (pre-#391 it was EINVAL).
  Covered in wrapper leg E.
- **Kernel e2e phase 6 needs its own ack** (`# p6` comment line in the
  written config): the harness acks are content-keyed and phase 3's plain
  `bridge off` ack file persists, so a second identical write would ack
  instantly and race the live watch.
- **Browser leg's settle barrier IS the positive control**: the live
  /etc/net watch has no OS-visible completion marker, so the off-origin
  curl retries until the bridge's /fetch counter moves — proving the switch
  engaged AND that later counter stability discriminates the path taken.

## #362 overlap (observed, NOT fixed here — per the kickoff)

#362 (bridge unreachable from the shipped https prod origin; PNA/CORS
preflight never succeeds) is untouched. Note the interaction: after #391,
a session on a local http origin with a REMOTE bridge (net-bridge-ssh) now
works for same-origin traffic — that is jku's reported session. From the
https prod origin, off-origin bridged traffic still dies per #362; the new
passthrough additionally means same-origin traffic on prod no longer
depends on the bridge at all, which shrinks (but does not close) #362's
blast radius.

## Tests

- `tests/host/test_netbridge_wrapper.js` leg E: path selection under a
  mocked `location`, proven by WHICH url the counting base fetch received
  (passthrough = caller's url; bridged = `<bridge>/fetch` + absolutized
  `x-guc-url`). Red on pre-fix code.
- `tests/kernel/test_netbridge_e2e.js` phases 5/6: headless bridge ON +
  relative → prompt EINVAL pre-wire; bridge OFF + relative → still loud.
- `tests/browser/os-gucman.mjs` bridge-ON leg: real net-bridge.js, gucman
  install succeeds with the /fetch counter untouched; off-origin control
  transits it.
