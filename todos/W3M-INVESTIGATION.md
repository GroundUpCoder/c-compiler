# Text web browser (w3m / lynx / links) on gucOS — feasibility investigation

Status: INVESTIGATION (punt-able), 2026-07-20. Verdict below is
**FEASIBLE but PUNT for now** — w3m is the right target if/when we go;
the decisive "not now" is CORS + priority, not a hard technical wall.

This is a writeup + recommendation only. No port, no build, no deploy.

## The question

Can a text-mode web browser ride gucOS's EXISTING host-brokered HTTP
transport (the `__http_*` kernel RPC family, todos/done/0172, behind the
`os/curl/` libcurl-easy veneer, todos/done/0173) instead of raw TCP
sockets — and how much surgery does that take? Compare w3m vs lynx vs
links against gucOS's actual constraints.

## gucOS network + terminal truth (verified in-tree)

**Network — HTTP-only, host-brokered, NO sockets.**
- The only transport is the kernel fetch RPC family, opcode space
  `0x06xx` in `kernel.js` (`HTTP_BODY/OPEN/STATUS/READ/CLOSE`,
  `kernel.js:255`). The kernel worker does the actual `fetch()`; the
  request blocks the caller via the deferred-RPC machinery.
- The C surface is four imports (`os/curl/libcurl.c:45`):
  `__http_open(method,url,headers,body,len) -> id`,
  `__http_status(id, &status, hdrbuf, cap)`,
  `__http_read(id, buf, cap)`, `__http_close(id)`. `os/curl/` wraps these
  as a `<curl/curl.h>` easy-interface subset (GET/POST, custom method,
  headers, WRITE/HEADER/READFUNCTION, follow-redirect, timeouts,
  url-escape). It is an **app-side `lib.json` library** — any app can link
  it (`os/curl/lib.json` `"type":"lib"`).
- **There are NO raw sockets.** Tier-1 loopback AF_INET (`todos/0052`) is
  still OPEN in the queue; the arbitrary-host relay (`todos/0054`) is
  blocked on it. So `socket()`/`connect()`/`bind()` do not exist. Every
  candidate browser opens raw TCP directly and MUST be redirected.
- **TLS is free.** HTTPS is done by the browser's fetch stack inside the
  kernel worker — the app never sees TLS. Any `openSSL`/`GnuTLS` code in a
  candidate browser is bypassed wholesale, not ported. This is a large
  saving that applies to all three browsers.
- **CORS is a first-class runtime limit (browser tab).** `fetch()` from
  the page is same-origin + CORS-permissive-hosts only
  (`todos/NETWORK.md:44`). Headless `boot.js` (Node fetch) is
  unrestricted. This is the crux of the value question (see Verdict).
- **`__http_*` transfers ARE file descriptors since todos/0417** (this
  investigation predates it; its downstream reasoning about a
  select-driven browser treats the old not-an-fd limit as current). An
  `http` OFD now joins `FS_SELECT`/`__wait` beside pipes and the input
  ring, `read(2)` drains the body (EAGAIN when dry), and the kernel
  bounds every transfer with headers/idle deadlines. Re-derive any plan
  step below that leaned on the old limit.

**Terminal — a real xterm-256color VT, termios works, but NO termcap DB.**
- `os/term/` is a genuine VT100/xterm emulator. Its escape parser already
  covers everything a fullscreen TUI browser needs (`os/term/term.c:14`):
  CUP, CUU/CUD/CUF/CUB, CHA, VPA, ED/EL, IL/DL/ICH/DCH/ECH, SU/SD,
  **DECSTBM scroll region**, **SGR 16/256-color + bold/reverse**,
  **alt-screen `?1049`**, cursor show/hide `?25`, autowrap `?7`, DECCKM,
  and DSR-6/DA query replies. `TERM=xterm-256color` is exported into every
  process env (`os/kernel-worker.js:454`, `os/boot.js:339`).
- POSIX **termios raw mode works** — busybox `vi` runs fullscreen in
  gucOS today with hardcoded ANSI and no termcap. That is the precedent: a
  fullscreen TTY app here uses termios + hardcoded xterm sequences, NOT a
  termcap/terminfo lookup.
- **There is NO termcap, terminfo, ncurses, curses, or slang anywhere**
  in `os/` or `vendor/` (grep-verified; the only "termcap" hits are
  unrelated comments in freetype/libpng/punes). So any browser that calls
  `tgetent()`/`setupterm()` at runtime has nothing to read and must be
  given a hardcoded capability stub, and any browser that needs the curses
  *screen model* needs a whole ncurses/slang port first.
