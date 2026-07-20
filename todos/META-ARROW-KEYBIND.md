# META-ARROW-KEYBIND — ⌘+Left/Right: line navigation vs Aero Snap

Design review (no implementation in this pass). Requested 2026-07-20: in Mac
mode, Meta(⌘)+Left/Right should mean go-to-start/end-of-line — the native
macOS text idiom — not window tiling. This doc anchors the current wiring,
answers the Mac-mode feasibility question, and recommends a split.

**This deliberately revisits a recorded decision**: `todos/KEYMAP.md`
"As built" §1 ("Cmd+arrows stay Aero Snap, unchanged, kernel-side") and the
`os/keys.h` header note ("Deliberately NOT in the table … ⌘+arrow rows").
KEYMAP.md's own design table (rows "Line start/end: ⌘←/→" and "Doc start/end:
⌘↑/↓") wanted exactly what is being asked for now — §1 superseded those rows
to protect Aero Snap. The user directive re-opens that trade.

## OPEN QUESTIONS FOR JKU

1. **Mode-dependent or universal?** Recommendation below is MODE-DEPENDENT
   (macos scheme → line nav, windows scheme → tiling unchanged). Confirm, or
   overrule toward universal line-nav everywhere.
2. **All four arrows, or just Left/Right?** The ask names Left/Right
   (KA_LINE_START/END). Native macOS also has ⌘↑/↓ = doc start/end — and
   KA_DOC_START/KA_DOC_END already exist in `os/keys.h` (bound to
   Ctrl+Home/End in the windows table). Consistency says release ALL FOUR
   GUI+arrows in macos scheme and bind ⌘↑/↓ → doc nav (this is literally the
   original KEYMAP.md table). But that also relocates snap-Up (maximize) and
   snap-Down (restore/minimize), not just the halves. Recommend: all four.
3. **Keep tiling reachable in macos scheme on Ctrl+Option+arrow
   (Rectangle-style)?** Recommend yes — it's free in every layer we checked
   (below). Or is losing keyboard tiling in macos scheme acceptable (mouse
   edge-drag snap, title dblclick maximize, and Win+arrow-in-windows-scheme
   all still exist)?
4. **Should the scheme auto-default by host platform?** Today `scheme`
   defaults to `windows` and is flipped manually in the ctlpanel Keyboard
   applet — there is NO platform auto-detection anywhere in gucOS. Without a
   change, a Mac user gets line-nav only after visiting Control Panel. A
   small, contained option: os.html passes a `platform` hint at boot and the
   BAKED default (`/usr/share/keys`) — or a first-boot seed into `/etc/keys`
   — picks `macos` on Mac hosts; user config always wins. Want that
   follow-up, or keep windows-default + manual switch?
5. **Exposé coordination** (sibling design pass): if tiling moves to
   Ctrl+Option+arrow, the Exposé/Mission-Control trigger must NOT take
   Ctrl+Option+Up. Native macOS Mission Control is Ctrl+Up — but bare
   Ctrl+Left/Right/Up/Down are macOS-host Spaces/Mission-Control chords the
   HOST eats before Chrome, so bare Ctrl+arrow is unusable as a gucOS
   trigger on Mac. Exposé should pick something outside both the GUI+arrow
   and Ctrl+Alt+arrow families (see "Coordination" below). Confirm the
   reservation.

## Current binding — where Meta+arrow tiling lives (cited)

The chord never reaches applications; it is intercepted in the kernel's raw
key seam and turned into a WM policy event:

- **Kernel mechanism** — `kernel.js:4709-4718` (`Kernel.prototype.wmKey`):
  arrow scancodes 79–82 with a GUI modifier held (`mod & 0xC00` =
  SDL_KMOD_LGUI|RGUI) and a WM subscribed emit `WMP.EV_SNAP_KEY` (0x8F,
  direction 0 L / 1 R / 2 U / 3 D) and swallow the key (`return 'snap'`).
  No WM subscribed → the chord passes through to the focused app. This is
  one of five hardcoded chord blocks in `wmKey` (cycle `kernel.js:4698`,
  start menu `:4705`, snap `:4713`, sysmenu `:4723`).
- **Wire** — `os/wm_proto.h:162` `WMP_EV_SNAP_KEY = 0x8F`; the same event is
  reachable as the `SNAP` command 0x1D (`wmctl snap left|right|up|down`).
- **WM policy** — `os/wm.c:3726` routes the event to `snap_key()`
  (`os/wm.c:1065-1086`): Left/Right snap the focused window to half-screen
  (pressing toward a held edge wraps across), Up maximizes, Down restores a
  snapped/maximized window or minimizes a floating one. All from todos/0095.
