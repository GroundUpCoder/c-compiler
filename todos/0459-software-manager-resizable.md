# 0459 — software manager: WS_THICKFRAME + WM_SIZE relayout (resizable, crisp text at every size)

- **Status**: open
- **Difficulty**: medium — app-side only, but the acceptance leg is
  `tests/kernel/test_software_e2e.js`, so **this is a HEAVY-class lane for scheduling**.
- **Design**: this file. Source: jku ask, 2026-07-30, investigated by a gucOS scoping thread and
  filed by master cont-221.
- **Provenance**: jku asked why the software manager does not resize flexibly and why its text
  fuzzes at some sizes. His ruling: **best win32 practice should be properly supported**; *"if it's
  easy, queue it."*

## Goal

Make `os/win32/software.c` a properly resizable win32 app: real frame-drag and maximize resizing,
with text that stays crisp at every size.

**The fuzzing and the non-resizing are the same bug.** A fixed-size gucOS window is *bitmap-scaled*
by the window manager (`SET_DST`, a nearest-neighbour stretch of already-rasterized pixels), which is
why the text goes soft. A resizable window instead gets its surface buffer **recreated at the new
size** and re-renders 1:1, so FreeType re-rasterizes and the text is sharp. Fixing resize fixes the
fuzz — there is no separate font work here.

## Verified starting state (re-verified against `main` by master cont-221 — paths corrected)

⚠️ **The routed decomposition cited `wm.c:1087` as `os/win32/wm.c`. That file does not exist** — the
window manager is **`os/wm.c`**. Re-derive all line numbers at spawn ((EN)).

**No platform extension is needed for the core fix. The real-resize path already exists and is
proven in production apps.** The full chain, verified end to end:

1. The app passes **`WS_THICKFRAME`** at `CreateWindowEx`.
2. `os/win32/user32.c:2570` maps it: `((style & WS_THICKFRAME) ? SDL_WINDOW_RESIZABLE : 0)`.
3. That becomes **`WMP_F_RESIZABLE` at create** time, recorded as `w->resizable` (`os/wm.c:289`).
4. `os/wm.c:1087` then dispatches `wmp_send(sock, w->resizable ? WMP_RESIZE : WMP_SET_DST, …)` —
   a resizable window takes the **real resize** path, a fixed one takes the **bitmap-stretch** path.
5. The surface buffer is recreated at the new size and **`WM_SIZE` is delivered to the app**
   (`os/win32/user32.c`, ~`:1859-1877`; also on create and on child `MoveWindow`).

🔴 **`WMP_F_RESIZABLE` is set *at create*** — so the style flag must go on the `CreateWindowEx`
call. There is no path that makes an already-created window resizable afterwards.

**The software manager deliberately opted out.** `os/win32/software.c:947-951`:

```c
/* fixed-size (no WS_THICKFRAME): the layout is exact; the kernel
 * scales fixed windows via SET_DST instead of shearing them */
g_win = CreateWindowEx(0, "Software", "Software",
                       WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_VISIBLE, …
```

— no `WS_THICKFRAME`, no `WM_SIZE` handler, and all layout in hard-coded pixel constants.

**Working in-tree template**: `os/win32/fileman.c:844` — `case WM_SIZE: relayout(h); return 0;`.
It re-lays out its children against the live client rect and stays crisp at every size. `notepad`,
`ctlpanel` and `gpubox` do the same; `gpubox` (`os/gpubox.c:505`) and `fileman` (`:926`) are the two
in-tree `WS_THICKFRAME` precedents.

## Plan

1. Add **`WS_THICKFRAME`** to the `CreateWindowEx` style at `os/win32/software.c:950` and **delete
   the now-false comment** above it.
2. **Handle `WM_SIZE`** in the wndproc: turn the layout constants (`CARD_W`, `LIST_H`, `VIS_CARDS`,
   `BTN_X` — `software.c:70-77`) into functions of the live client rect (`GetClientRect`), then
   `MoveWindow` the children (scrollbar / cards / status / notice). **The app already has this
   pattern** — its own card-shuffle at `software.c:550` does exactly this kind of `MoveWindow` pass;
   reuse it rather than inventing a second layout path.
