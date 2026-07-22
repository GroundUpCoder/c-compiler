# ksvc — the kernel-C text service lands (todos/0275)

The last text the OS presented that our own stack didn't rasterize —
compositor label text (window titles, the close `'x'`, Exposé captions) —
now renders through `/usr/lib/ksvc.wasm`: FreeType + fontchain.h compiled
by OUR compiler, instantiated synchronously in the kernel's thread, called
by both composites. The Canvas2D `labelFor` path is deleted (the
host-borrow audit ruling: the browser is the hardware, not a co-renderer).
Design was settled ahead of time in `todos/0275-kernel-text-service-design.md`
(branch ksvc-design) — this log is the implementation record; §12 of the
design executed top to bottom with zero deviations of substance.

## What the change is

- **`os/ksvc/ksvc.c`** — the growable kernel service blob, first
  capability text: `ksvc_abi`/`ksvc_init`/`ksvc_buf`/`ksvc_text_measure`/
  `ksvc_text_render`. The glyph pipeline is the gdi32 `font_glyph`
  discipline restated: face 0 = `/etc/fonts/mono.ttf` >
  `/usr/share/fonts/mono.ttf` (opened EAGERLY at init — a boot that can't
  render chrome must fail at boot), chain faces from `fc_load()` opened
  lazily, ASCII pinned to face 0, synthesized tofu on total miss,
  per-(px,flags) caches (flat [95] + linear side cache). Ellipsis
  truncation replaces fillText's maxWidth squish; embolden is
  `FT_Outline_EmboldenXY` at HALF this freetype's `AdjustWeight` default
  (`KSVC_BOLD_XDELTA 0x0555`) — the stock strength was visibly too heavy
  at 20px in the spike, and the half strength look-confirmed well against
  the v133 chrome rhythm (bolder than regular chrome text, not blobby).
- **`os/ksvc.js`** — dual-env loader/wrapper. The import env is written
  out explicitly (NOT borrowed from runModule): read-only fs over `kfs`
  with write-intent flags EROFS'd pre-dispatch, fd 1/2 writes → boot log,
  a `%s/%d/%u/%x/%c`-only vsnprintf mini-formatter (libc printf is
  host-implemented in this compiler; fc_load's `snprintf("%s",…)` is the
  one live user), loud named traps for everything outside the service
  surface. ABI + init asserted at load; any failure throws.
- **kernel.js** — `WM_LABEL_PX = 20` (the ONE shared label size),
  `opts.textService` → public `kernel.textService`, `_blitLabel` (render +
  the exact 0063 integer src-over), and wmScreenshotScreen now draws
  title text, the close `'x'`, and overview captions headless with the
  same strings/geometry as compositor.js. "Text is a browser-compositor
  affordance" is dead.
- **compositor.js** — `labelFor` rewritten over `svc.measure`/`svc.render`
  (straight-alpha bytes via `writeTexture`; heights from the render
  header). Acceptance grep
  (`getContext('2d')|measureText|fillText|OffscreenCanvas`) returns
  nothing.
- **Loaders** — kernel-worker.js (`importScripts ksvc.js`, load between
  kfs and the Kernel ctor, throw → `boot-error`) and boot.js (require,
  load, throw → nonzero exit). No zombie fallback anywhere.
- **image.json** — `/usr/lib` + `/usr/lib/ksvc.wasm {project:
  os/ksvc/bin.json}`, version 138 → **139**. Staleness tracking needed
  zero changes (`newestBakeInput` already scans os/ + project closures —
  observed live: editing ksvc.c re-baked the fixture on the next boot).
- **winbox.c** — grew `winbox title <utf8>` (the design's noted 5-line
  hook) so e2es and humans can put arbitrary/CJK/overlong titles on a
  window.

## The strong test (same-bytes, not "pixels changed")

`tests/kernel/test_ksvc_e2e.js` renders the title via os/ksvc.js DIRECTLY
over the same system image and bit-compares the composite title strip
against src-over(label, navy) — plus an ellipsis leg (measure > maxW,
rendered ≤ maxW), a CJK tofu-parity leg, and an Exposé caption leg
(centered under the cell over the border/desktop background, also
bit-exact). `test_fontpkg_e2e.js` grew the real-glyph TITLE leg: install
font-noto-cjk-mono, REBOOT (ksvc reads the chain at ksvc_init), and the
CJK title strip is bit-exact against an oracle whose chain resolves the
/opt face through the REAL root volume — plus a pairwise-distinct-glyph
check so both sides rendering tofu can't silently pass.

## Gate results

- kernel suite **102/102** (including the two new/extended e2es).
- browser sweep **34/35** — the one red is `os-touch`, the pre-existing
  P0 0271 OSK failure (pixel (92,726) in the OSK region; present on main).
- flake gate green: the standard tripwire set 3×-under-load stable, plus
  `test_ksvc_e2e` itself 3/3 under load.
- **Zero pixel assertions needed re-blessing.** The §14.1 triage budget
  went unspent: existing e2es sample title strips either past the text
  (os-wm's WX+150) or in bare-Kernel unit tests (no textService), and the
  overview e2e's samples all sit inside cells, clear of the new captions —
  the §14.6 caption fork never materialized.

## Look-confirm (Phase C/D precedent)

Browser boots vs main, full-canvas captures (worker WebGPU canvas needs
drawImage→toDataURL, not page.screenshot): title weight/baseline good at
the half-strength embolden (no retune), `longtitle-ab…` ellipsizes, CJK
titles are honest tofu without the package and real 日本語 with
font-noto-cjk-mono installed (title AND taskbar agree — one chain),
Exposé captions centered under cells in both composites.

## Gotchas recorded

- Interactive hush + `"$(printf …)" &` typed into xterm hangs the typed
  line (fine when piped via stdin — the e2es use that); the browser
  look-confirm sidesteps via `printf '…' > /root/t.sh; sh /root/t.sh`.
- Playwright profiles are throwaway: OPFS does NOT survive a browser
  relaunch — an install-then-reboot browser scenario must `page.reload()`
  inside ONE session.
- The tofu cell is the 'M' advance (gdi32 `monoAdv`), NOT
  `max_advance >> 6` — Noto Sans Mono's max_advance is ~3× the mono cell
  and produced 72px-wide tofu until matched to the gdi32 rule.
- Worktrees: symlink `node_modules` (playwright) or every sweep file dies
  in 50ms.

## Follow-ups (filed in the design, not smuggled in)

- Glyph-pipeline tri-plication (gdi32 `font_glyph` / term `cp_glyph` /
  ksvc): consolidate into a header-only core — a queue item, it refactors
  two shipped consumers.
- The vsnprintf mini-formatter is deliberately tight; a future blob
  capability with fancier formats hits a loud named throw.
