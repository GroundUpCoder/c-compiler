# 0070 — Desktop as the default tab

Small UX flip with one real design constraint: the first thing a user sees
should be the desktop (VT2), but VT1-during-boot is intentional — the boot
log streams there, and `boot-error`/`halt` force VT1 as the escape hatch.
So the change is NOT "seed `data-vt=2`"; boot still starts on VT1 and a
**healthy** boot auto-switches at the `ready` message.

## What landed (os/os.html only — zero kernel change, not a bake input)

- `case 'ready'`: `if (!vtTouched) setVt(2)` — the auto-switch. `ready`
  fires exactly once, on success, so it never races `boot-error` (which
  still calls `setVt(1)`) or `halt`.
- `vtTouched` + `userSetVt()`: every USER-driven switch path (tab clicks,
  the Ctrl+Alt hotkeys, and the `__osVtSwitch` agent probe) marks the flag,
  so a VT picked while the boot streams sticks — the auto-switch only fires
  when the user hasn't expressed a preference. Internal forced switches
  (boot-error, halt, the auto-switch itself) call `setVt` directly and
  don't mark it.
- If the user DID pick VT1 during boot, ready keeps the old
  `term.focus()` behavior.

Because os.html is a runtime-only file (excluded from `newestBakeInput`,
0082), no `image.json` version bump is needed.

## Test fallout — the real bulk of the change

Every browser test boots to `ready` and now lands on VT2, so anything that
typed into the shell right after ready silently typed at the canvas
instead. Audit result:

- **os-vt.mjs** (the VT-semantics owner): restructured — asserts VT1
  during boot (probe right after goto; vacuous if ready wins), VT2 after
  ready (desktop visible, canvas focused), then the 0070 acceptance "one
  click on the Terminal tab = fully usable tty" via `#vt1tab`, then the
  hotkey aliases. New final leg: a SYNTHETIC `boot-error` (drives
  `kernel.onmessage` directly — a real boot failure can't be provoked from
  the page) proves the escape hatch forces VT1 with `__osBootErr` set.
- **os-boots.mjs**: asserts the VT2 landing, hops to VT1 before the shell
  legs (all three boots: first, reload, page2 retry). The reload leg also
  covers manual-choice-wins: grab VT1 via `__osVtSwitch` while the reboot
  streams — if ready wins the race it degrades to a plain post-ready
  switch, so no flake either way.
- **os-screen.mjs**: the auto-switch IS the first VT2 entry now, so the
  "boot screen is the 800x500 default" leg is gone — replaced by "the
  auto-switch re-modes the screen to the pane". The VT1-resize-deferred
  leg keeps its rationale, just at the synced size (1100) instead of
  800x500.
- **os-quake / os-term / os-gpubox / os-drop(reload)**: one added
  `setVt(1)` before their first shell command.
- Untouched by design: os-wm, os-shell, os-cairo, os-gdi, os-user32,
  os-winmine, os-scale, os-doom — their first post-ready action was
  already `setVt(2)` (now a no-op) and they always `setVt(1)` before
  typing.

Docs synced: os.html header, CLAUDE.md os/ section, todos/WM.md 0022
block, tests/browser/README.md os-vt row.

## Verification

`node tests/browser/os-sweep.mjs` — 15/15 green (serial by design).