3. **Re-derive the scroll range and page size** from the new client height. A resize that does not
   update the scrollbar leaves it describing the old viewport.
4. Read `os/wm.c:937` first: *"RESIZE vs SET_DST legal — exclusive modes, todos/0021/0024"*. These
   are **exclusive** modes and `0021`/`0024` hold the governing design; do not create a window that
   tries to be both.

## Overlaps — read both before scoping

### 🔴 `0371` (open) rebuilds this exact file's UI — coordinate, do not collide
`0371 — Rebuild the software manager on the real ListView` replaces the `PkgCard` HWND storefront
(~350 UI lines) with a real `SysListView32` report view. It is **hard-blocked by `0370`**, so it is
not near-term — but it is scheduled, and it **deletes the card layout this ticket makes elastic**.

Split the work by what survives:
- **Survives 0371 verbatim** (wndproc-level, not card-level): the `WS_THICKFRAME` style flag, the
  existence of a `WM_SIZE` handler, and the scroll-range re-derivation. **This is most of the value.**
- **Perishable**: only the *card-geometry* math (`CARD_W`/`VIS_CARDS` as functions of the client
  rect), which 0371 replaces with ListView column proportioning.

⇒ **Keep the elastic-geometry math in one small helper** so 0371 can delete it in a single move
instead of unpicking it from the wndproc. Do not block this ticket on 0371 — jku asked for the fix
now, and the durable part of it is 0371-independent.
⚠️ **This ticket must also add a "stays resizable, text stays crisp" acceptance arm to `0371`'s
body**, so the redesign cannot silently regress it. A requirement that lives only in a lane kickoff
is not in the estate.

### `0294` (open) owns the missing drag edges — do NOT chase this into the kernel
🔴 **gucOS only implements E, S and SE resize drag zones.** Re-verified at `7a1496c0`:
**`kernel.js:5565-5566`** (the kernel is `kernel.js` at the **repo root**, not `os/kernel.js` —
`0294`'s body cites stale line numbers) computes `ex` from `x >= s.x + dw` and `ey` from
`y >= s.y + dh` **only**; **west and north zones do not exist anywhere in the codebase**, and that is
`0294`'s scope (a kernel hit-test change plus a wm origin policy), not this ticket's. The kernel's
own comment at `kernel.js:1108` still calls moving-edge resize *"deliberately not in this version"*.

⇒ **Word the acceptance criterion as E/S/SE frame-drag + maximize.** A lane that reads "resizes
flexibly by frame-drag", tries the left or top edge, finds nothing happens, and goes digging in
`os/kernel.js` will be re-implementing `0294` by accident. Part of "resizes flexibly" is discharged
by a different ticket.

## Acceptance

- The window resizes by dragging the **E / S / SE** frame edges and by **maximize** (W/N/NW/NE/SW
  are `0294`, out of scope).
- **Text is crisp at every size** — verify the window takes the `WMP_RESIZE` path and not
  `SET_DST`. This is the observable that proves the fix; a resizable window that still stretches its
  bitmap has not been fixed.
- Children (scrollbar, cards, status, notice) re-lay out correctly, with no overlap or clipping, at
  both a much smaller and a much larger size than the default.
- The scrollbar range/page reflect the resized viewport.
- All of `software.c`'s locked header contracts still hold (its header comment enumerates them; a
  change that breaks one is a fail).
- `tests/kernel/test_software_e2e.js` extended with a resize leg.
- `0371`'s body carries the new "stays resizable" arm.
- Full gucOS gate green. Standing gucOS auto-ship applies; **bundle** rather than deploying
  per-commit.

## Not in scope

- **`WM_GETMINMAXINFO` / minimum tracking size** → `0460`. Without it a layout can be crushed below
  usable, but that is a platform gap and jku was told it is optional.
- **DPI awareness / `WM_DPICHANGED`** → moot for now. gucOS's `SET_DST` scaling is a window-manager
  zoom, not a per-monitor DPI concept, and resizable windows render 1:1 at the buffer size.
