# Handoff — start of thread (updated 2026-07-08, after 0022 landed)

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**os.html has VTs.** This thread landed **0022** — VT switching, Linux-
console semantics (design: WM.md "Screen, VTs, and scaling fixed-size
clients"; dev log `logs/2026-07-08/vt-switching.md`). Shape:

- The xterm tty is **VT1**, the desktop **VT2**; the page shows exactly
  one (`body[data-vt]` CSS), boot lands on VT1. Ctrl+Alt+F1/F2 (+
  Ctrl+Alt+1/2 alias) on a window-CAPTURE keydown listener, plus the
  clickable `1:tty`/`2:desktop` switch in the status strip (`#status` now
  wraps its text in `#statusmsg` — don't write textContent on the strip).
- VT1 entry re-fits + refocuses xterm; VT2 entry focuses the canvas;
  pointer lock is exited on leaving VT2 and requests are gated to VT2
  (re-arms per 0018 on the next client click); halt/boot-error force VT1;
  VT2→VT1 releases synthetic Ctrl/Alt keyups to the focused surface
  (stuck-modifier fixup). **Zero kernel/compositor/protocol change**;
  boot.js untouched; image.json stays **v16** (os.html isn't seeded).
- Rationale is availability under partial failure: VT1 = kernel worker +
  xterm only — proven in the new test by `kill $WMPID` mid-doom.
- Agent probes: `window.__osVt`, `window.__osVtSwitch(n)`.

All green at hand-off: unit 697✓ (3 pre-existing skips), host✓, blockfs✓,
kernel suite✓ (untouched by this change), browser os-boots✓ + os-wm✓ +
os-doom✓ + os-quake✓ + os-gpubox✓ + os-term✓ + **os-vt✓ (new, 19 checks)**.

## The queue (todos/README.md is authoritative)

1. (unnumbered) real-world WebGPU C app port — candidates via WEBGPU.md
2. Unpromoted WM.md follow-ons if wanted: dynamic screen resolution
   (full-viewport VT2), maximize, scaling fixed-size clients

(`0006` threads + atomics stays deferred indefinitely.)

## Gotchas from this thread (details in the dev log)

- **Browser tests must sit on the right VT**: canvas pixel sampling and
  mouse/key input on VT2, shell typing on VT1 (`setVt` helper in each
  test → `window.__osVtSwitch`). Pixel waits on VT1 can stall forever —
  the worker-side compositor rAF may idle while the placeholder canvas is
  display:none (mailbox makes that safe; the scene is current again the
  moment you switch back).
- `page.click('#terminal')` is gone from the tests — VT1 entry refocuses
  the term; on VT2 the terminal isn't clickable at all.
- os-doom's `wmctl close` teal-wait leg can exceed its 30s window if you
  run the browser sweep CONCURRENTLY with the Node suites (machine
  saturation, doom's slow quit path); run the browser tests serially —
  it passed 2/2 solo after failing once under full parallel load.
- Shell-output assertions in os-vt use a quote-split (`echo VT1-O''K`) so
  the needle can't be satisfied by the command's own tty echo — steal
  that pattern for new tests.
- The vi/os-boots timing guards from 0018/0020 still apply: wait for
  `/~ #/` in `__osOut` before typing in browser tests; os-gpubox stays
  environmentally flaky (headless WebGPU adapter availability).
- The IDE's clangd flags os/*.c (SDL.h not found etc.) — noise; those
  headers are compiler.js built-ins.

## Conventions to keep (bite-sized reminders)

- Queue discipline: work = `todos/NNNN`, done → `todos/done/`, dev log per
  landing, README next-up current.
- Seeded OS sources changed? **Bump `os/image.json` `version`** (v16 now).
- compiler.js must stay browser-clean (no bare `process.*`).
- MUST-MATCH blocks: WM protocol in kernel.js (WMP) ↔ os/wm_proto.h ↔
  test_wm_policy.js (record flags: focused/min/borderless/relmouse/
  resizable = bits 0–4); surface/ring layout kernel.js (SH_*/IR_*) ↔
  host.js (WMSH_*/WMIR_*); ring event numbers (WMEV) ↔ <SDL3> event
  values in compiler.js ↔ host.js WMEV_*; audio ring layout kernel.js
  (AU_*) ↔ host.js; SDL audio format words ↔ <SDL3/SDL_audio.h>; SI_* tty
  header kernel.js ↔ host.js.
- `tests/browser/os-*.mjs` are manual — run os-boots/os-wm/os-doom/
  os-gpubox/os-quake/os-term/os-vt (serially!) after touching os/,
  kernel.js, host.js SDL/webgpu/fd/audio/input/tty paths.
- Don't re-litigate: posix_spawn-not-fork, kernel-owned fds, WM.md's
  invariants, 0013–0021's decisions, 0022's decisions (exactly-one-visible
  VTs, page-side state only, boot lands VT1, halt forces VT1, lock
  requests gated to VT2).

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle: a WebGPU app port, a WM.md follow-on (dynamic screen res /
maximize / scaling), a lingering item, or something else."
