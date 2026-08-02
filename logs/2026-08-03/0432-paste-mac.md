# #96 (todos/0432) — ⌘V paste legibility + robustness in the macOS scheme

The keymap is untouched: todos/KEYMAP.md's CLOSED DECISION (⌘ carries the
edit verbs, Ctrl stays reserved) stands, and `os/keys.h`'s macos table is
byte-identical. Everything here is truth-in-labeling and robustness that
holds under any keymap policy.

## 1. The menu-label lie — fixed at the menucore choke

Under the macos scheme every `.rc` accel string still read `Ctrl+V` while
the FCONTROL⇒GUI accelerator swap (user32.c `TranslateAcceleratorW`) had
deliberately unbound that chord. New `mc_accel_text()` (menucore.c)
rewrites `Ctrl+` → `Cmd+` at the ONE measure/draw choke when
`ks_scheme() == KS_MACOS`, so every front-end's menus (user32 bars/popups,
wm.c furniture) tell the truth corpus-wide with zero per-app work.

**Why `Cmd+` and not the ticket's literal `⌘`:** U+2318 has no glyph in any
baked Noto face (checked the cmap of NotoSans/NotoSansMono/NotoSerif —
U+2318, U+21E7, U+2325 all absent; only the gucman `font-unifont` /
`font-noto-cjk-mono` packages cover it). gdi32 renders a missing code point
as a LOUD tofu box, so a literal ⌘ would trade a lie for a rendering defect
on every base image and make the drawn column install-dependent. "Cmd" is
already the scheme's UI vocabulary (the ctlpanel "macOS (Cmd)" radio). If
jku wants the real glyph, the clean follow-up is baking a symbol-capable
fallback face — a size/scope call, not this ticket's.

The agent tree's menuitem lines now carry ` accel='…'` (the REWRITTEN text,
appended last so existing text/checked/grayed adjacency asserts survive) —
that is what lets a test assert the draw layer once, corpus-wide. One
existing assert anchored `\n` right after `text='Paste'`
(test_calc_e2e.js:227) and was retargeted to `(?! grayed)`.

The ctlpanel Keyboard applet grew a "Shortcuts" groupbox listing the
EFFECTIVE chords (Select All/Copy/Cut/Paste/Undo/Terminal Copy/Terminal
Paste) via keys.h's own resolution — overrides show, and the listing
follows a scheme radio click (kb_sync now also runs on successful writes,
reading fresh so it never waits out the 1 Hz cache).

## 2. Permission-free paste (os.html)

The paste handler's text-only branch used to discard the event's
`text/plain` flavor and leave the paste to the CLIP_GET seam's `readText`
(permission prompt; rejection on Safari). Now the flavor is posted as the
kernel slot BEFORE `pasteArmFlush()` (page→worker FIFO, so the slot lands
before the forwarded chord), gated by the 0398 D6 memos (`clipSynced`
dedup, `clipShadow` file-name guard). A new one-shot `clipEventFresh` memo
(1.5 s TTL) lets that chord's `clip-read` skip its readText — no prompt,
no readText, Chrome and Safari alike. Probe: `window.__osClipEvent`.

## 3. The implicit host-native paste row

Both boot paths now persist the per-boot host verdict at
`/run/host-platform` (`writeHostPlatform` in os-common.js; kernel-worker +
boot.js, EVERY boot — deliberately not the fresh-root `seedHostKeyScheme`
gate: recording a fact is not choosing a scheme). keys.h's `key_action`
gained step 3: on a Mac host (`ks_host_mac()`), GUI+V resolves to
`KA_PASTE` in EDIT|LIST regardless of scheme — checked last, suppressed by
an explicit `edit.paste` override, and GUI-only by construction, so it
never adds a Ctrl binding anywhere (the policy fence). This is what makes
⌘V paste on a stale pre-v138 windows-scheme root volume with no scheme
flip and no `~/.config/keys` write.

## 4. Coverage

- `tests/kernel/test_hostpaste_e2e.js` (registered in tests/kernel/run.js):
  both `/run/host-platform` values, the stale-volume ⌘V paste + no-flip
  asserts, the non-mac ⌘V-drops negative control, the drawn accel field
  under both schemes, the applet listing + live flip.
- `tests/browser/os-paste-mac.mjs` (hostKeys:'mac', the os-undo.mjs rig):
  the browser-path verdict, permission-free paste asserted with
  clipboard-read NEVER granted (the readText path would be denied, so only
  the event flavor can deliver), the D6 no-double-paste memo, the mac-cell
  accel column, and the stale-volume cell.
- `tests/kernel/test_keymap_e2e.js` untouched and green — its ⌘C-drops
  session G is exactly why the implicit row is paste-only.

Image v221 → v222 (keys.h/menucore/user32/ctlpanel are bake inputs).
