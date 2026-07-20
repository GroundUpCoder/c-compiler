# KEYBINDING-OVERRIDE-SYSTEM — user-overridable key bindings, one system

Status: DESIGN — no implementation yet. Companion queue items to be filed on
approval. Read together with `todos/KEYMAP.md` (the scheme substrate, 0149/
0150), `todos/META-ARROW-KEYBIND.md` (Meta+arrow line-nav vs tiling) and
`todos/EXPOSE-MISSION-CONTROL.md` (the overview feature that will be the first
new rider on the shared grab mechanism designed here).

The ask (jku, 2026-07-20, folded in as DECIDED defaults):

- **Mission Control / Exposé trigger = F3** plus the on-screen taskbar button
  — both, as co-equal alternatives. F3 overlapping the host-Mac Mission
  Control key is fine per jku: *overlap with real OS key bindings is fine*.
  This OVERRIDES the earlier `Ctrl+Alt+E` recommendation in
  EXPOSE-MISSION-CONTROL.md open question 1.
- **Meta+Left/Right = line start/end in the macos scheme** (META-ARROW's
  mode-dependent recommendation is now the default); **tiling relocates to
  Ctrl+Option+arrow** in the macos scheme; the windows scheme is unchanged.
- **A general system for users to override the defaults, like real OSs** —
  per-action rebinding layered over the scheme defaults, persisted, surfaced
  in Control Panel. That system is this document.

---

## OPEN QUESTIONS FOR JKU (answers gate implementation)

