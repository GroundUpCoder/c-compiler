# 0019 — client resize (SURFACE_CONFIGURE)

- **Status**: queued
- **Depends**: 0014 (resize interaction is WM policy)
- **Design**: `todos/WM.md` (surface protocol — `SURFACE_CONFIGURE`
  reserved; "Resize: not in v1" decision)

## Goal

The deliberately-deferred fiddly part of the protocol: buffer
renegotiation without tearing, landed additively on the reserved opcode.

- Protocol: WM resize-drag on chrome → `SURFACE_CONFIGURE(w, h)` to the
  client → client allocates a new shm SAB pair (reuse the
  `{type:'wm-sabs'}` FIFO pattern) and acks with its first frame at the
  new size; kernel drops the old buffers only after that frame. Mailbox
  semantics preserved throughout — in-flight old-size frames are legal and
  ignored.
- SDL side: `SDL_EVENT_WINDOW_RESIZED` into the event queue;
  `SDL_UpdateWindowSurface` re-derives from the new SAB; gpu transport
  resizes the worker-local OffscreenCanvas.

## Acceptance

- Drag-resize a winbox/gpubox window in the browser: no tearing, no
  crash, content re-renders at the new size.
- Headless kernel test exercises renegotiation including an in-flight
  old-size frame; existing suites green.
