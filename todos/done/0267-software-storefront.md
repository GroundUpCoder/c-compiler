# 0267 — Software storefront GUI over gucman (ticket #81)

- **Status**: done
- **Design**: —

## Goal

A graphical app store fronting gucman (ticket #81): browse the package
catalog, install/remove with one click, honest install-state feedback.
"Reliable, simple, functional" — clean card layout, not a raw list dump.

## Plan

gucman stays the ONE engine; the GUI never fetches payloads or touches
/opt:

- gucman grew `index` (fetch the repo index.json, validate, print RAW to
  stdout) — the catalog surface for front-ends, so the GUI links no curl
  and repo errors are gucman's own stderr verbatim.
- `/bin/software` (os/win32/software.c, user32 veneer + cJSON): fixed
  560×412 window; white header (title, "N applications · M installed"
  subtitle, Refresh) — card list (one custom "PkgCard" child per package:
  name+version, ellipsized summary + deps, colored state / payload size,
  one Install/Remove button) — SBS_VERT scrollbar + wheel + keys
  (card-granular; child DCs clamp to the surface, so partial cards are
  never shown) — status-bar STATIC fed from gucman's live output.
- Job engine: posix_spawn `/bin/gucman index|install|remove` with
  stdout+stderr dup2'd to a capture file (user32's fd-wake drain DISCARDS
  bytes; regular-file reads never block), WM_TIMER 150ms tail-read +
  waitpid(WNOHANG). One job at a time (the DB isn't concurrent-safe);
  failure = MessageBox with the real output tail + state re-read from the
  DB either way.
- State = /var/lib/gucman DB records (gucman's record-exists contract) +
  FS_WATCH on the DB dir via RegisterFdWake — CLI installs beside the
  open window flip cards live. minBase gated ("Needs OS vN", Install
  disabled); installed-but-not-in-catalog packages stay listed and
  removable (uninstall works with the repo unreachable).
- Card window TEXT mirrors `<name> <version> [<state>]` → the whole
  catalog is agent-visible in `wmctl tree`, and waits target real state
  flips.
- Registered: image.json `/usr/bin/software` + menu Accessories/software,
  image v126. No Desktop icon by design (fresh-root-only seeding + the
  desktop-icon index math in existing e2es).

## Acceptance

- tests/kernel/test_software_e2e.js: dead-repo honest error (notice +
  gucman's own stderr in the status line), catalog cards for EVERY index
  package, one-click install → REAL fs asserts (DB record, /opt binary,
  /usr/local/bin symlink), one-click remove → all gone, FS_WATCH
  liveness legs. Stable 3× under load.
- kernel 92/92, sweep 30/30, flake gate green; compiler.js untouched.
- Found + fixed [[0266]] (printf high-byte corruption) via the card
  summaries rendering tofu.