1. **All four arrows in the macos scheme?** Meta+Left/Right = line start/end
   is decided. META-ARROW open question 2 remains: also bind **⌘↑/↓ =
   doc start/end** (KA_DOC_START/END already exist and are implemented), so
   all four GUI+arrows leave the snap family in the macos scheme?
   **Recommend yes** — it is the native idiom, the original KEYMAP.md table,
   and it makes the relocation story one sentence ("in macos scheme,
   ⌘+arrows are text nav; tiling is Ctrl+Option+arrows") instead of a
   half-split. Under this design it costs two table rows.
2. **Auto-default the scheme to macOS on Mac hosts?** (META-ARROW open
   question 4.) Today `scheme` defaults to `windows` everywhere and is
   flipped manually in the Keyboard applet. Contained option: `os.html`
   passes a platform hint at boot and a **first-boot seed** writes
   `scheme macos` into `/etc/keys` on Mac hosts (user layer always wins;
   the kernel still never reads key config — the seed is a boot-time file
   write, not a kernel behavior). **Recommend yes** as a follow-up item —
   without it, a Mac user gets line-nav only after visiting Control Panel.
   Say no and the design below is unaffected.
3. **v1 rebinding scope.** The proposal below makes the **entire fixed action
   registry** rebindable — 9 system actions (snap ×4, cycle, start menu,
   sysmenu, overview, show-desktop is NOT included, see §4 note) and ~13
   app-side text/edit actions — one chord per action. NOT in v1: per-app
   custom actions, multi-chord lists, key sequences, mouse-button chords,
   rebinding the readline row bundle (stays the existing on/off toggle).
   Is that the right line? Anything you want pulled in or pushed out?
4. **Rebind capture UX**: the Keyboard applet gains a bindings list +
   "Rebind…" press-the-chord capture (see §6). If a captured chord is
   already bound to another action, the applet prompts to **steal** it
   (rebinding the other action to none) — the Windows/macOS convention.
   OK, or would you rather it refuse and make the user free the chord
   manually first?

Everything else below is proposed as decided-unless-vetoed; the still-open
items above are the only ones that change its shape.

---

## 1. What exists today (grounding — this design extends, not replaces)

gucOS already has THREE binding layers; the gap is that only one of them is
configurable, and none is user-rebindable per action:

1. **Kernel chord blocks** — `kernel.js` `wmKey` (kernel.js:4688+) hardcodes
   five subscriber-gated intercepts: Ctrl/Alt+Tab → EV_CYCLE (:4698),
   Ctrl+Esc → EV_MENU (:4705), GUI+arrow → EV_SNAP_KEY (:4713), Alt+Space →
   EV_SYSMENU (:4723) (plus the overview trigger about to join them). Each
   is a one-off `if` on scancode+modmask. Scheme-blind, config-blind — which
   is exactly why KEYMAP.md as-built §1 had to cede ⌘+arrow to Snap.
2. **The app-side scheme table** — `os/keys.h` (0149/0150): `KS_TABLE`, a
   static scheme-keyed row table (`KS_WINDOWS`/`KS_MACOS` × context mask ×
   chord × `KA_*` action), resolved by `key_action()` in every consumer
   (user32 EDIT/LISTBOX/accelerators, term, wm.c). Config = the cfgstore
   three-layer overlay `~/.config/keys` > `/etc/keys` > `/usr/share/keys`
   (`cfgstore.h`, arch CS3) with the 1 Hz cached revalidate (`ks_cached`,
   keys.h:175) — a Control Panel write reaches every running app within ~1s
   with no notification mechanism. Configurable today: `scheme`, `readline`.
   NOT configurable: any individual chord.
3. **The ctlpanel Keyboard applet** — `os/win32/ctlpanel.c:387-455`: scheme
   radios + the readline checkbox, `ks_set` delta-writes to the user layer,
   the `kb_sync` revert-on-store-failure discipline.

The design principle is to grow each layer along its own grain: the kernel's
five `if`s become ONE data-driven grab table (mechanism); `keys.h` grows an
action registry + override resolution over the SAME config store (policy);
the applet grows a bindings list under its existing radios (UX). No new
config mechanism, no new propagation mechanism, no new store.

## 2. The model: actions, defaults, overrides

**Every rebindable behavior is a named ACTION in one fixed registry**
(`KS_ACTIONS`, a new table in keys.h — names are stable public API, like
config keys). Two kinds:

- **System actions** — global chords the kernel intercepts before any app
  sees them: `wm.snap-left/right/up/down`, `wm.cycle`, `wm.start-menu`,
  `wm.sysmenu`, `wm.overview`. Routed through the shared kernel grab table
  (§3); policy (which chord → which action) lives in wm.c.
- **App actions** — per-focused-app verbs resolved process-side by
  `key_action()`: `edit.select-all`, `edit.copy`, `edit.cut`, `edit.paste`,
  `edit.undo`, `edit.word-left/right`, `edit.line-start/end`,
  `edit.doc-start/end`, `term.copy`, `term.paste`. (The KA_* enum already
  distinguishes these; `term.copy` vs `edit.copy` are separate actions
  because their default chords already differ per context in KS_TABLE.)

**Defaults come from the scheme** — exactly today's two tables, plus the
newly decided rows:

| Action | windows default | macos default |
|---|---|---|
| wm.snap-left/right/up/down | Win+←/→/↑/↓ (today) | **Ctrl+Alt+←/→/↑/↓** (relocated) |
| wm.cycle | Ctrl+Alt+Tab (Alt+Tab where delivered) | same |
| wm.start-menu | Ctrl+Esc | same |
| wm.sysmenu | Alt+Space | same |
| **wm.overview** | **F3** | **F3** |
| edit.line-start/end | — (Home/End native) | **⌘←/→** (new) |
| edit.doc-start/end | Ctrl+Home/End | **⌘↑/↓** (pending Q1; today ^A/^E+Home/End only) |
| edit verbs, word-nav, term copy/paste | today's KS_TABLE rows | today's KS_TABLE rows |

**User overrides layer on top via the existing `keys` store** — new config
keys, one per overridden action:

```
# ~/.config/keys (written by ks_set / the applet; hand-editable)
scheme                  macos
bind.wm.overview        ctrl+alt+e
bind.edit.copy          f5
bind.wm.snap-left       none
```

- `bind.<action> <chord>` rebinds. `none` unbinds. Removing the line (the
  applet's "Default" button writes the sentinel `default`, which the
  resolver treats as line-absent) restores the scheme default.
- **A rebind MOVES the binding**: the action's default chord(s) stop
  matching when an override exists — that is what "rebind" means on every
  real OS, and it is what frees the old chord for reuse.
- Overrides are **scheme-independent** (they apply on top of whichever
  scheme is active). Rationale: an override means "on MY keyboard this key
  does this"; the user already chose their scheme once, and per-scheme
  override files would double the applet UX for a case nobody has asked
  for. If it is ever wanted, `bind.macos.<action>` is the natural
  backwards-compatible extension — noted, not built.
- One chord per action in v1 (no comma lists). The one deliberate
  exception: `wm.cycle`'s dual default (Ctrl+Alt+Tab and bare Alt+Tab where
  the browser delivers it) is TWO default grab entries for one action;
  overriding `bind.wm.cycle` replaces both with the user's single chord.