- **NO threads.** `kernel32 CreateThread` is a loud stub
  (`os/win32/kernel32.c:937`, `ERROR_CALL_NOT_IMPLEMENTED`); host.js is
  single-threaded wasm per process. Any "run the blocking client on a
  worker thread and surface it through a pipe" trick is unavailable.

## The two blockers, restated concretely

**(a) No raw sockets → HTTP must be redirected to `__http_*`/curl.**
All three browsers open TCP directly. The cost is entirely a function of
*how isolated* each browser's socket layer is:
- A single synchronous `connect()`+`read()` chokepoint → cheap to swap.
- An async `select()`-driven callback chain with no chokepoint → expensive,
  and worse here because our HTTP ids aren't select-able fds and we have no
  threads to hide the blocking behind.

**(b) No curses/termcap DB → the UI layer must not depend on one.**
- Own built-in ANSI driver → nothing to do (matches gucOS perfectly).
- termcap API (`tgetent`) but no curses → needs a ~1-file hardcoded-caps
  stub (the busybox-vi approach, generalized).
- curses/slang screen model → needs a full ncurses (or slang) port +
  a terminfo entry FIRST. That is a project on its own.

**(c) HTML render + charset** is self-contained in all three (each ships
its own parser/renderer and its own charset tables — no external iconv
needed). Not a blocker for any of them.

## Candidate comparison (sources: repos fetched, see footnotes)

### w3m (github.com/tats/w3m)
- **HTTP model: blocking, single chokepoint — the cleanest seam.** Every
  outbound connection funnels through `openSocket()` in `url.c`
  (~lines 1014–1149: resolve + `socket()` + `connect()`); HTTPS setup is
  `openSSLHandle()` (~514–721). All I/O is already behind a polymorphic
  `ISTREAM` vtable (`istream.c`, ~910 lines) with `IST_BASIC` (raw socket
  read) and `IST_SSL` backends. **The redirect is: replace `openSocket`
  with a call that does `__http_open`, and add one new ISTREAM backend
  that drains `__http_read`.** TLS folds into the transport for free (drop
  `openSSLHandle` entirely). `url.c` ≈ 2370 lines, networking concentrated
  in ~400–500 of them.
- **Terminal: termcap API, NOT curses.** `terms.c` (~2250 lines) calls
  `tgetent/tgetstr/tgetnum/tputs/tgoto` directly — no curses screen model.
  **Catch:** on a missing termcap entry it prints "Can't find termcap
  entry" and exits — there is no built-in fallback table. gucOS has no
  termcap DB, so we must supply a small stub library implementing the
  termcap C API returning hardcoded xterm-256color caps (the same handful
  of capabilities `os/term` already renders). Bounded, ~1 file.
- **Mandatory external dep: the Boehm GC (`libgc`).** `AC_W3M_GC`
  hard-errors "You can not build w3m without GC"; `GC_MALLOC` is used
  pervasively. BUT you do **not** need to port real Boehm GC — the
  standard cheap path is a **leaky GC shim**: `GC_malloc`→`calloc`,
  `GC_malloc_atomic`→`malloc`, `GC_realloc`→`realloc`, `GC_free`→no-op,
  `GC_strdup`→`strdup` (~40 lines). w3m relies on GC to reclaim, so a leaky
  shim leaks across a long browsing session, but it *boots and renders*.
  (A real bounded-memory GC is a follow-on, not a port prerequisite.)
- **Charsets: self-contained** (`libwc/`, ~40 files: utf8/sjis/big5/
  gb18030/iso2022 + EastAsianWidth). No iconv. HTML renderer in-tree
  (`html.c`/`file.c`/`table.c`/`buffer.c`).
- **Size:** ~60 top-level C files; tens of thousands of LOC (own renderer +
  tables + forms + libwc).

### lynx (invisible-island.net / ThomasDickey/lynx-snapshots)
- **HTTP model: blocking, single `HTDoConnect()` chokepoint in
  `HTTCP.c`** (~1900 lines) — swappable — **but under the whole CERN
  libwww tree** (`HTTP.c` ~2500 lines, `HTLoadHTTP()` ~1800 lines). You
  replace the transport but keep all of libwww's protocol/redirect/auth/
  chunked machinery. `select()` is used only for interruptible timeouts,
  not concurrency.
