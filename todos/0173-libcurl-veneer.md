# 0173 — libcurl easy-interface veneer over the kernel HTTP transport

- **Status**: open (hard-dep: 0172)
- **Design**: rationale in logs/2026-07-13/0172-http-stack-plan.md

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