**Chord syntax** (case-insensitive, `+`-joined): modifiers `ctrl`, `alt`
(alias `option`), `shift`, `gui` (aliases `cmd`, `win`, `meta`); key = one
printable ASCII char, `f1`–`f12`, `left/right/up/down`, `home/end`,
`pgup/pgdn`, `tab`, `esc`, `space`, `enter`, `backspace`, `delete`, `ins`.
`ks_parse_chord()` / `ks_chord_str()` in keys.h are the ONE parse/format
pair (the applet, wm.c and the resolver all use them; round-trip canonical).
This requires extending the KK_* vocabulary (keys.h:68-73 has only
arrows/Home/End today) — KK_F1..KK_F12, KK_TAB, KK_ESC, KK_SPACE, KK_ENTER,
KK_PGUP, KK_PGDN, KK_BACKSPACE, KK_DELETE, KK_INS — and each consumer's
existing fold (user32 VKs, term keysyms, wm.c SDL keysyms) maps its new
keys to them. A bare F-key with no modifier is a valid chord (F3 is the
proof case); a modifier-only "chord" is invalid and the parser rejects it.

**The Shift rule is preserved** (keys.h:206-207): a chord that doesn't name
Shift still matches with Shift held — selection-extension belongs to the
EDIT context, and `wm.cycle`'s reverse direction rides the reported Shift
bit (§3). A chord that DOES name shift requires it, exactly as today.

## 3. The shared kernel key-grab table (mechanism)

This makes META-ARROW's "shared mechanism opportunity" and
EXPOSE-MISSION-CONTROL's flagged coordination concrete: ONE X11-passive-grab-
shaped table replaces per-feature chord ops, and ALL chord features — Snap
(both chord families), cycle, start menu, sysmenu, overview F3, and anything
future — ride it. No `SNAP_CHORDS`, no overview-specific trigger op, no sixth
hardcoded `if`.

**Mechanism/policy split, restated hard**: the kernel stores a table of
(scancode, modifier-mask, token) rows and routes matches to the WM as
events. It does not know what any token means, never reads `/etc/keys` or
any config (the kernel is per-SYSTEM; the top config layer is per-user —
kernel-side config reads break the layering, META-ARROW sketch step 1's
rejected alternative stays rejected), and never learns the words "scheme",
"macos" or "overview". wm.c computes the table from scheme + overrides and
pushes it; the kernel obeys.

### Kernel state and matching

`_wmGrabs`: an array of `{ scancode, km, token }` — `km` is the canonical
KM_* modifier mask **excluding Shift** (the kernel folds the raw SDL mod
word with the same fold as keys.h `km_from_sdl`, a ~4-line twin kept in
kernel.js; the fold is trivial and its constants are already in both files'
vocabulary).

Match rule, evaluated at the TOP of `wmKey` (before focus routing), only
with a WM subscribed (`_wmSubs.size` — the no-WM rule is unchanged: no
subscriber, no interception, chords pass through to the focused app):

- a key event matches a grab iff `scancode` is equal AND
  `fold(mod) & ~KM_SHIFT == entry.km`. **Exact match on non-Shift
  modifiers** — Ctrl+F3 does NOT match a bare-F3 grab. (Today's blocks use
  looser "family present" tests, which is why plain Alt+Tab and
  Ctrl+Alt+Tab both cycle; under exact match that behavior is expressed as
  two table entries, see the default table below. Exact match is what makes
  user rebinding sane: `bind.wm.overview ctrl+f3` and a default `f3` grab
  must be distinguishable.)