- **Terminal: REQUIRES ncurses OR slang.** INSTALLATION is explicit:
  "Lynx is a curses-based application, so you must have a curses library
  available to link to." The screen layer `LYCurses.c` (~2650 lines) has
  no non-curses driver. Built on ncurses it *also* inherits ncurses'
  runtime **terminfo-DB** requirement. **So porting lynx = porting
  ncurses/slang + shipping a terminfo entry first** — directly against
  both gucOS constraints. This is the disqualifier.
- **Deps:** ncurses-or-slang + libc (no Boehm GC). Charsets self-contained
  (`src/chrtrans/*.tbl`). Renderer self-contained (`GridText.c`, >10k lines).
- **Size:** src/ ~50 `.c` + the libwww tree; likely 100k+ LOC total.

### links / links2 (Twibright, links.twibright.com)
- **HTTP model: fully async `select()` event loop — the HARDEST to
  redirect here.** Raw non-blocking sockets driven by `select_loop()` in
  `select.c` (~1100 lines) with per-fd `read_func`/`write_func` handlers;
  `connect.c` (~1100) does non-blocking connect→`EINPROGRESS`→callback;
  `http.c` (~800) is a hand-written HTTP state machine as a callback chain
  re-arming `set_handlers` at each stage; DNS is async on a **helper
  thread** surfaced through a **pipe** (`dns.c`). There is no synchronous
  chokepoint. To use our *blocking* `__http_*` client you'd have to pump
  it and re-surface completion through links' fd/`set_handlers` seam —
  which normally means a worker thread + pipe (the `dns.c` pattern).
  **gucOS has no threads, and `__http_*` ids are not select-able fds**, so
  neither half of that pattern is available. You'd be doing synchronous
  surgery against links' entire async grain, or you'd first have to expose
  http-as-a-pollable-fd in the kernel (a transport change). Worst seam of
  the three *for this OS specifically*.
- **Terminal: its OWN built-in driver, NO curses/termcap/terminfo.**
  `terminal.c` (~1400 lines) emits hardcoded VT100/ANSI (`\033[2J`, SETPOS,
  SGR, SO/SI) with built-in xterm/linux/vt100/utf-8 profiles. No
  `curses.h`/`term.h`/`tgetent` anywhere. **This is a perfect match for
  gucOS's VT** — zero terminal work. (Graphics mode is a separate
  `--enable-graphics` subsystem we would not build.)
- **Deps for a text build: essentially libc only** — configure fatal-errors
  on just `select()` + `stdarg.h`; OpenSSL/zlib/bzip2/brotli all optional
  and degrade gracefully. **No Boehm GC** (own `mem_alloc`). Charsets
  self-contained (`charsets.c` + compiled tables). Smallest mandatory
  library surface of the three.
- **Size:** ~100 `.c` (text subset smaller); no external mandatory libs.

### Scorecard

| Axis | w3m | lynx | links |
|---|---|---|---|
| HTTP model | **blocking, 1 chokepoint** | blocking, 1 chokepoint under libwww | **async select loop, no chokepoint** |
| (a) Redirect HTTP → blocking `__http_*` | 🥇 easiest (swap `openSocket` + 1 ISTREAM backend) | 🥈 medium (swap under libwww) | 🥉 hardest — needs threads/pollable-fd gucOS lacks |
| TLS | free (drop OpenSSL) | free | free |
| Terminal driver | termcap API, no curses | **ncurses/slang required** | **own ANSI driver** |
| Needs termcap/terminfo DB? | yes → ~1-file caps stub | yes (via ncurses) + terminfo entry | **no** |
| (b) curses/termcap coupling | 🥈 medium (caps stub) | 🥉 worst (port ncurses+terminfo first) | 🥇 best (nothing) |
| Boehm GC? | yes → ~40-line leaky shim | no | no |
| Other mandatory libs | GC-shim + termcap-stub + libc | ncurses/slang + libc | **libc only** |
| Charset / HTML render | self-contained | self-contained | self-contained |

**No single browser wins both axes.** w3m owns the network seam (its
blocking + single-chokepoint model is almost purpose-built for our
blocking `__http_*` client) but costs a leaky-GC shim + a termcap-caps
stub. links owns the terminal (its own ANSI driver needs nothing gucOS
lacks) and has near-zero library surface, but its async select-loop HTTP
is the *worst* fit for a blocking, non-fd, thread-less transport. lynx is
out until someone ports ncurses + terminfo.

## Recommendation

