# 0173 — libcurl easy-interface veneer over the kernel HTTP transport

- **Status**: done (2026-07-13)
- **Design**: rationale in logs/2026-07-13/0172-http-stack-plan.md

## Resolution

Landed as `os/curl/` (lib.json + `include/curl/curl.h` + `libcurl.c`, the
win32 app-side-library pattern; no kernel change). Full write-up:
logs/2026-07-13/0173-libcurl-veneer.md.

- Easy interface subset with **upstream ABI values** (option classes,
  CURLINFO nibbles, CURLcode numbers) so one consumer source builds against
  both the veneer and real libcurl without ifdefs.
- perform = `__http_open` → `__http_status` (synthesized status line +
  CRLF header lines to HEADERFUNCTION; content-type/length captured for
  getinfo) → `__http_read` loop → `__http_close`.
- Timeouts (TIMEOUT[_MS] total, CONNECTTIMEOUT[_MS] headers-arrival) via
  setitimer(ITIMER_REAL)+SIGALRM (0044): a posted signal EINTRs the parked
  HTTP RPC; deadline-passed → CURLE_OPERATION_TIMEDOUT, foreign-signal
  EINTRs re-park. Handler stays installed (real libcurl sans NOSIGNAL).
- Errno mapping: open fail → COULDNT_CONNECT (ENOSYS →
  UNSUPPORTED_PROTOCOL), status EIO → COULDNT_CONNECT (7), read -1 →
  RECV_ERROR; unknown options → CURLE_UNKNOWN_OPTION (+ VERBOSE stderr).
- READFUNCTION buffered; redirects follow silently (EFFECTIVE_URL =
  request url); descoped as planned: multi, cookies, TLS knobs, proxies,
  non-HTTP, upload streaming, PROGRESSFUNCTION.
- Acceptance: `tests/kernel/test_curl_e2e.js` (in the run.js manifest) —
  the differential smoke `os/curl/test/smoke.c` built BOTH ways against one
  local server; native output matched gucOS on the first full run after
  normalizing only the documented header order/casing divergences. Cases:
  streamed GET, POSTFIELDS + READFUNCTION POSTs, 404 (rc=0 + code 404),
  refused (7), stalled-body timeout (28), escape/unescape.

## Goal

An app-side `curl/curl.h` + `libcurl.c` library (lib.json, the win32-veneer
pattern — no kernel change) implementing the **easy interface** subset over
the 0172 RPCs. libcurl is the app-facing API on purpose: it's an external
frozen standard (nothing to design, only a subset to grow monotonically),
it's the port-enabler (git's HTTP transport, wget-ish tools compile), and it
makes every consumer **host-testable** — the same C source builds natively
with clang + real libcurl (macOS SDK ships headers; `clang x.c -lcurl` works
out of the box), giving a clang-as-oracle reference exactly like
tests/unit/conformance. Native run = reference behavior; gucOS run = system
under test.

## Scope (v1 — consumer-driven, /bin/code is the first consumer)

- `curl_easy_init/setopt/perform/getinfo/cleanup/reset/strerror`,
  `curl_slist_append/free_all`, `curl_global_init/cleanup` (no-ops),
  `curl_easy_escape/unescape`.
- CURLOPTs (~20): URL, CUSTOMREQUEST, HTTPHEADER, POSTFIELDS(+SIZE),
  POST/HTTPGET/NOBODY, WRITEFUNCTION/WRITEDATA, HEADERFUNCTION/HEADERDATA,
  READFUNCTION (buffered — feeds the whole-body v1 transport),
  FOLLOWLOCATION/MAXREDIRS (implemented IN the veneer: fetch redirect
  handling is opaque cross-origin in-browser, so open with redirect:manual
  semantics only if the transport exposes it — else document that redirects
  follow silently and FOLLOWLOCATION is accept-only), TIMEOUT_MS/
  CONNECTTIMEOUT_MS (drive HTTP_ABORT), USERAGENT (best-effort; forbidden
  header in-browser), ACCEPT_ENCODING (accept-only; fetch decompresses),
  VERBOSE (stderr), ERRORBUFFER, NOSIGNAL/NOPROGRESS (accepted no-ops).
- `getinfo`: RESPONSE_CODE, CONTENT_TYPE, CONTENT_LENGTH_DOWNLOAD_T,
  SIZE_DOWNLOAD_T, EFFECTIVE_URL (best-effort).
- Unknown options: return CURLE_UNKNOWN_OPTION but LOG under VERBOSE —
  loud-failure over silent-wrong, the kernel32 stub precedent.
- Header callback: synthesize a status line + `name: value\r\n` lines +
  blank line from the transport's header blob (curl contract; not
  wire-faithful order/casing — documented).
- **Descoped** (recorded): multi interface, cookies engine, TLS knobs
  (VERIFYPEER accepted, value ignored — platform TLS is not configurable),
  proxies, non-HTTP protocols, upload streaming, PROGRESSFUNCTION.

## Plan

1. `os/curl/` (or os/win32-style dir): curl.h subset + libcurl.c over the
   0172 host.js env imports; lib.json entry.
2. Differential smoke: one C program (fetch a URL, dump status/headers/body
   through the three callbacks) built BOTH native and gucOS against a local
   Node server; diff the outputs. This is the acceptance harness and the
   template for 0174's dual-target testing.
3. `tests/kernel/test_curl_e2e.js` + RULES entry.

## Acceptance

- The differential smoke passes byte-identical (modulo documented header
  order/casing) native vs gucOS for: 200 GET with streamed body, POST with
  body, 404 (perform succeeds, RESPONSE_CODE 404), connection-refused
  (CURLE_COULDNT_CONNECT), timeout abort (CURLE_OPERATION_TIMEDOUT).
- `/bin/code` (0174) runs in-OS against a local fake server unchanged from
  its native build except the platform seam.
