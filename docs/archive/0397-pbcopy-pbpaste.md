# 0397 — pbcopy/pbpaste — macOS-named front-ends over the kernel clipboard slot

- **Status**: done
- **Design**: none needed — the capability already exists; this is a naming + factoring job.

## Goal

Ship `pbcopy` and `pbpaste` as real programs in `/usr/bin`, with the macOS semantics jku
expects:

```
cmd | pbcopy      stdin  -> the clipboard
pbpaste           clipboard -> stdout
```

**The capability is already built and is NOT in scope to re-invent.** `os/clip.c` (from
`todos/0090`, done) is the Windows `clip.exe`-shaped bridge over the kernel's *one* clipboard
slot (`SDL_SetClipboardText`/`SDL_GetClipboardText` across the `CLIP_SET`/`CLIP_GET` RPCs).
That slot is genuinely bridged to the **host** clipboard (the ticket-#79 seam in `os/os.html`
+ `os/kernel-worker.js`, including the deferred-`CLIP_GET` refresh so a paste consumer
re-reads the host clipboard inside a live user activation), and it is shared with term's
Ctrl+Shift+C/V and every win32 app's Ctrl+C/X/V. So `echo hi | pbcopy` must really paste into
notepad, and `pbpaste` must really see what you copied in the host browser.

`pbcopy` ≡ today's `clip`; `pbpaste` ≡ today's `clip -o`.

## Plan

⭐ **Build-to-the-goal, not to a demo.** These are not aliases and not a shim — they are real
programs with real usage/exit-code behavior, registered the same way every other bin is, and
covered by a test. Do not special-case the easy path.

**DECISION — two separate programs sharing a header, NOT one multi-call binary.** Recorded
here with its evidence so it is not re-litigated:

- `os/image.json` maps **one path → one source** (`"/usr/bin/clip": { "c": "clip.c" }`).
  There is **no symlink/hardlink/alias mechanism** in the manifest, so a busybox-style
  `argv[0]` dispatch would have to be registered as the same `.c` under two paths — which
  compiles the same code into two independent binaries and makes the `argv[0]` switch pure
  dead weight. The multi-call pattern buys nothing here; it only pays when several applets
  share **one** on-disk binary, which this image format cannot express.
- The right factoring is the one the codebase **already uses**: a shared header pulled in via
  the manifest's existing `hdrs` field (precedent: `os/image.json` `hdrs` on `/usr/bin/open`;
  and `os/fileops.h` shared by `wm.c` and `os/win32/shell32.c` so the desktop and fileman
  behave identically).

So:

1. Extract the clipboard I/O that `clip.c` already implements — slurp-stdin-to-buffer, set
   slot, get slot — into **`os/clipio.h`**.
2. Rewrite `os/clip.c` to use it (behavior byte-identical; `clip` and `clip -o` keep working —
   this is a refactor, not a rewrite of its contract).
3. Add `os/pbcopy.c` and `os/pbpaste.c` over the same header.
4. Register both in `os/image.json` alongside `/usr/bin/clip`, each with
   `"hdrs": ["clipio.h"]`.

**Behavior to get right (not optional):**
- `pbpaste` on an empty slot: **exit 1**, print nothing (matches `clip -o`).
- `pbcopy` with any argument: usage to stderr, **exit 2** (it takes no arguments; macOS's
  `-pboard` flavors are out of scope — say so in the usage string rather than silently
  ignoring argv).
- `pbpaste` with any argument: same — usage, exit 2.
- Read errors → `perror` + exit 1, as `clip.c` does.
- Carry `clip.c`'s known limit forward **explicitly in a comment**: the slot is
  `SDL_SetClipboardText`, a C string, so **bytes past a NUL do not ride**. This is a real
  constraint of the one-slot design, not a bug to fix here.

🔴 **An image bump is owed** — `os/image.json` gains two `/usr/bin` entries, so the image
content changes. Bump `os/image.json`'s `version` in the same commit.

## Acceptance

- `tests/kernel/` gains coverage in the shape of the existing
  `tests/kernel/test_clipboard_e2e.js` / `test_hostclip_e2e.js`, **registered in
  `tests/kernel/run.js`** (an unregistered test is `todos/0396`'s whole defect — do not
  repeat it). It must assert the round trip in **both** directions and the empty-slot exit 1.
- Cross-tool interop proven, not assumed: `echo hi | pbcopy` then `clip -o` prints `hi`, and
  `echo hi | clip` then `pbpaste` prints `hi` — i.e. all three programs are demonstrably on
  the **same** slot.
- Kernel suite + browser sweep green, with **numbers** (a suite without a number is not run).
- `node todos/queue.js check` passes.
- `os/image.json` version bumped.

## Outcome (2026-07-29, branch `0397-pbcopy`)

Shipped as planned. `os/clipio.h` holds the two operations. `os/clip.c`, `os/pbcopy.c` and
`os/pbpaste.c` include it through the manifest's `hdrs` field. `os/image.json` is at
version 190.

The decision above was kept. There are two programs and one header, not a multi-call
binary.

`clip`'s contract is unchanged, and the test asserts each part of it after the refactor:
`clip`, `clip -o`, `clip -o` on an empty slot exits 1, and any other argument gives usage
with exit 2.

Interop is proved in both directions, verbatim:

```
--- echo hi | pbcopy ; clip -o ---
hi
--- echo hi | clip ; pbpaste ---
hi
--- empty slot ---
pbpaste rc=1
```

`tests/kernel/test_pbcopy_e2e.js` is the acceptance test, registered in
`tests/kernel/run.js`. It has 20 checks. Session A covers the command line. Session B
proves the win32 veneer is on the same slot: `pbcopy` feeds notepad's paste, and notepad's
Copy feeds `pbpaste`.

The NUL limit has a negative control. The test counts the input bytes (3) before it counts
the output bytes (1). Without that control, a lost shell escape looks the same as
truncation.

Dev log: `logs/2026-07-29/0397-pbcopy-pbpaste.md`.

## Notes

- `todos/LIABILITIES.md` is machine-checked by the todos suite — re-anchor or retire an
  anchored line in the same commit. **A gap that does not enter `todos/` does not exist.**
- Filed at jku's request (via the meta-meta router), 2026-07-28: *"For the easy ones you can
  just queue the work directly."* This is the easy one — **no design pass**.
- Sibling: `0398` (host↔gucOS file transfer seam) covers the genuinely hard half of the same
  jku request. `0397` does **not** depend on it.
