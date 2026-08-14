# #669 — curl veneer: chunked parks make the progress callback tick (the gcode "waiting for model" heartbeat)

**Class: quality-gap** (per the ticket; permitted-envelope behavior, measured harm —
7 of 235 gcode api_rounds over 60s with zero output, two healthy turns ^C'd as
suspected wedges). Governing contract: `CURLOPT_XFERINFOFUNCTION` — upstream curl
documents the callback as called "frequently … during slow periods … about one call
per second". The veneer's own comment claimed "every wait boundary … asks the
callback", but during a silent wait no boundaries existed.

## Mechanism (re-derived at 911e6a78 before changing anything — it matched the ticket)

- `check_progress` runs only at the tops of the status/body loops, immediately
  before parking (`os/curl/libcurl.c` 424/501 pre-change).
- `wait_step` parked in `__wait(&fd, 1, 0, -1)` whenever no `CURLOPT_TIMEOUT` was
  set. gcode sets only `CONNECTTIMEOUT` (30s → the kernel headers deadline), never
  `TIMEOUT`, so during a silent model wait the callback ran once (<2s, under
  gcode's display threshold) and the process parked indefinitely until bytes or a
  signal. `gcode.c:501-533` (`curl_progress`/`progress_show`) never got a second
  call — the #507 API-wait heartbeat was structurally dead in-OS.

## Fix (veneer-side, the ticket's preferred shape)

`wait_step` now caps each park at `PROGRESS_WAIT_MS` (1s) when a progress callback
is armed (`NOPROGRESS 0` + `XFERINFOFUNCTION`). A chunk expiry (`why == 0` on a
chunked park) is a **retry**, not a timeout — the loop re-checks the fd (one cheap
EAGAIN) and reaches `check_progress`, so the callback ticks ~1/s through a silent
wait. Only a real whole-operation-deadline expiry still maps to
`CURLE_OPERATION_TIMEDOUT`. When the remaining deadline is under 1s, the park is
the remainder (unchunked), so timeout detection is never late.

Why veneer-side, not a gcode-side per-chunk timeout: the 1s idle tick is what the
standard name promises (upstream's documented cadence), so putting it in the veneer
is the honest shape — and it serves every consumer. NetSurf's vendored curl fetcher
(`content/fetchers/curl.c:2061`) also arms a progress callback and was written
against real libcurl's ticking; it now gets what it expected. Consumers without a
callback are byte-identical (the chunk is gated on the callback being armed).

## Instruments (differential, in `os/curl/test/smoke.c` + `tests/kernel/test_curl_e2e.js`)

- `hbstatus`: new `/stallhdr` endpoint (server accepts, never responds — the exact
  gcode silent-wait shape, dlnow pinned at 0). Callback aborts after 3 ticks →
  `rc=42 ticks_ge_3=1`. Deliberately NO `CURLOPT_TIMEOUT` — pins the `-1`-park
  path; a regression rides the kernel's default 30s headers deadline to rc=28.
- `hbbody`: `/stall` (bytes arrive, then silence). Ticks count only once data has
  been seen and stopped moving, so the fast local pre-response phase can't trip the
  abort early → `rc=42 midstall=1`. 15s `TIMEOUT_MS` backstop (the #306 pattern).
- The #306 `abortcb` case could not see this bug: it aborts at the boundary a byte
  creates; these two prove boundaries exist DURING the stall.
- **Red control run** (pre-fix `libcurl.c` from main, new tests): `hbstatus` fails
  as `rc=28 ticks_ge_3=0`, `hbbody` as `rc=28 midstall=0`, differential fails —
  exactly the predicted failure signature. The instruments bite.
- **Native oracle agrees**: real libcurl produces byte-identical section output for
  both new cases (`rc=42` + the booleans), confirming the 1s chunk reproduces
  upstream's contract rather than inventing a veneer-only behavior.

## Gotchas recorded

- Kernel HTTP defaults (kernel.js): headers 30s, idle 120s. The heartbeat cases
  abort at ~3s, safely inside both.
- The e2e's normalize() diffs whole outputs — new sections print only
  deterministic rc/boolean lines, no header names.