- On a matching **keydown**: emit `WMP_EV_HOTKEY { token, flags, focusSid }`
  — flags bit0 = Shift held, bit1 = key repeat — and swallow the event.
- On a matching **keyup**: swallow silently (apps never see half a chord —
  the existing rule, kernel.js:4697). The existing modifier-released-first
  keyup leak (release Alt before Tab and the app sees a stray Tab-up) is
  shared with today's blocks and stays a recorded niggle, not a regression.
- First matching entry wins; wm.c is responsible for not installing
  duplicate (scancode, km) rows (§4's conflict handling makes duplicates
  unrepresentable from config).

### WMP surface (opcode allocation, joint with the Exposé pass)

This design and EXPOSE-MISSION-CONTROL both wanted 0x35+/0x92+; allocating
jointly here (the Exposé doc's numbers shift by one — flagged there as
"whoever lands second rebases", and this document IS the reconciliation):

- `WMP_GRAB_SET = 0x35` `{ n, n × (scancode, km, token) }` — **replace the
  whole grab table** (idempotent; the OVERVIEW_SET shape). Subscriber-only
  (R_ERR otherwise). `n = 0` explicitly installs an empty table (a WM that
  wants NO chord interception — that is a policy choice the mechanism must
  allow). Cap `n` at 64 (WM_GRAB_MAX; R_ERR beyond — far above the
  registry's size, a runaway backstop).
- `WMP_EV_HOTKEY = 0x92` `{ token, flags, focusSid }` — the one event for
  all grab matches.
- Exposé renumbers to: `WMP_OVERVIEW_SET = 0x36`, `WMP_OVERVIEW_END =
  0x37`, `WMP_OVERVIEW = 0x38`, `WMP_EV_OVERVIEW = 0x93`,
  `WMP_EV_OVERVIEW_PICK = 0x94`. Its EV_OVERVIEW survives as the
  command-side gesture event (taskbar button in a future non-wm.c client,
  `wmctl overview`) — but its KEYBOARD trigger is now just a wm.c grab
  entry `{F3, 0, TOK_OVERVIEW}` whose EV_HOTKEY lands in the same wm.c
  toggle handler. The kernel never learns that F3 means overview.

### Back-compat: the default grab table and the legacy events

When a WM subscribes and has not (yet, or ever) sent GRAB_SET, the kernel
uses a built-in **default table** that reproduces today's five blocks
verbatim — entries carrying RESERVED tokens (high bit set) that emit the
LEGACY events with their existing payloads instead of EV_HOTKEY:

| default entry | legacy emission |
|---|---|
| Tab + alt; Tab + ctrl+alt | EV_CYCLE { shift ? -1 : 1 } (0x88) |
| Esc + ctrl | EV_MENU (0x8A) |
| arrows + gui (4 rows) | EV_SNAP_KEY { direction } (0x8F) |
| Space + alt | EV_SYSMENU { focusSid } (0x91) |

Rationale: every existing scripted-WM test and any minimal WMP client keeps
working unchanged; `wm.c` opting in via GRAB_SET is what upgrades it to the
token world. Last-subscriber-gone resets `_wmGrabs` to the default table
(the 0069 map-everything-pending shape: a dead WM must not leave stale
grabs eating keys for the next subscriber). The five hardcoded `if` blocks
in `wmKey` are DELETED — the default table is their one replacement, so
there is exactly one interception mechanism, not two.

The legacy COMMANDS are untouched and chord-independent: `wmctl
cycle/menu/snap/sysmenu` (wmctl.c:586+) and the future `wmctl overview`
send their commands, which fire the legacy events directly. **wmctl verbs
invoke actions, they do not simulate chords** — so rebinding never breaks a
single test, and tests for rebinding itself inject real key events
(INJECT_SCREEN-style raw `wmctl keydown`, which enters `wmKey`).

### What rides it at launch

- **Snap, both families**: windows scheme installs the four GUI+arrow rows;
  macos scheme installs the four Ctrl+Alt+arrow rows and simply does not
  install GUI+arrow rows — which is the entire "release ⌘+arrow to apps"
  mechanism. No release op, no special case: an uninstalled chord passes
  through to the focused app (where the new macos KS_TABLE rows turn it
  into line/doc nav). META-ARROW sketch step 1 is subsumed.
- **Overview F3** (both schemes) — the Exposé trigger, decided.
- **cycle / start-menu / sysmenu** at their current chords.
- Every one of the above overridable per §2.

## 4. wm.c policy: computing and pushing the table

wm.c already includes keys.h (wm.c:169) and already polls config at 1 Hz
(`saver_poll`, wm.c:1224). One new poll-cadence step:

1. Read the effective config (`ks_cached` — scheme + parsed `bind.*`
   overrides, §5).
2. Build the desired grab table: for each SYSTEM action in `KS_ACTIONS`,
   take the override chord if present (skip if `none`), else the active
   scheme's default chord(s); translate canonical chord → (SDL scancode,
   km) via the keys.h fold (`ks_chord_scancode` — a small static map,
   keys.h stays SDL-header-free per its own rule, the scancode constants
   are plain ints).
