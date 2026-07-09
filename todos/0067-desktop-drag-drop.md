# 0067 — drag-and-drop files onto the desktop

- **Status**: open
- **Depends**: none (soft: nicer after 0066, so a dropped ROM is runnable)
- **Design**: `OS.md` (page ↔ kernel bridge), `KERNEL.md` / BlockFS

## Goal

Drop a file from the host onto the running OS and have it land in
`~/Desktop` (`/root/Desktop`), where the wm's icon grid picks it up
automatically. Turns "get a file into the OS" from a bake-time-only
operation into a live gesture. Pairs with `0066`: drop a `.gb` ROM (or a
`#!/bin/sh` launcher) and double-click it.

## Background

- The page → kernel-worker channel is a documented `postMessage` switch
  (`os/kernel-worker.js` `self.onmessage`, ~L68). Adding one inbound
  message type is the established extension pattern.
- BlockFS already exposes an in-worker write API (`host.js`
  `BlockFS.open`/`write`, and `MountFS` routing to the writable root
  volume) — the kernel calls `fs` directly, so no per-process fd/RPC
  round-trip is needed.
- `/bin/wm` `desk_load()` (`wm.c` ~L468) re-reads `/root/Desktop` on a
  frame timer and repaints on change → a newly written file appears as an
  icon with no extra notify plumbing.

## Plan

- **`os/os.html`**: `dragover`/`drop` listeners (with `preventDefault`)
  on the desktop canvas; for each dropped `File`, `await file.arrayBuffer()`
  and `kernel.postMessage({type:'drop-file', name, bytes}, [bytes])`
  (transferable → zero-copy). Optional drop-highlight overlay.
- **`os/kernel-worker.js`**: handle `{type:'drop-file'}` — write bytes to
  `/root/Desktop/<sanitised name>` via the `fs` instance (open O_CREAT|
  O_TRUNC|O_WRONLY, write, close), then `flush()` to OPFS for persistence,
  and echo a tty line (`dropped foo.gb → /root/Desktop/foo.gb`).
- Name collision policy (overwrite vs. `-1` suffix); size sanity cap.
- Browser-only; headless `boot.js` is unaffected.

## Acceptance

- Dragging a file from the host onto the desktop writes it to
  `/root/Desktop/` and an icon appears within ~1s without a reboot.
- The file survives a page reload (OPFS flush).
- Binary payloads (e.g. a `.gb` ROM) are byte-identical after the round
  trip.
- With `0066` landed: a dropped ROM (or launcher script) is double-click
  runnable.
