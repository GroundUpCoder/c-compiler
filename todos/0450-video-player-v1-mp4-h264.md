# 0450 — Video player v1: MP4/ISO-BMFF demux in C + H.264 video-only playback paced by vsync

- **Status**: open
- **Design**: this ticket. Origin: the gucOS video-player viability investigation (2026-07-30),
  commissioned by jku and reported to him by email.
- **Difficulty**: medium. **Run this lane on Fable** (jku's call for this stream).
- **Blocked by**: 0449 (the media seam). **Stream**: B of A→B→C (+D).

## Goal

A working video player: **MP4/ISO-BMFF demux in C**, **H.264 video-only** playback, paced by the
kernel vsync broadcast, decoding through the 0449 media seam.

Video-only is deliberate — audio, A/V sync and seek are **0451**. Ship a player that plays a file
before taking on the clock problem.

## Plan

1. **Demux in C.** Vendor `minimp4` or hand-roll ISO-BMFF parsing. Use the **same vendoring pattern
   as `vendor/libpng` and `vendor/giflib`** (LICENSE + `bin.json` + `lib.json`, version pinned where
   that component's convention pins it — read the neighbouring component, do not assume a
   convention exists).
   ⭐ Demux is **cheap parsing**, so in-wasm is the right place for it. This is not in tension with
   the "no in-wasm decode" finding: parsing containers is not decoding frames.
2. **Feed the seam.** Decode via 0449's `createMedia`; present frames through the generalized
   `VideoFrame` path.
3. **Pace on the kernel vsync broadcast** — do not roll a private timer.
4. **Byte sources**: BlockFS and the landed `0x06xx` curl/fetch bridge. Both, not one.

## Constraints

- 🔴 **The deploy sets COEP `require-corp`.** Media must be **same-origin, or CORS/CORP-clean**. A
  player that only works against a local file and breaks on a remote URL has not met this arm —
  test both.
- 🔴 **`VideoFrame.close()` discipline is load-bearing** — the decoder stalls if frames are held.

## Acceptance

1. A real MP4 (H.264) plays in a gucOS window, driven by the vsync broadcast.
2. It plays from **BlockFS** and from a **URL over the `0x06xx` bridge** — both proven.
3. A COEP/CORP-clean remote source plays; the failure mode for a non-clean source is a **visible,
   specific error**, not a silent black window.
4. Sustained playback does not stall the decoder (frames are closed), and dropping the window
   releases decoder resources.
5. The demux vendoring matches the libpng/giflib pattern of its own component, and any generated or
   patched vendored file travels with its patch section in the **same commit** (`patchcheck.mjs`;
   if the pre-commit hook blocks you it is telling the truth — do not reach for `--no-verify`).

## Notes for the lane

- 🔴 **Grep for symbols; never trust a cited line number** — 0442 rewrote `host.js` before you ran.
- 🔴 Per **(FA)**, re-run each acceptance arm at spawn and report which were already green.
- Work in a **worktree** (`~/worktree/c-compiler/<slug>`), one repo.
- On a `todos/queue.json` rebase conflict: **drop your own close commit and re-run
  `node todos/queue.js done 0450`** on the new base, verify the staged blob, **never hand-merge**.