3. If the built table differs from the last-sent one, `WMP_GRAB_SET`.
   Steady state sends nothing; a Control Panel Apply lands kernel-side
   within ~1s — the same propagation story as every other key.
4. Dispatch `EV_HOTKEY` by token to the existing handlers: snap tokens →
   `snap_key()` (wm.c:1065 — chord-agnostic already, unchanged), cycle
   token → the EV_CYCLE handler with direction from the Shift flag,
   start-menu → `menu_toggle`, sysmenu → the EV_SYSMENU path (focusSid is
   in the event), overview → the Exposé toggle. wm.c keeps handling the
   legacy events too (they still arrive from wmctl commands and from the
   default table during the pre-GRAB_SET window at startup).

Note on **Show Desktop**: the taskbar sliver (0101) has no keyboard chord
today and gains none here; if one is ever wanted it is a one-line
`wm.show-desktop` registry addition — the registry is the extension point,
which is the test that this design is general.

## 5. App-action override resolution (keys.h)

`ks_cfg` grows a parsed override set, populated in `ks_get` from the same
`cfg_load3` text (no second store read): for each registry action, look up
`bind.<name>` via `cfg_find` — the cfgstore per-key overlay means a user
override, an admin `/etc/keys` binding, or even a rebound BAKED default all
compose exactly like `scheme` does today, for free. Parse each with
`ks_parse_chord` (a malformed value is ignored LOUDLY — one stderr line,
action falls back to default; never a silent drop, the cfgstore error
discipline). Cached by `ks_cached`'s existing 1 Hz revalidate — per-keypress
cost stays a clock read.

`key_action(ctx, mods, key)` resolution order becomes:

1. **Override rows first**: for each overridden APP action whose registry
   ctx-mask intersects `ctx`, match the user chord (same Shift rule). Hit →
   return the action's KA_*.
2. **Default rows, minus overridden actions**: scan KS_TABLE as today but
   skip any row whose action has an override or `none` (the rebind-MOVES
   rule) — with the carve-out that **readline rows (`rl == 1`) are never
   suppressed or overridden**: they are an idiom bundle governed by the
   existing `readline on|off` key, not individual registry bindings (so
   `bind.edit.line-start f5` moves the ⌘←/Home-row binding but ^A keeps
   working while readline is on — matching how macOS itself layers emacs
   keys under rebindable shortcuts).
3. `KA_NONE` → the caller's native handling proceeds, unchanged.

