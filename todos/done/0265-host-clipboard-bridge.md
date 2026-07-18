# 0265 — host clipboard bridge

- **Status**: done (2026-07-18, ticket #79; no bake — image stays v125)
- **Design**: —

## Goal

Bidirectional host ↔ gucOS clipboard sharing (ticket #79): a copy in the
host OS pastes into gucOS, and a gucOS copy (`clip`, notepad ^C, term
Ctrl+Shift+C — anything committing the 0090 kernel slot) lands on the host
clipboard, honestly designed around the async Clipboard API's secure-context
+ document-focus + permission constraints.

## Plan

- kernel.js: `opts.onClipboard` fired at the CLIP_SET COMMIT choke (the OS
  clipboard's change signal — no poll; the slot is kernel-private, so the
  one mutation point is the seam) + embedder `Kernel.clipSet/clipGet` that
  do NOT fire the hook (the bridge's loop guard).
- os/kernel-worker.js: `{type:'clipboard', text}` both ways — fmt 1 text
  only crosses to the host (fmt 2 file lists carry OS-absolute paths;
  clears never blank the host clipboard).
- os/os.html: gucOS→host = `navigator.clipboard.writeText` on the commit
  message (a user-driven copy implies tab focus); host→gucOS = `readText`
  on window FOCUS (pasting into gucOS requires focusing the tab first, so
  the sync beats any humanly possible paste chord) + best-effort re-read on
  the desktop paste chords; `clipSynced` de-dups both directions and is the
  loop guard, focus-wins on genuine divergence.

## Acceptance

- `tests/kernel/test_hostclip_e2e.js`: real C copy fires the hook with the
  committed bytes; embedder clipSet reaches SDL_GetClipboardText without
  firing the hook; clear reports null.
- `tests/browser/os-clipboard.mjs`: real-Chromium round trip both ways with
  permissions granted, loop-guard counter, VT2 paste-chord refresh.
- Honest limit: the real permission PROMPT + OS-level tab-focus flow needs
  a human check (headless pages are always focused and grantPermissions
  bypasses the prompt).
