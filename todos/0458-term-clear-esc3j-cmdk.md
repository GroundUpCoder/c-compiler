# 0458 — term: clear command + ESC[3J + Cmd+K clear (macOS Terminal.app parity)

- **Status**: open
- **Difficulty**: medium — *implementation* is small (~half a lane-day), but the acceptance legs
  live in `tests/kernel/`, so **this is a HEAVY-class lane for scheduling** (see "Suites" below).
- **Design**: this file. Source: jku ask, 2026-07-30, routed via the meta-meta router thread
  and filed by master cont-221.
- **Provenance**: jku, 2026-07-30: *"xterm lacks scroll back and scroll bar. Is there a
  fundamental reason? Could we also add the `clear` command … and cmd+k in macOS mode for
  clearing the terminal just like on a Mac? If it's easy to add, just queue the work for master
  to do."*

## Scrollback is NOT in scope — it already shipped

🔴 **jku's "no scrollback / no scrollbar" premise is stale.** Scrollback and the overlay
scrollbar shipped in **`0273` (term macOS parity, done 2026-07-23)**: `os/term/term.c` has the
history ring, wheel, PageUp/PageDown, the overlay scrollbar, the View menu and the settings — and
that code is in the currently deployed image. jku has been told this by email. **Do not re-implement
scrollback and do not "fix" a scrollbar that works.** If it appears absent in a browser, that is a
stale client image, not a code gap.

What is genuinely missing is only the **clearing** half, in three parts.

## Verified starting state (re-verified against `main` by master cont-221 — paths corrected)

⚠️ **The routed decomposition cited `os/win32/term.c`. That file does not exist.** The terminal is
**`os/term/term.c`**. Line numbers below were re-derived on `7a1496c0`; re-derive them again at
spawn ((EN)) — a measured map is valid only against the tip it was measured on.

- **No `clear` command exists.** `# CONFIG_CLEAR is not set` (`vendor/busybox/busybox.config:372`),
  no `clear` entry in `os/image.json`, no `os/clear.c`. Positive controls: `os/pbcopy.c` exists and
  `pbcopy` has 2 `image.json` hits — so the instrument does find applets that are present.
  There is no terminfo/ncurses in the image, so a `clear` binary **must emit hardcoded sequences**.
- **Interactive clearing partially exists**: busybox lineedit Ctrl+L at the hush prompt
  (`vendor/busybox/src/libbb/lineedit.c`), and **View ▸ Clear Scrollback** (`CM_CLEARSB`,
  `os/term/term.c:1038` menu item, `:1083` handler) — which clears **history only**.
- **`ESC[3J` is not handled.** `csi_dispatch` `case 'J':` at **`os/term/term.c:609`** branches
  `m==0` / `m==1` / **else**. `m==3` therefore falls into the `else` and runs
  `clear_cells(grid, 0, rows*cols)` — it clears the grid and **never touches the ring**.
- **`hist_clear()` already exists** (`os/term/term.c:326`) and resets `hist_count`, `hist_head` and
  `view_off`. Part 2 is genuinely a one-liner.
- **The Cmd+K seam is ready.** `os/keys.h:149,151` already bind `KM_GUI` `c`/`v` for
  `KCTX_TERM` in the `KS_MACOS` rows; `os/term/term.c` `handle_key` dispatches
  `key_action(KCTX_TERM, …)` and **drops unbound GUI chords**, so an unbound ⌘K is inert today.
- 🔴 **The mac scheme is NOT the default.** `os/keys.h` `ks_get()` sets `c->scheme = KS_WINDOWS`
  and only switches to `KS_MACOS` when the config says `scheme=macos`. ⇒ **A mac-only bind is
  invisible to every default-config user.** Ship the windows-scheme twin in the same change.

## Plan

### 1. `clear` — new `os/clear.c`
~20 lines: `write(1, "\x1b[H\x1b[2J", 7)`. Add the `image.json` entry next to `pbcopy` and bump the
image version. `/bin/clear` comes free via the `/bin` → `/usr/bin` symlink.
**Semantics: visible screen only, scrollback KEPT** — that is xterm/Terminal.app behaviour (`ED 2`
does not push cleared lines into history). This is deliberate; match it, do not "improve" it.

### 2. `ESC[3J` — `os/term/term.c` `csi_dispatch` `case 'J'`
Add `if (m == 3) { hist_clear(); break; }` **before** the existing `else`. Clears saved lines only
and leaves the visible screen untouched, per xterm. Gives scripts an explicit scrollback wipe.

### 3. `Cmd+K` — clear screen AND scrollback, snap to live
- **`os/keys.h`**: add `KA_TERM_CLEAR` to the actions enum; add the `KS_TABLE` row
  `{ KS_MACOS, KCTX_TERM, KM_GUI, 0, 'k', KA_TERM_CLEAR }` **and the windows twin**
  `{ KS_WINDOWS, KCTX_TERM, KM_CTRL|KM_SHIFT, 0, 'k', KA_TERM_CLEAR }` — matching the existing
  Ctrl+Shift+C/V idiom at `:142-143`, and required because the mac scheme is not the default.
  Append `KSA_TERM_CLEAR` **after** `KSA_TERM_PASTE` (`:226`, immediately before `KSA_COUNT`) —
  🔴 **`KSA_*` ids are stable public API: APPEND ONLY, never insert or renumber.** Add the registry
  row `{ "term.clear", KAK_APP, KCTX_TERM, KA_TERM_CLEAR }` next to `term.copy`/`term.paste`
  (`:280-281`); that buys `bind.term.clear` user overrides for free.