The registry gives each app action its ctx mask (from today's rows) and
per-scheme default chord refs. An action with NO default chord in the
active scheme (e.g. `edit.line-start` in the windows scheme, where Home is
native handling, not a table row) is still bindable — the override system
doubles as a "bind an unbound action" system at zero extra cost.

## 6. Control Panel UX (extend the Keyboard applet, keep the radios)

`os/win32/ctlpanel.c` Keyboard applet (`keyboard_proc`, :405): the existing
Scheme groupbox (radios + readline checkbox) stays at the top, untouched —
scheme choice and rebinding are complementary, not competing. Below it, a
new **Shortcuts** groupbox:

- A LISTBOX (existing control) of all registry actions:
  `Snap window left        Win+Left` /
  `Window overview         F3  (custom: Ctrl+Alt+E)` — one row per action,
  display chord from `ks_chord_str`, `(custom)`/`(off)` tags for
  overridden/`none` rows. Rows re-sync on scheme change (defaults column
  follows the scheme).
- Buttons right of the list: **Rebind…**, **Disable** (writes `none`),
  **Default** (restores scheme default). All writes are `ks_set("bind.…")`
  delta-writes with the `kb_sync`-style revert + `store_fail` on error —
  and propagation is automatic: apps re-read within ~1s, wm.c re-sends
  GRAB_SET within ~1s. No Apply button, matching the applet's existing
  click-applies behavior.
- **Rebind…** opens a small capture modal (the fileman rename-dialog
  pattern — own WndProc, modal over the applet): "Press the new shortcut —
  Esc cancels". The next non-modifier keydown + held modifiers is the
  candidate chord (`ks_chord_str` canonicalizes; modifier-only presses keep
  waiting; **the capture window must see raw keys, so wm.c's grabs are the
  one hazard** — the modal writes nothing while open, and capturing a chord
  that is currently grabbed requires the kernel to deliver it: simplest
  correct v1 is that the applet asks wm.c for a grab pause via… nothing —
  instead the modal instructs "shortcuts in use by the system are entered
  as text" fallback? No: cleaner and still small — while ANY capture modal
  is open the applet writes a transient `bind._capture on` user key that
  wm.c's 1 Hz poll answers by pushing an EMPTY grab table, restoring it
  when the key clears/on close. Flagged in the queue item as the one fiddly
  interaction; the transient-key mechanism reuses the store rather than
  inventing an IPC path, and a crashed applet self-heals at the next modal
  open/close or `Default`.)
- **Conflict handling on capture** (the steal flow, pending Q4): if the
  candidate chord equals another action's effective chord (checked across
  BOTH kinds — system grabs and app actions, using the same registry), the
  applet prompts `Already used by "Snap window left" — reassign?` Yes =
  write `bind.wm.snap-left none` + the new binding (two delta writes);
  No = keep capturing.

## 7. Conflict rules (in-gucOS; host overlap is explicitly fine)

Host-OS overlap is accepted per jku's directive — F3 is the precedent (the
VT2 canvas keydown handler already `preventDefault()`s everything it
forwards, os.html:630-638, so the browser's F3-find never fires; what the
host OS eats before the browser — macOS Mission Control on hardware-F3,
Cmd+Tab, etc. — simply never arrives, and the on-screen button / wmctl verb
are the designed alternates. KEYMAP.md's ⌘-passthrough spike list remains
the record of what really arrives; F3 on a Mac with standard-function-keys
off requires the fn key, which is precisely why the overview trigger is
button + key, co-equal).

In-gucOS conflicts have one deterministic total order:

1. **Kernel grabs beat app actions** — structural (interception precedes
   delivery), same as every real OS's global-hotkey tier. The applet's
   steal flow (§6) is what keeps this from surprising users.
2. **User overrides beat scheme defaults** — a user chord suppresses any
   default row it collides with, in both tiers (in wm.c's table build, an
   override chord that equals a still-default action's chord drops that
   default entry for as long as the collision exists; in `key_action`, the
   override scan runs first).
