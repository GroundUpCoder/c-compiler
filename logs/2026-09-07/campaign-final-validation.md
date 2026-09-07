# Serial audit campaign: final validation

The composed implementation at `f269ea2f` passed the fresh, unfiltered
`node tests/run.js full --out=build/status-fixes/campaign-full-final` gate.
It finished on 2026-09-07 at 09:48:04 UTC, exit 0, in 2982.8 seconds.
All eight dispatcher result rows are literally `pass`, covering all 26
selected suites (nineteen Python suites share one batch row).

Unit: 847 passed, zero failed, three skipped. Python batch: 904 passed,
zero failed, 111 skipped. BlockFS: 15/15 files passed. Kernel: 199/199;
browser: 69/69. Both heavy child manifests have `done: true`, no filter,
selected/executed/recorded equal to total, and zero resumed/carried results.
The dispatcher and child artifact mtimes postdate this invocation's start.
Final child copies are `campaign-final-kernel-summary.json` and
`campaign-final-browser-summary.json` under `build/status-fixes/`.

The standard flake run previously completed on the same product/image 287:
12 kernel and 18 browser executions, all passing under CPU load 10. Later
changes fixed test enrollment, an assertion probe setup/golden and a unique
browser port; they did not alter the product. Earlier interrupted and red
gate attempts remain preserved, including the completed port-collision red
described in `campaign-full-port-guard.md`; none counts as a full pass.

## Manual sessions actually executed

This continuation (`01a07ad5-bbdb-748d-9fea-28cd322d8d03`, metadata verified
Codex / gpt-6-astra) drove two serial interactive live sessions, first Node
headless at 09:53–09:57 UTC, then real Chromium at 09:58–10:02 UTC. Both
booted image 287. Commands were issued and results inspected individually
through the generic REPL in `build/status-fixes/manual-console.mjs`; these
were not invocations of the acceptance test files. The browser used the real
VT keyboard path and clipboard upload; headless used the stock tty driver.
No worker or internal subagent was spawned.

Observed in BOTH hosts:

- The original audit sources produced macro line output `700 700`, VA_OPT
  output `9`, and redefinition output `2` plus the named line-3 warning.
  The original nonzero-comparison setjmp repro returned 0.
- Uploaded the prepared paddle C source, compiled with in-OS
  `cc -g2 -fno-inline`, ran it, moved the paddle, paused and quit. It logged
  hits/misses and key effects. Edited the source using in-OS sed, changing
  the paddle from green to magenta and the movement step from 20 to 30;
  rebuilt the same executable and observed the new color and `PADDLE=160`.
  Browser play used actual desktop Arrow keys, p and q. Headless input used
  wmctl. Screenshots were opened and visually inspected.
- A three-deep deliberate trap returned 139 and reported depth3/depth2/
  depth1/main, with the fault at debug.c:1. Assert and abort returned 134,
  preserved the assertion message and reported caller/source locations on
  redirected fd 2. A visible frame-callback fault returned 139, removed its
  window and left the shell and desktop usable. In the browser the trap was
  subsequently edited out, rebuilt and run successfully (`FIXED-CRASH=0`).
- The direct WebGPU gpubox rendered a colored cube. Its guest-generated
  surface, thumbnail and screen PNGs were captured and transferred locally;
  the screen images were visually inspected. Browser paddle GPU surface and
  thumbnail PNGs were also opened and inspected, showing actual game pixels.
- Calculator computed 7 + 3 = 10, had a taskbar button and recovered from
  being covered. Headless wmctl cycling and a browser taskbar mouse click
  brought it forward. Notepad dirty-close created an owned transient with
  no extra taskbar button; Cancel retained the text and No closed it.
- The real 40-module source-generation/build script produced `TOTAL=35100`
  and `BUILD=0`. The original hush -e loop continued after its false terminal
  condition. Compiler help returned 0; -O2 and the three package-doc flags
  each refused by name with status 1. The baked packages doc says to omit
  those options. One manual inspection initially used unsupported grep -A;
  the subsequent plain grep command read the doc successfully.

The headless session additionally read live /bin/sh and found 18,434 bytes
of name data and 27,552 bytes of c.sourcemap. The developer -g2 build carried
c.sources in both hosts. These observations supplement, rather than replace,
the detailed #761 measurement/policy evidence in `761-debug-shipping.md`.

Raw evidence: `build/status-fixes/final-{headless,browser}-transcript.json`,
stdout/stderr logs, metadata JSON and `final-*.png` captures. The edited game
sources are retained there too. Both sessions were closed. These were short
functional sessions, not endurance tests, acoustic checks, or evidence that
the broader #731 enjoyment criteria or gcode-authored game workflow is met.

## Scope and disposition

Concrete implemented tickets: #650, #740, #764, #752, #432, #769, #751,
#760, #761, #762, #770, #771 and #746. Their original red/green evidence and
implementation provenance remain in the per-ticket journals and the full
`build/status-fixes/STATE.md` history. Earlier real serial threads performed
the product implementations; this continuation completed composed validation
and the browser-test port correction.

No merge or deployment occurred. Original untracked projects and browser
sedit experiments were preserved. Broader missing SDL subsystems remain an
unanswered scope question; this is not a claim that every queued feature,
the whole gamedev epic, or the deployment is complete.
