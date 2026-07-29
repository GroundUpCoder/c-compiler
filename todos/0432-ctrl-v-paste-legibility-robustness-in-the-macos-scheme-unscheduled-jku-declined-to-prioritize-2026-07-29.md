# 0432 — Ctrl+V paste legibility + robustness in the macOS scheme (UNSCHEDULED — jku declined to prioritize 2026-07-29)

- **Status**: open
- **Design**: read-only design pass, 2026-07-29 (full report in its thread); decision record in `todos/KEYMAP.md` ("CLOSED DECISION")

## 🔴 READ FIRST — SCOPE FENCE

**This ticket contains NO keymap change. It never will.**

jku rejected dual-binding Ctrl+V / Ctrl+C / Ctrl+X in the macos scheme **three
times, by email, 2026-07-29**. ⌘ carries the edit verbs; Ctrl stays reserved for
the readline rows. That decision is recorded in `todos/KEYMAP.md`. **If you are
reading this ticket and reaching for the macos table in `os/keys.h`, stop — you
have found the rejected proposal, not a gap.**

What survives here is **legibility and robustness only**: the OS currently
*lies* to the user about which chord to press, and the paste path is fragile in
cells the tests never run. Both are defects under *any* keymap policy.

**This ticket is explicitly NOT SCHEDULED.** jku declined to prioritize it on
2026-07-29 and re-affirmed the swap policy in the same reply. Do not promote it
into a lane without asking him. It is filed so the findings are not lost, not
because anyone is waiting on it.

## Goal

Stop the macOS-scheme OS from advertising chords it has deliberately unbound,
and make ⌘V paste work in the cells that today's tests never cover.

## Plan

1. **HEADLINE — the menu-label lie.** In the macos scheme the OS's own menus
   advertise `Ctrl+V` (notepad `.rc` accel text, rendered literally by
   `menucore.c:287-290`) while that chord is deliberately unbound. Because the
   FCONTROL⇒GUI accelerator swap is global at one choke point
   (`user32.c:1073-1079`), a **draw-time accel-column rewrite** (`Ctrl+` → `⌘`
   when `scheme == macos`) is truthful corpus-wide — one change, every menu.
   The design pass called this "the part I'd call a bug under any policy."
   Add a static per-scheme chord listing to the ctlpanel Keyboard applet.

2. **Permission-free paste.** `os.html`'s paste handler discards the paste
   event's `text/plain` flavor (`os.html:1017-1020`, kept only as the file-name
   shadow memo). Posting it as a clipboard payload **before** `pasteArmFlush()`
   makes ⌘V paste permission-free on Chrome **and** Safari — no `readText`, no
   prompt. Must respect the 0398 D6 dedup memos (`clipSynced` / `clipShadow`).

3. **Implicit host-native paste chord.** Persist the per-boot host verdict
   (e.g. `/run/host-platform`, written by both boot paths) and treat the
   host-native paste chord as an implicit `EDIT|LIST` `KA_PASTE` row regardless
   of scheme. This is **policy-aligned — on a Mac the host-native chord IS ⌘V**,
   so it adds no Ctrl binding. It makes ⌘V work on stale windows-scheme volumes:
   `seedHostKeyScheme` is fresh-root-volume gated at both call sites
   (`kernel-worker.js:586-602`, `boot.js:283-298`), so a root volume predating
   image v138 never got the macos seed and is still on the windows scheme.
   🔴 **Do NOT extend the seed to every boot** — that would silently flip a
   user's chosen scheme.

4. **Coverage hole.** No browser test passes `hostKeys:'mac'`; `os-clipboard.mjs`
   is windows-scheme only. **This is the hole that let the confusion ship.** Any
   work here must add Mac-cell e2e legs.
   ⚠️ Partly addressed elsewhere: `todos/0135` was asked to carry a
   `hostKeys:'mac'` ⌘Z leg. Check what landed there before rebuilding the rig.

## Acceptance

- In the macos scheme, no menu in the corpus advertises a `Ctrl+` chord that the
  scheme leaves unbound; the accel column reads `⌘`. Asserted at the menucore
  draw layer, not per-app.
- The ctlpanel Keyboard applet lists the effective chords for the active scheme.
- ⌘V pastes text with no permission prompt on a Chrome-class browser, with the
  0398 D6 dedup memos still honoured (no double-paste regression).
- ⌘V pastes on a **windows-scheme** volume (the pre-v138 stale-root case) with
  no scheme flip and no change to the user's `~/.config/keys`.
- At least one browser e2e leg runs with `hostKeys:'mac'`.
- 🔴 `tests/kernel/test_keymap_e2e.js` stays **green without edits** — its
  "^C is freed" and "Ctrl chords do NOT fire the accels" checks are policy
  assertions. If this work turns either red, the work is wrong.