- **`os/term/term.c`** `handle_key`: on `KA_TERM_CLEAR && !on_alt` →
  `clear_cells(grid, 0, rows*cols); hist_clear(); cx = cy = 0; wrap_pending = 0; dirty = 1;`
  **No-op on the alt screen** — the app owns that viewport and alt has no history by construction.
- **Menu parity**: `menucore` supports `'\t'`-split accelerator text. Either add a new
  "Clear Screen and Scrollback\t⌘K" item, or extend `CM_CLEARSB`.
  🔴 **If you extend `CM_CLEARSB`, you MUST relax its gray rule.**
  `os/term/term.c:1100` reads `mi_clear->state = (!on_alt && hist_count > 0) ? 0 : MF_GRAYED;` —
  correct for a history-only verb, **wrong for a screen-clearing verb**, which would be grayed out
  exactly when the user wants to clear a full screen with empty scrollback.

### 4. SPIKE FIRST — does Chrome/macOS deliver ⌘K to the canvas?
`os.html` `preventDefault`s all keydowns and ⌘K is expected to be preventable (unlike
⌘W/⌘T/⌘N/⌘Q), so this should pass — **but confirm empirically before building the bind.**
🔴 **Record the result in `todos/KEYMAP.md` under "The ⌘-passthrough spike (do FIRST)".** That
section is a placeholder that says *"Record the actual findings here"* and **is still unfilled** —
its pass-list is ⌘A/⌘C/⌘X/⌘V/⌘Z and its eaten-list is ⌘W/⌘Q/⌘T/⌘N/⌘Tab/⌘Space, and **⌘K appears in
neither**. So this ticket is the first to actually owe that record. Fill it in.

## Relationship to 0432 — 🔴 SEQUENCE THIS **AFTER** 0432

⚠️ **`0432` does NOT edit `os/keys.h`. It is *fenced against* that file** — its scope fence reads
*"This ticket contains NO keymap change. It never will,"* and *any* touch of the macOS table is an
**automatic fail for 0432's lane**. So this is **not** a shared-choke-file collision, and 0432 does
not "own" `keys.h`; it is forbidden from it. Do not read 0432 as blocking this work.

**But there is a real ordering constraint, and it runs the other way.** `0432`'s kickoff carries a
hard arm: **"`tests/kernel/test_keymap_e2e.js` stays green WITHOUT edits — if that file needs a
change to pass, the change is out of scope; stop and report."** This ticket **necessarily moves that
baseline**: it adds a `KSA_*` id (so the `keybind_registry_probe.c` count assert changes), a new
registry row, and two new scheme rows.

⇒ 🔴 **If 0458 lands first, 0432's "no edits needed" arm becomes untestable** — its lane cannot tell
a genuine regression from this ticket's legitimately-changed baseline, and it is instructed to stop
and report on exactly that signal. **Land `0432` first** (it is already soft-sequenced `after ▸ 0396`),
then this ticket. If scheduling forces the reverse order, **say so explicitly in 0432's kickoff and
restate its arm against the new baseline** — do not let it discover the moved goalposts as a red.

🟢 **And to be unambiguous about the veto**: ⌘K is a **Cmd verb**, which is exactly jku's sanctioned
mac scheme (Cmd carries verbs, Ctrl stays reserved for readline). **This is NOT the Ctrl dual-bind
jku rejected three times.** Do not refuse this ticket on 0432 grounds — and equally, **do not widen
it into a Ctrl+K bind**; the windows-scheme twin is Ctrl+**Shift**+K, matching the existing
Ctrl+Shift+C/V idiom.

## Suites (this decides scheduling — read before spawning)

🔴 **Both acceptance legs are in the kernel suite**: `tests/kernel/test_term_e2e.js` and
`tests/kernel/keybind_registry_probe.c`. ⇒ This lane needs the **~17-minute kernel sweep** and
therefore takes the **host-wide heavy lock** (`tests/lib/heavy-lock.js`). **Do not run it alongside
another heavy lane** — the second exits 3 ("lock held", not a failure), and **never** set
`CC_NO_HEAVY_LOCK=1`. The routed estimate of "SMALL / half a day" is an honest *implementation*
estimate; it is not a scheduling class.

## Acceptance

- `clear` at the hush prompt: screen blank, prompt at top, **prior output still reachable** by
  wheel / PageUp / scrollbar.
- `printf '\x1b[3J'`: history gone (the scrollbar disappears — the existing "hidden with no history"
  assertion in `test_term_e2e.js` is the template), **visible screen untouched**.
- ⌘K in the mac scheme **and** Ctrl+Shift+K in the windows scheme: screen + history wiped, view
  snapped to live; **no-op inside vi/less** (alt screen).
- `keybind_registry_probe.c` count assert updated, plus its chord checks.
- A term e2e leg modelled on the existing session legs.
- 🔴 **Existing goldens stay green** — 0273 kept the no-history scrollbar overlay byte-identical;
  preserve that. A golden rebake is NOT an acceptable way to make this pass.
- `todos/KEYMAP.md` spike findings recorded (see step 4).
- Full gucOS gate green. Standing gucOS auto-ship applies; **bundle** rather than deploying
  per-commit.
