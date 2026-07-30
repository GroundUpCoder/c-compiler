# 0452 — Optional media encoder: VideoEncoder/AudioEncoder + window recording, capability-gated with a visible failure notice

- **Status**: open
- **Design**: this ticket. Origin: the gucOS video-player viability investigation (2026-07-30),
  commissioned by jku and reported to him by email.
- **Difficulty**: medium. **Run this lane on Fable** (jku's call for this stream).
- **Blocked by**: 0449 (the media seam) **only** — this ticket does **not** depend on 0450 or 0451
  and may run as soon as the seam lands. **Stream**: D of A→B→C (+D).

## Goal

Encoding: `VideoEncoder` / `AudioEncoder` in the 0449 media module, plus a **recording feature** —
natural v1 is **screen/window record**, because compositor frames are already GPU textures, so the
chain is `VideoFrame` → `VideoEncoder` → in-wasm muxer → the egress download path.

🔴 **jku asked for this feature explicitly AND asked for it to be optional.** Both halves are the
requirement. "Optional" here means **capability-gated with a visible failure**, not "skipped".

## The fail-loud requirement (this is the point of the ticket)

Where encoding is unavailable, the feature **must fail gracefully and say so**:

1. **Probe at init** — via 0449's independent encode probe. 🔴 **Never infer encode from decode**;
   iOS Safari 16.4-18 shipped decode-only WebCodecs.
2. **Gate the UI** on the probe result.
3. **Surface a visible error notification** when absent — a **MessageBox via the win32 veneer** —
   per the established fail-loud-not-silent-no-op convention.

🔴 **A silent no-op fails this ticket.** So does a gate that is never exercised: prove the
unavailable path, do not just prove the available one.

## Codec portability (for the lane — measured in the investigation)

- **H.264 is the most portable video encode.**
- **Opus is the ONLY portable audio encode.** AAC encode is absent in Firefox everywhere, and in all
  browsers on desktop Linux.
- ⚠️ **`hardwareAcceleration` is a hint. `isConfigSupported` is the only truth** — gate on the probe,
  never on a hardware-acceleration preference.

## Plan

1. `VideoEncoder` / `AudioEncoder` in the same `createMedia` host module as the decoders.
2. In-wasm muxer for the output container (cheap writing, same reasoning as demux in 0450).
3. Window/screen recording: compositor texture → `VideoFrame` → encoder → muxer → egress download.
4. Capability gate + MessageBox failure notice, per above.

## Acceptance

1. Recording a gucOS window produces a playable file (H.264 video; Opus if audio is included), via
   the egress download path.
2. The encode capability probe is **independent of the decode probe** and gates the UI.
3. 🔴 **The unavailable path is exercised and proven**: with encode support forced absent, the UI is
   gated **and** a MessageBox appears naming the reason. **A test that only runs where encoding
   works does not test this arm** — force the negative.
4. Frames are closed across a sustained recording; stopping a recording releases encoder resources.
5. `isConfigSupported` is the gate in code — assert that no path gates on `hardwareAcceleration`.

## Notes for the lane

- 🔴 **Grep for symbols; never trust a cited line number.** Re-derive every anchor at spawn.
- 🔴 Per **(FA)**, re-run each acceptance arm at spawn and report which were already green.
- **Build to the goal, not the demo** — an encoder surface that happens to satisfy only the window
  recorder is the shortcut this ticket rejects.
- Work in a **worktree** (`~/worktree/c-compiler/<slug>`), one repo.
- On a `todos/queue.json` rebase conflict: **drop your own close commit and re-run
  `node todos/queue.js done 0452`** on the new base, verify the staged blob, **never hand-merge**.
