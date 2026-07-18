# Software storefront over gucman — ticket #81, todos/0267 (image v126)

`/bin/software`: a graphical app store fronting gucman. Mac-App-Store
shape on the Win95 substrate: white header ("Software", "9 applications ·
1 installed", Refresh), a scrollable card list (name+version, gray
summary, payload size / green "Installed" / orange "Needs OS vN", one
Install/Remove button per card), a live status bar. Menu entry
Accessories/software.

## Division of labor (the design decision)

gucman IS the engine; the GUI is a pure front-end that never fetches
payloads, never touches /opt, never re-implements install logic:

- **Catalog**: gucman grew an `index` subcommand — fetch the repo
  index.json, validate it parses, print the RAW bytes to stdout. The GUI
  spawns it and parses with cJSON, so it links no curl/zlib, and a repo
  failure surfaces gucman's own stderr verbatim (status line + the
  "Cannot reach the package repository" notice). Considered and
  rejected: linking curl into the GUI (two network stacks, two error
  vocabularies, drift).
- **State**: `/var/lib/gucman/<name>.json` record-exists == installed —
  gucman's own crash-safe contract, read directly. An FS_WATCH (#75) on
  the DB dir rides user32's RegisterFdWake seam (the fileman 0123
  pattern), so a CLI `gucman install` beside the open window flips the
  card with no clicks. The dir is mkdir-p'd at startup (watch fds
  require an existing path).
- **Actions**: posix_spawn `/bin/gucman install|remove <name>` with
  stdout+stderr dup2'd to `$HOME/.cache/software.out`. Deliberately NOT
  a pipe on the fd-wake seam: `fdwake_scan` drains registered fds and
  DISCARDS the bytes (right for watch fds, wrong for output capture),
  while regular-file reads never block — so a 150ms WM_TIMER tail-reads
  the file for the live ticker and `waitpid(WNOHANG)`s the child. The
  `index` job splits stderr to its own file so the JSON stdout stays
  parseable while errors still tick the status line.

Honest state, no needles: after a job the DB is re-read either way; a
nonzero exit raises a MessageBox with the real output tail. One job at a
time (gucman's DB is not concurrent-write-safe) — every action button +
Refresh disables while one runs. Installed-but-not-in-catalog packages
stay listed and removable, so uninstall works with the repo unreachable;
minBase > base disables Install with "Needs OS vN".

## Veneer notes

- Cards are a custom `PkgCard` child class: full typographic control in
  WM_PAINT, and the card's window TEXT mirrors
  `<name> <version> [<state>]` — `tree_dump` WM_GETTEXTs every window,
  so the whole catalog (hidden cards included) is agent-visible and
  `wmctl wait label` targets real state flips.
- Scrolling is card-granular (scrollbar + wheel + arrows/PgUp/Home/End):
  GetDC clamps child DCs against the SURFACE, not my list area, so a
  partially-scrolled card would overpaint the header/status bar —
  off-viewport cards are hidden instead, nothing ever shears.
- Fixed size on purpose (no WS_THICKFRAME — NB `WS_OVERLAPPEDWINDOW`
  includes it); the kernel scales fixed windows via SET_DST.
- `ascii_fold` turns typographic dashes into '-' before painting —
  mono.ttf lacks them, and a folded hyphen beats tofu. The dashes only
  ARRIVE intact because of the printf fix below.

## The bug found on the way

Card summaries rendered "mGBA �? Game Boy" — chased to a real P0:
host.js's printf `%s` corrupted bytes 0x80–0x9F (the `latin1`
TextDecoder label is windows-1252). Fixed test-first in the prior
commit; full story in `logs/2026-07-18/printf-latin1-highbyte.md`
(todos/0266).

## Test (test_software_e2e.js, kernel suite)

One boot session, minimal image + real serve.js repo: dead-repo honest
error first (notice visible, gucman's connect error in the status
STATIC), then Refresh against the live repo → a card asserted for EVERY
index package, then one-click install of punes with REAL fs asserts
(DB record + `/opt/punes/punes` executable + `/usr/local/bin` symlink),
one-click remove (all gone), then the FS_WATCH legs (CLI install/remove
flip the cards clickless). The punes button's `BUTTON:n` address is
predicted (Refresh first, then card order — children append in creation
order) and re-verified against the tree dump. Gotcha for future tests:
`wmctl tree` prints `== pid N` app headers, which terminate the stock
`section()` marker helper — tree dumps need explicit start/end markers.

Gate: image v126 (bake input closure picks up host.js + software.c);
kernel 92/92, sweep 30/30, unit/host/blockfs green, flake tripwire
green, new e2e stable 3× under load. compiler.js untouched.

Deliberate scope cuts: no Desktop icon (user-section seeds only fresh
roots, and existing desktop e2es do icon-grid index math); no per-card
progress bars (gucman's line output IS the progress surface); no
multi-job queue (serialize on the DB).
