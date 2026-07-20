# CHUNK 1 — the kernel key-grab table (mechanism)

`todos/KEYBINDING-OVERRIDE-SYSTEM.md` §3, sub-step (i). Branch
`keybind-grab-table`. This is the foundational kernel refactor the rest of the
user-overridable-keybinding system rides — mechanism ONLY (no keys.h registry,
no wm.c policy, no ctlpanel UI, no Exposé; those are later chunks).

## What landed

- **`WMP_GRAB_SET = 0x35`** (command) — `{ n, n × (scancode, km, token) }`
  replaces the WHOLE kernel key-grab table. Idempotent; `n = 0` installs an
  empty table (a WM that wants zero chord interception — a policy choice the
  mechanism must allow); `n` capped at `WM_GRAB_MAX = 64` (R_ERR beyond);
  subscriber-only (a non-subscriber sender gets R_ERR ENODEV).
- **`WMP_EV_HOTKEY = 0x92`** (event) — `{ token, flags, focusSid }` for every
  NON-reserved (user/wm.c-installed) grab match. `flags` bit0 = Shift held,
  bit1 = key repeat. Both key edges are swallowed.
- **Deleted the FOUR hardcoded `wmKey` chord blocks** (cycle/menu/snap/sysmenu
  — the old `if (scancode===43 && mod&0x300 …)` family tests) and replaced
  them with ONE data-driven match loop over the effective table
  (`this._wmKeyGrabs || WM_DEFAULT_GRABS`). The match is evaluated at the top
  of `wmKey`, before focus routing, and only with a WM subscribed — the no-WM
  pass-through rule is unchanged.
- **The built-in default table** (`WM_DEFAULT_GRABS`, 8 rows) carries RESERVED
  tokens (high bit set). A match on one emits the LEGACY event
  (EV_CYCLE/MENU/SNAP_KEY/SYSMENU) with its historical payload AND returns
  `wmKey`'s historical action string (`'cycle'/'menu'/'snap'/'sysmenu'`), so
  every pre-grab-table WM client and every scripted-WM test is byte-identical.
  Cycle keeps its DUAL default as two rows — `{Tab, ALT}` and `{Tab,
  CTRL+ALT}` — so both bare Alt+Tab and Ctrl+Alt+Tab stay recognized under
  exact match.
- **Subscriber-gone reset**: `_wmSubDrop` sets `_wmKeyGrabs = null` when the
  last subscriber goes (the 0069 valve) — a dead WM must not leave stale grabs
  eating keys for the next subscriber.
- **The km fold twin** (`wmKmFromSdl`) — a 4-line copy of `os/keys.h`
  `km_from_sdl`, kept in lockstep by hand (kernel is per-SYSTEM, keys.h is
  app-side). The kernel stays scheme- and config-blind: it stores
  `(scancode, km, token)` rows and routes; it never reads `/etc/keys` and
  never learns what a token means.
- `os/wm_proto.h` updated in lockstep (WMP_GRAB_SET, WMP_EV_HOTKEY,
  WMP_GRAB_MAX, WMP_TOK_RESERVED) — the spec of record. No C consumer uses
  them yet (wm.c policy is a later chunk); the two `#define`s are unused, so
  wm.c compiles byte-identically → no image version bump.

## The Fable amendment (folded in)

The match keeps the Shift bit in `entry.km`; it does NOT exclude Shift up
front. Rule:

```
matched = (entry.km & KM_SHIFT) ? (fold(mod) === entry.km)
                                : ((fold(mod) & ~KM_SHIFT) === entry.km)
```

So a Shift-NAMED override (`ctrl+shift+e`) installs and fires as itself and
never collapses to `{e, ctrl}` firing on plain Ctrl+E. Default rows never name
Shift, so the non-Shift branch always applies to them → today's
Shift-reverses-cycle (via the reported Shift flag) and Shift-extends-selection
behavior is byte-identical.

## Back-compat: the tightening is intended, and grep-verified safe

Exact-modifier match is a TIGHTENING of the old loose family masks
(`mod & 0xC0` etc.). Under it:

- **Ctrl+Alt+Esc** no longer opens Start (old `mod & 0xC0` matched any Ctrl).
- **GUI+Ctrl+arrow** no longer snaps (old `mod & 0xC00` matched any GUI).
- **Ctrl+Alt+Space** no longer opens the sysmenu (old `mod & 0x300` any Alt).

These are the intended change (they make rebinding sane: `bind.wm.overview
ctrl+f3` and a default `f3` grab must be distinguishable).

**I grepped the entire test estate for extra-modifier chord injections before
claiming the existing tests as the back-compat proof.** Every WM-chord
injection in `tests/kernel/test_wm.js`, `test_wm_policy.js` and the browser
sweeps (`os-wm.mjs`, `os-snap.mjs`, `os-shell.mjs`) uses EXACTLY the target
modifier family — the injected raw SDL word folds to the entry's km with no
extra non-Shift family bit. The single multi-family case is Ctrl+Alt+Tab
(`0x140` in test_wm.js, `Control+Alt+Tab` in os-wm.mjs), which the dual cycle
default covers by construction. Shift-variants (`0x301` Shift+Alt+Tab) stay
matched by the `~KM_SHIFT` mask. **No existing test depends on the loose
match**, so the tightening breaks nothing — and the whole point is that the
UNMODIFIED test_wm/test_wm_policy/test_wm_service/test_snap/test_saver legs
pass, which is what proves the refactor is behavior-preserving.

## Tests

`tests/kernel/test_keybind.js` (new, registered in `tests/kernel/run.js`), 34
legs, all green: default table reproduces the legacy events; the tightening
leg; GRAB_SET install → EV_HOTKEY {token, flags, focusSid} + both-edge
swallow; exact match (Ctrl+F3 misses bare-F3); the Shift amendment (named row
requires Shift, non-Shift row still matches with Shift held) + repeat flag;
whole-table replace; n=0 empty table; WM_GRAB_MAX cap + at-cap accept;
non-subscriber refusal; subscriber-gone reset; and the km-fold twin — it
PARSES `os/keys.h`'s `km_from_sdl` masks + `KM_*` defines and asserts the
kernel fold agrees over `0..0xFFF` (so drift in either file is caught).

## Gate

- `node tests/kernel/run.js` → **98 passed, 0 failed** (433s), including all
  unmodified WM/scripted tests.
- `node tests/flake.js --kernel-only` → green, all 4 tripwire files stable
  0% (wm_service/term/os_apps/comp_park), 3× under load ×10.

## NOT done here (later chunks)

keys.h `KS_ACTIONS` registry + chord parse/format/scancode fold + override
resolution; wm.c table build/push at poll cadence + EV_HOTKEY dispatch; the
new macos-scheme rows; F3 overview trigger; ctlpanel Shortcuts UI. Master
reviews this kernel diff (blast radius: ALL WM chords now route the grab
table) and sequences the rest.