**If we go, the target is w3m.** The tension is real but resolves in
w3m's favor for THIS OS:
- The HTTP seam is what actually determines difficulty here, and gucOS's
  transport is *blocking, non-fd, thread-less* — which is exactly the
  shape w3m already has and exactly the shape links fights. links' terminal
  advantage is worth ~1 file (a termcap stub) to w3m; w3m's HTTP advantage
  is worth a near-rewrite of links' event core. The terminal gap is far
  cheaper to close than the network gap.
- Concrete w3m prerequisite work, all bounded:
  1. **Leaky GC shim** — `GC_malloc`/`_atomic`/`realloc`/`strdup`→libc,
     `GC_free`→no-op. ~40 lines. (Real GC deferred.)
  2. **`minitermcap` stub** — the termcap C API (`tgetent`/`tgetstr`/
     `tgetnum`/`tgoto`/`tputs`) returning a hardcoded xterm-256color cap
     set covering exactly what `os/term` renders. ~1 file, ~200 lines.
  3. **HTTP redirect** — replace `openSocket()` with an `__http_open`
     call and add one `ISTREAM` backend draining `__http_read`; delete
     `openSSLHandle`/OpenSSL (TLS is the transport's). Small, localized to
     `url.c`/`istream.c`.
  4. Then the ordinary large-vendor-port grind (compile w3m's ~60 files
     against `compiler.js`, fix ILP32/toolchain gaps) — comparable in
     scale to the doom/quake/sqlite ports already in `vendor/`.

## Verdict: PUNT for now (feasible; not worth doing yet)

**Is it feasible? Yes** — there is no hard technical wall. w3m's
architecture fits gucOS's blocking HTTP transport cleanly, TLS comes free
from the fetch stack, and the two "scary" dependencies (Boehm GC, termcap)
reduce to a ~40-line leaky shim and a ~1-file caps stub. A path exists and
is written above.

**Should we do it now? No — punt.** Two reasons, the first decisive:

1. **CORS makes an in-browser text browser marginal until Tier-4 lands.**
   In the browser tab, `fetch()` is same-origin + CORS-permissive only
   (`todos/NETWORK.md`). A web browser that can only load same-origin
   content and the handful of CORS-open sites cannot "browse the web" —
   the marquee use case — from the tab. It works fully only headless
   (`boot.js`, unrestricted Node fetch) or through the arbitrary-host
   relay, **`todos/0054`, which is still open and itself blocked on the
   unlanded Tier-1 `0052`.** Porting a browser before the relay lands ships
   a browser that mostly can't reach the web from where users actually run
   gucOS.

2. **It's a large P1 feature against a hardening-first queue.** w3m is a
   full multi-day vendor-scale port (own renderer, forms, tables, libwc)
   for a capability whose value is capped by (1). The queue's stated
   priority is testing/hardening and bug-fix (P0) work ahead of new
   feature breadth; a browser is squarely P1 feature breadth.

**What would unblock a GO:** land the Tier-4 relay (`todos/0054`, and its
prerequisite `0052`) so the in-browser tab can reach arbitrary hosts — OR
scope the browser explicitly as a *headless / same-origin-docs* tool where
CORS isn't in the way. Once arbitrary-host fetch exists, revisit with w3m
as the target and the four bounded prerequisites above; at that point this
flips to a clean GO.

---
Footnotes / sources (repos fetched during investigation):
- w3m: `raw.githubusercontent.com/tats/w3m/master/{url.c,istream.c,terms.c,acinclude.m4}`
- lynx: `invisible-island.net/lynx/current/INSTALLATION`; `github.com/ThomasDickey/lynx-snapshots` (`src/LYCurses.c`, `WWW/Library/Implementation/{HTTP.c,HTTCP.c}`, `src/chrtrans/`)
- links: `links.twibright.com`; source mirror (`select.c`, `connect.c`, `http.c`, `dns.c`, `https.c`, `terminal.c`, `charsets.c`, `configure.in`)
- gucOS in-tree: `kernel.js` (0x06xx HTTP RPCs, `_httpXfers`), `os/curl/` (veneer + `__http_*` imports), `os/term/term.c` (VT capabilities), `os/kernel-worker.js`/`os/boot.js` (`TERM=xterm-256color`), `os/win32/kernel32.c` (`CreateThread` stub), `todos/NETWORK.md` (tier model + CORS)

(Line-count figures are file-length estimates from fetched sources, not a
local `cloc` run.)