- **Browser layer** — `os/os.html:630-638`: the VT2 canvas keydown handler
  forwards every key and calls `preventDefault()`, which is what suppresses
  Chrome's own ⌘←/→ = history Back/Forward on macOS. That ⌘+arrow reaches
  the kernel at all on macOS Chrome is empirically established — it is how
  Aero Snap works there today (`todos/KEYMAP.md` "⌘ … already reaches the WM
  (Win+arrow Aero Snap uses it)").

Line-start/end as ACTIONS already exist app-side: `os/keys.h` defines
`KA_LINE_START`/`KA_LINE_END` (plus `KA_DOC_START`/`KA_DOC_END`), and the
0150 EDIT caret machinery implements them — currently reachable in macos
scheme only as the readline chords ^A/^E (`os/keys.h:130-131`) and natively
via Home/End. So the destination verbs need zero new machinery; only the
chord routing changes.

## Feasibility: does gucOS have a Mac mode? — YES

This is the pleasant surprise: **the platform-divergence surface already
exists and shipped.** `os/keys.h` (todos/0149+0150, design `todos/KEYMAP.md`)
is ONE system keymap with a first-class `scheme windows|macos` axis:

- Config: `scheme` key in the cfgstore overlay `~/.config/keys` >
  `/etc/keys` > `/usr/share/keys` (`ks_get`, `os/keys.h:158-171`), cached
  with a 1 Hz revalidate (`ks_cached`, `os/keys.h:186-196`).
- UI: the ctlpanel **Keyboard applet** (`os/win32/ctlpanel.c:387+`) already
  has the Windows/macOS radio; Apply reaches every running app within ~1s.
- Dispatch: `key_action()` resolves chords against scheme-keyed table rows
  (`KS_TABLE`, `os/keys.h:106-141`) — rows are literally tagged
  `KS_WINDOWS`/`KS_MACOS`, so scheme-divergent bindings are the table's
  native shape. Consumers: user32 EDIT/LISTBOX + accelerators, term, wm.c
  (which already includes keys.h at `os/wm.c:169`).

So "Mac mode" does NOT have to be introduced, and no navigator.platform
detection is required for the core feature: mode = the existing user-chosen
scheme. **The one genuine gap**: the kernel's chord interception at
`kernel.js:4713` is scheme-blind — it fires before `key_action()` ever runs,
which is exactly why decision KEYMAP.md-§1 had to cede ⌘+arrow. Making the
interception scheme-aware is the whole design problem, and it is small
(next section).

## Recommendation: MODE-DEPENDENT (scheme-keyed), tiling relocated in macos scheme

**Recommended split** — what jku and master lean toward, and the code
agrees:

- `scheme macos` → GUI+Left/Right = KA_LINE_START/END (and, per open
  question 2, GUI+Up/Down = KA_DOC_START/END). Tiling relocates to
  **Ctrl+Option+arrow** (Rectangle's idiom), same `snap_key()` policy.
- `scheme windows` → GUI+arrow = Aero Snap, byte-identical to today.

**Why mode-dependent beats universal line-nav:**

1. **In the windows scheme, GUI+arrow line-nav is the wrong idiom anyway.**
   Windows line nav is Home/End (already works, both schemes); Win+arrow =
   Snap IS the native Windows behavior gucOS deliberately mirrors
   (`todos/KEYMAP.md` "gucOS is deliberately Win95/Win7, so Ctrl-style is
   the default and the native idiom"). Universal ⌘-style line-nav would
   impose a macOS binding inside the Windows keymap — serving nobody who
   chose that scheme, and breaking Win+arrow muscle memory for them. The
   two-keymaps design exists precisely so each scheme can be internally
   coherent.
2. **The divergence surface is already paid for.** The usual cost of
   mode-dependent bindings — a platform-detection mechanism plus a
   discoverability story — is already sunk: the scheme axis, its config
   store, its 1 Hz propagation, and its Control Panel UI all shipped in
   0149. This change adds table rows to an existing table, not a new axis.
3. **Zero risk to the default population.** `scheme` defaults to `windows`;
   mode-dependent means nothing changes for anyone until they opt into
   macos scheme — which is exactly the population that wants ⌘←/→.
4. Discoverability cost is bounded: "keys differ by scheme" is the Keyboard
   applet's whole premise, and KEYMAP.md's table is the one place both
   columns are documented.

**The honest counter-argument for universal** (surfaced, not adopted): on
Windows/Linux HOSTS the host OS itself grabs Super+arrow (Windows Snap /
most DEs) before Chrome ever sees it, so "tiling stays on GUI+arrow in
windows scheme" is partly theoretical off-Mac — the users who really
exercise ⌘/GUI+arrow snap today are largely on Macs, i.e. exactly where it
contradicts muscle memory. That argues the current binding serves fewer
people than it appears to. But universal line-nav would still take working
Win+arrow snap away from windows-scheme users on Mac hardware (the default
config on the most common host) and put a Mac idiom in the Windows keymap
per point 1 — so it loses on coherence even granting the reach argument.
Scheme-keyed is the recommendation.

### Implementation shape (sketch only — for the eventual queue item)

The clean seam respects the mechanism/policy split used everywhere else
(0025/0032/0095 precedent): the kernel keeps the interception MECHANISM,
the WM owns the POLICY of which chords are grabbed.

1. **Kernel: make the chord grab configurable, don't hardcode a sixth
   block.** Preferred: a small WMP op (e.g. `SNAP_CHORDS {mask}` — or, more
   generally, the grab-table below) by which the subscribed WM tells the
   kernel which snap chord family to intercept: GUI+arrow, Ctrl+Alt+arrow,
   or both. Kernel stays scheme-ignorant. Rejected alternative: the kernel
   reading `/usr/share/keys` etc. itself — the kernel is per-SYSTEM and the
   top config layer is per-user `$HOME/.config/keys`; kernel-side config
   reads break both the layering and the mechanism/policy split.
2. **wm.c: push the policy.** wm.c already includes keys.h and already
   1 Hz-polls config (`saver_poll` cadence); on a scheme change it sends the
   chord op: macos → intercept Ctrl+Alt+arrow (mod `0x0C0|0x300`), release
   GUI+arrow; windows → today's GUI+arrow. `snap_key()` itself is
   chord-agnostic and unchanged.
3. **keys.h: add the released rows** to the macos table —
   `{ KS_MACOS, KCTX_EDIT, KM_GUI, 0, KK_LEFT, KA_LINE_START }` and mirror
   for RIGHT (+ UP/DOWN → KA_DOC_START/END per open question 2). The
   existing Shift rule (`os/keys.h:206-207`: extra Shift never blocks a
   match; selection-extension belongs to the EDIT context) gives
   ⇧⌘←/→ select-to-line-start/end for free. Term stays unbound for ⌘+arrow
   (macOS Terminal doesn't line-nav on it; hush has ^A/^E) — an unbound ⌘
   chord drops instead of typing (KEYMAP.md as-built §6).
4. **Non-EDIT focus in macos scheme**: the released chord reaches the app
   and is ignored — matches native macOS (⌘← in a game does nothing).
   No WM subscribed: unchanged (chord already passes through today).
5. **Docs**: update KEYMAP.md as-built §1 and the keys.h header note (both
   currently state the superseded decision), and re-run/extend the
   ⌘-passthrough spike checklist — ⌘←/→ are not on its expected-eaten list
   and demonstrably arrive today (snap works), but the spike's real-Chrome
   run is still the recorded gate for binding ⌘ chords.

Ctrl+Option+arrow was checked for collisions: not grabbed by default macOS
(it's why Rectangle chose it), not eaten by Chrome, clear of gucOS's VT
switch (Ctrl+Alt+F1/F2/1/2 only — `os/os.html:774-783`), and clear of every
kernel chord block and keys.h row. Bare Ctrl+arrow is NOT usable instead:
macOS hosts eat it (Spaces/Mission Control).

## Coordination with the Exposé/Mission-Control design pass

Two shared registries to not collide on:

- **Chord space.** This design claims, in macos scheme: GUI+arrow (line/doc
  nav, app-side) and Ctrl+Alt+arrow (relocated tiling, kernel-intercepted).
  The Exposé trigger must avoid both families — including Ctrl+Alt+Up,
  despite Mission Control's native Ctrl+Up flavor (bare Ctrl+arrow is
  host-eaten on Mac anyway, see above). Suggested direction for that pass:
  a non-arrow chord (e.g. a GUI/Ctrl+Alt + letter or F-key), recorded in a
  shared "kernel global chords" table in KEYMAP.md — this doc proposes
  adding that registry section so future chords (this one, Exposé's, and
  the five existing hardcoded blocks) are allocated from documented space.
- **WMP opcode space.** Next free event opcode after `WMP_EV_SYSMENU` 0x91
  (`os/wm_proto.h:173`) is 0x92; command space is sparse (0x1D SNAP, 0x1E
  GET_IDLE, 0x1F SAVER, 0x22 INJECT_SCREEN, 0x32 THUMB). Both passes will
  want an event and/or command — whoever lands second rebases their number;
  flag in review.
- **Shared mechanism opportunity** (optional, surface for discussion): if
  the kernel grows a general WM key-grab table (WMP `GRAB_KEY
  {scancode, modmask} → event` — the X11 passive-grab shape) instead of a
  snap-specific chord op, BOTH this feature and the Exposé trigger ride it,
  and the five hardcoded chord blocks in `wmKey` become entries. More
  general, aligned with the build-to-the-goal principle; slightly larger
  kernel change. Worth deciding once, jointly, rather than shipping two
  one-off ops.
