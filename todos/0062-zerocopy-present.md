# 0062 — zero-copy present (direct transport + cross-agent seam)

- **Status**: deferred (parked at the bottom of the queue) — revisit only
  when a fullscreen app is *measured* to need the last copy back. The
  default `gpu` transport already stays GPU→GPU, so `direct` buys exactly
  one intra-GPU copy per frame at the cost of a net-new present codepath.
  The cross-agent-sharing half is **not** deferred with it: it is an
  in-place upgrade of the `gpu` transport (see `todos/WM.md`, "Cross-agent
  WebGPU sharing"), do it when the spec ships.
- **Design**: `todos/WM.md` (transports; "Open questions: `direct`
  transport promotion" and "Cross-agent WebGPU sharing")

## Goal

Make the platform invariant explicit and enforced: **composited pixels
never touch CPU RAM except on an explicit client request (`wmctl shot`).**
Today `gpu`-transport frames already stay GPU→GPU in the browser; this item
promotes the reserved `direct` transport (zero-copy fullscreen present via
a per-window DOM canvas the browser composites) and wires the cross-agent
WebGPU texture-sharing seam so `gpu` present becomes a zero-copy *import*
when the spec ships it. Rides the `0055` WebGPU compositor pass.

## Plan

- Light up `direct` transport (the two-hop OffscreenCanvas transfer spike
  WM.md names): a fullscreen `webgpu.h` app presents with zero copy; the
  kernel does not read its pixels.
- The cross-agent-sharing seam at the same protocol point (import instead
  of `copyExternalImageToTexture`) — behind a capability probe.
- Assert the invariant: no readback on any present path; readback only in
  the explicit `wmctl shot` code path and the headless CPU composite.

## Acceptance

- A fullscreen `gpu` app on `direct` presents with a measured **zero**
  compositor-side copies; `wmctl shot` still works (explicit readback).
- shm / headless goldens unchanged.
