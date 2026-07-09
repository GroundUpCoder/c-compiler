# Two-tab boot guard — Web Locks on the OPFS image pair (todos/0045)

Two tabs on the same origin used to boot two KERNELS — two process
tables, two compositors, two fd brokers — over the same OPFS images.
BlockFS's dual-instance fuzzing proves *store* coherence, not two
control planes; that territory is undefined. Now the second tab gets a
clean "already running" screen with a Retry button.

## Shape

- **The lock lives in kernel-worker.js, not the page.** The v5 image
  names (`os-system.v5.img` / `os-root.v5.img`) are worker-side
  constants, and the item's requirement is "before mounting OPFS" — the
  mount is the worker's first act. Putting the lock next to the names it
  guards avoids a MUST-MATCH duplication in os.html; the page stays a
  dumb bridge that renders `boot-locked` and forwards `boot-retry`.
- **Lock name** `wasm-os:os-system.v5.img+os-root.v5.img` — named after
  the image pair per the item, so unrelated dev pages on the origin
  (standalone host.js pages use `workspace.v4.img` etc.) never collide,
  and a future image-name flip (v5→v6) automatically gets its own lock.
- **`ifAvailable: true`** keeps acquisition non-blocking: the boot
  either owns the disk or reports `boot-locked` having touched NOTHING
  (no `getFileHandle(create:true)`, no SyncAccessHandle). The winning
  request callback returns a forever-pending promise — the Web Locks
  idiom for "hold until the agent dies"; the browser releases it when
  the tab closes, crashes included. No steal in v1 (per the item).
- **Retry is a message round-trip**, not a reload: the page hides the
  guard optimistically and posts `boot-retry`; a still-held lock just
  answers `boot-locked` again. `startBoot()`'s `booting` flag makes
  over-clicking harmless (retries during an in-flight boot are ignored;
  only the lock-lost path resets the flag — a real boot failure stays
  terminal/reload-to-reboot, as before). The pre-boot `wm-canvas` /
  `resize` messages sit in the existing `pending` queue and drain after
  a successful retry boot, so the compositor comes up normally.
- **No-Web-Locks environments** (old browsers) boot unguarded — a
  graceful degradation to today's behavior, not a hard requirement.

## Gotcha worth recording

A halted OS still holds the lock: `exit` from pid 1 posts `halt` but the
kernel worker (and its forever-pending lock callback) lives until the
tab closes. That's correct — the halted tab still owns the mounted
SyncAccessHandles — and the test leans on it: the second tab must show
the guard against a *halted* first tab, and only `page.close()` frees
the lock.

## Testing

Three new legs at the end of `tests/browser/os-boots.mjs` (same context
= same origin/OPFS/lock partition): second tab lands on the guard
(`__osState === 'locked'`, guard visible, terminal hidden); closing the
first tab + Retry boots to ready over the reused image (the click loop
tolerates the async close→release lag); the retried boot reaches a live
shell (`echo GUARD-SHELL-OK`). Full run: os-boots 11/11.

Single-tab behavior unchanged: the rest of the browser sweep ran green
serially (os-vt, os-wm, os-screen, os-scale, os-shell, os-term, os-doom,
os-quake, os-gpubox), and headless `boot.js` is untouched by design —
two `node os/boot.js` over one image file remain unguarded (flock-style
follow-up noted in the item, not scheduled). "Seats v2" (extra tabs as
remote seats) stays a sketch in `todos/done/0045`.