3. **Between two user overrides on one chord** (only reachable by
   hand-editing — the applet's steal flow never writes this state):
   **registry order wins**, the loser is effectively unbound, and both the
   resolver (one stderr line) and the applet (both rows tagged
   `(conflict)`) say so loudly. Deterministic, documented, no silent
   coin-flip.

## 8. Scope: v1 vs later

**v1 (one queue item after the grab-table item):** the fixed ~22-action
registry, one chord per action, `bind.*` config keys, the kernel grab table
+ default-table back-compat, wm.c table push + EV_HOTKEY dispatch, the new
macos-scheme default rows (⌘←/→ line nav; ⌘↑/↓ doc nav pending Q1;
Ctrl+Alt+arrow tiling), F3+button overview trigger riding the grab table,
the extended Keyboard applet, KK_* vocabulary extension, chord parse/format.
Tight, but genuinely general: every present AND future global chord and
every KS_TABLE verb goes through the same registry — no one-off ops remain.

**Later (recorded, not built):**
- **Per-app custom actions** — apps registering their own rebindable
  actions (`bind.app.<name>.<action>` is the reserved namespace). Needs an
  app-facing registration surface; no current in-tree consumer defines
  custom chords outside KS_TABLE, and the namespace reservation means v1
  files stay forward-compatible. (This is a scope line, not a demo
  shortcut: the v1 registry already covers every binding that exists in
  the OS today.)
- Multi-chord lists per action; Emacs-style key sequences; mouse-button
  chords in grabs; per-scheme override files (`bind.macos.*`).
- Q2's platform auto-default seed (small, separable).

## 9. Testing

- `tests/kernel/test_wm.js` mechanism legs: GRAB_SET round-trip + replace
  semantics, exact-modifier matching (Ctrl+F3 misses a bare-F3 grab),
  Shift/repeat flags in EV_HOTKEY, keyup swallow, default-table fallback =
  today's five chords with legacy events (existing legs keep passing
  unmodified — that IS the back-compat test), subscriber-gone reset,
  non-subscriber GRAB_SET → R_ERR, n=0 empty table, WM_GRAB_MAX cap.
- `tests/kernel/test_keymap_e2e.js` (exists, 0149): extend with override
  legs — `bind.edit.copy` rebind moves the chord (old chord dead, new
  live), `none` unbinds, `default` sentinel restores, malformed value falls
  back loudly, readline rows immune to overrides.
- New `test_keybind_e2e.js`: real wm.c — scheme flip windows↔macos
  re-targets the grab table within the poll cadence (GUI+arrow snaps in
  windows scheme, passes through and line-navs in macos, Ctrl+Alt+arrow
  snaps in macos), `bind.wm.overview` rebind honored end-to-end, conflict
  steal via two delta writes. Chord injection via `wmctl keydown/keyup`
  (raw path — enters `wmKey`); assertions via `wmctl wait`, no fixed
  sleeps except the annotated 1 Hz-poll settle (a genuine no-marker settle
  — or better, loop the assertion under the wait budget).
- `tests/kernel/test_ctlpanel_e2e.js` (exists): Keyboard-applet legs —
  list sync, Rebind capture writes the canonical chord, steal prompt, the
  capture-pause transient key.
- Browser: an `os-keybind.mjs` leg or an os-shell.mjs extension — one
  end-to-end rebind through the real applet UI. `tests/run.js` RULES
  already map wm.c/kernel.js → kernel+sweep; new files register explicitly
  in the kernel `run.js` list (the 0264 lesson).

## 10. Cost/impact summary

kernel.js: delete 5 chord `if`s, add `_wmGrabs` + one match loop + the
default table + GRAB_SET handling + the km fold twin + subscriber-gone
reset. wm_proto.h: GRAB_SET 0x35, EV_HOTKEY 0x92 (+ the Exposé renumber).
keys.h: KK_* extension, `KS_ACTIONS` registry, chord parse/format/scancode
fold, override-aware `ks_get`/`key_action` (KS_TABLE itself: +2/+4 macos
rows). wm.c: table build/push at poll cadence + EV_HOTKEY dispatch to
existing handlers. ctlpanel.c: the Shortcuts groupbox + capture modal +
steal flow. wmctl.c: nothing for existing verbs (they are already
chord-independent); `keydown/up` already exist for injection. No host.js
change, no on-disk format change, no app-facing SDL change; image version
bump (wm.c/ctlpanel are baked). KEYMAP.md gains the registry as its
"kernel global chords" section (the META-ARROW proposal, landing here) and
its as-built §1 note is superseded per the META-ARROW pass.
