# keybind-registry — CHUNK 2: the keys.h override/registry policy layer

Branch `keybind-registry` off `main`. Second chunk of the user-overridable
keybinding system (design `todos/KEYBINDING-OVERRIDE-SYSTEM.md`; CHUNK 1, the
kernel grab-table mechanism, is already merged at `3f414c2`). This chunk is
the POLICY layer entirely inside `os/keys.h`: the named-action registry,
`bind.<action>` override resolution over the existing `keys` cfgstore overlay,
and the ONE text-chord parse/format/scancode surface. Deliberately NOT here:
wm.c pushing the grab table (chunk iii), the ctlpanel Shortcuts UI (chunk iv),
or Exposé.

## What landed

- **`KS_ACTIONS` registry** — one fixed table, 8 SYSTEM + 13 APP = 21 actions.
  Each row: stable name (`wm.snap-left`, `edit.copy`, …), kind, ctx mask (app),
  and a `token` that is the `KTOK_*` grab token for system actions or the
  `KA_*` verb for app actions. SYSTEM rows carry per-scheme default chords
  inline (`def[scheme][slot]`, up to 2 — cycle keeps its dual Ctrl+Alt+Tab /
  Alt+Tab default). APP defaults are NOT duplicated: `ks_action_default()`
  derives them from the existing `KS_TABLE` rows by `(scheme, KA_*, ctx)`, so
  the two source-of-truth tables can't drift.

- **The jku-decided macos rows** added to `KS_TABLE`: `⌘←/→` →
  `KA_LINE_START/END`, `⌘↑/↓` → `KA_DOC_START/END` (all four arrows, per the
  decider's YES on META-ARROW Q1). `rl=0` — the native idiom, always on in
  macos scheme, not the readline bundle. They're INERT on the current build:
  the kernel still grabs GUI+arrow for snap until wm.c relocates tiling to
  Ctrl+Alt+arrow (chunk iii). Windows scheme unchanged.

- **KK_* vocabulary extension** — F1–F12 (contiguous, `KK_F1 + n`), plus
  tab/esc/space/enter/backspace/pgup/pgdn/ins/delete. `ks_chord_scancode()`
  maps every canonical key to its SDL scancode (letters `4+(c-'a')`, digits
  `30+`, the named-key table) — the TWIN of the kernel's `WM_DEFAULT_GRABS`
  scancodes, cross-checked in the test.

- **`ks_parse_chord` / `ks_chord_str`** — the ONE parse/format pair, canonical
  round-trip. Case-insensitive; modifier aliases `option=alt`,
  `cmd/win/meta=gui`; a bare F-key is a valid chord (F3 is the proof); a
  modifier-only or two-key or unknown token is rejected. Format order
  ctrl+alt+shift+gui with canonical names (`gui`, not `cmd`). Hand-rolled
  `+`-splitter — `strtok_r` is NOT in the OS libc (compiler.js ships only
  `strtok`); this bit me first, caught by a compiler.js smoke-compile before
  the bake would have.

- **Override resolution** — `ks_get` parses `bind.<name>` for every registry
  action from the same `cfg_load3` text (zero new config machinery): `none` →
  unbound, `default`/absent → scheme default, else `ks_parse_chord`; a
  malformed value falls back to the default LOUDLY (one stderr line). Cached
  by the existing 1 Hz `ks_cached` revalidate. `key_action()` is now
  override-aware: (1) user overrides first (registry order breaks a
  hand-edited two-override tie), then (2) the scheme-default `KS_TABLE` scan
  minus any overridden action's row — a rebind MOVES the binding — with the
  carve-out that readline rows (`rl==1`) are never suppressed or overridden.
  Overrides are scheme-independent (stored by action id).

- **`ks_action_binding`** — the effective chord(s) for any registry action
  (override wins, else scheme default), the resolution wm.c (system grab
  table) and ctlpanel (display) will consume.

## The `edit.copy` vs `term.copy` split

Two registry actions can map to the same `KA_*` (edit.copy ctx EDIT,
term.copy ctx TERM, both `KA_COPY`). In macos they even share one `KS_TABLE`
row (`{EDIT|TERM, gui, 'c'}`). The ctx-scoped suppression makes this correct:
`key_action` is always called with a single ctx bit, so at most one of the two
claims a given call, and overriding edit.copy suppresses `⌘C` in EDIT while
term.copy's `⌘C` in TERM survives the same shared row. Verified in the probe.

## Testing

Native-C probe `tests/kernel/keybind_registry_probe.c` (keys.h is
SDL-header-free POSIX — compiles with clang, no boot, no wasm) driven by
`tests/kernel/test_keybind_registry.js`: registry defaults per scheme
(windows vs macos, incl the new line/doc-nav + Ctrl+Alt+arrow tiling + F3
overview), rebind moves / none unbinds / default restores / malformed
loud-fallback, readline-row immunity, scheme-independence, and parse/format
round-trip — ~60 checks. Config-dependent scenarios each run in a forked
child with its own `$HOME` so the 1 Hz cache reads fresh. The JS side adds
the scancode twin cross-check against `kernel.js WM_DEFAULT_GRABS` (the same
lockstep discipline `test_keybind.js` keeps for the km-fold). Registered in
`tests/kernel/run.js` (the 0264 explicit-registry lesson).

Chunk-1 `test_keybind.js` still green unmodified (km_from_sdl untouched). Full
kernel suite: **99 passed, 0 failed** (435s incl the one-time v137 bake, which
compiled every keys.h consumer — wm.c/user32.c/term.c/ctlpanel.c — against the
new header).

## Deploy note

`os/keys.h` IS a bake input, so this needs an image version bump WHEN it
deploys — but NOT now: chunk 2 is not independently user-visible (the new
rows are inert and no config writes `bind.*` yet). The bump rides with chunk
iii, when wm.c wires the grab table and the feature first reaches users.
