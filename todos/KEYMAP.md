# KEYMAP — the system keyboard scheme

Design doc for the Windows ⁄ macOS keyboard schemes. Queue items:
`todos/0149` (the scheme + verb remap) and `todos/0150` (emacs bindings in GUI
text fields). Decided 2026-07-12 (log:
`logs/2026-07-12/queue-hardening-and-keymap.md`); **built 2026-07-18** on
branch `shortcuts-0149` (log `logs/2026-07-18/keymap-scheme-0149.md`) — the
"As built" section below is normative for the shipped behavior. The
⌘-passthrough spike (below) **was run by jku, by hand, on real macOS
Chrome 150 on 2026-08-02** (c-compiler #396). Headline: `navigator.keyboard.lock()`
under fullscreen recovers ⌘W/⌘Q/⌘T/⌘N from the browser; only ⌘Tab/⌘Space/⌘`
are permanently unbindable. The measured section below replaces the old
placeholder and its expectations. The Windows-side equivalents (c-compiler
#406) are recorded further below — 🔴 **every Windows row is ASSUMED, none
measured**; #416 is the probe ticket that converts them.

## 🔴 CLOSED DECISION — Ctrl carries NO edit verbs in the macOS scheme. Do not re-open.

**Status: decided by jku, three times, by email, 2026-07-29. This is a decision
record, not a discussion. Do not re-litigate it in a design pass.**

The macOS scheme is a **swap, not an alias**. ⌘ takes the edit verbs. **Ctrl is
RESERVED** for the readline rows and for future emacs-style bindings, the same
as real macOS. That reservation is the *point* of macOS mode, not an incidental
consequence of it — see "The idea" below, which explains why a freed Ctrl row is
the capability the mode exists to deliver.

**Rejected, on the record:** dual-binding Ctrl+V / Ctrl+C / Ctrl+X in the macos
table of `os/keys.h` so that the Win95 chords keep working alongside ⌘. jku
rejected this proposal three times. In his words: *"the whole point of Mac mode
is to free the ctrl combos for readline and other niceties like real Mac does.
Dual binding kills that."*

**Do not propose it again.** The argument *for* dual-binding is always the same
one — Win95 muscle memory, a low apparent cost, "it only adds, it does not
remove." That argument is **known and rejected**, not a new insight. It is wrong
because the cost is not visible in the macos table: adding Ctrl+V there silently
spends a chord that the readline rows and 0150's emacs bindings need. Anyone who
re-derives it has found the rejected argument, not a gap.

**The tests are policy, not description.** These assertions in
`tests/kernel/test_keymap_e2e.js` encode this decision:

- `macos: ^C is freed (paste delivers the sentinel, not the selection)`
- `macos: Ctrl chords do NOT fire the accels (exactly the two ⌘ copies)`

**If either goes red, the policy has been broken. The test is not stale.** Fix
the code. Do not flip the assertion.

**Why this is written here.** Until 2026-07-29 this decision existed only in the
coordination repo, and nowhere in this one. A design pass that read `KEYMAP.md`,
`META-ARROW-KEYBIND.md` and `KEYBINDING-OVERRIDE-SYSTEM.md` correctly found the
"swap not alias" *design* and found nothing recording that reversing it had
already been refused — so it re-weighed the trade-off and recommended the
reversal, confidently. A design that is documented without its settled decisions
reads as open for re-litigation. That is what this section closes.

## As built — deviations from the original table (5 decisions, all shipped)

1. **Cmd+arrows are line/doc nav in the macOS scheme** (⌘←/→ =
   KA_LINE_START/END, ⌘↑/↓ = KA_DOC_START/END) — restoring the original
   table's rows. This REVERSES the original 0149/0150 "As built" decision that
   ⌘+arrow stays Aero Snap: the kernel snap grab was scheme-blind and had to
   cede ⌘+arrow, so line/doc nav shipped only on ^A/^E (readline) + Home/End.
   The keybinding-override grab table (todos/KEYBINDING-OVERRIDE-SYSTEM.md)
   made the grab scheme-aware, so **META-ARROW-KEYBIND.md** relocated macOS
   tiling to **Ctrl+Alt+arrow** (Rectangle-style) and RELEASED GUI+arrow to the
   focused app, where `os/keys.h`'s macos rows resolve it. The **windows scheme
   is unchanged** — Win+arrow is still Aero Snap. `os/keys.h`
   (KA_LINE_START/END, KA_DOC_START/END rows + the KS_ACTIONS snap defaults) is
   the authoritative binding. Host auto-detect (META-ARROW decision 4) defaults
   the scheme to macos on a Mac host (`os-common.js seedHostKeyScheme`, seeded
   into the admin `/etc/keys`); the per-user ~/.config/keys override always wins.
2. **Redo (⌘⇧Z / Ctrl+Y) is not implemented** — `os/keys.h` binds KA_UNDO
   only. EDIT has a single-level undo buffer since `todos/0135` (the Win95
   plain-EDIT model: one record, and a second EM_UNDO re-applies the edit —
   the undo/undo toggle). Redo stays out on purpose: the plain Win32 EDIT
   control has no EM_REDO (that is a RichEdit feature), no corpus app uses
   RichEdit, and the toggle already gives "undo the undo". The original
   table's Redo cell is aspirational, not shipped.
3. The accelerator swap (`TranslateAcceleratorW`, `os/win32/user32.c`) is
   **global at the one choke point** — FCONTROL means GUI under the macos
   scheme, Ctrl under windows, no per-app exceptions.
4. Readline rows are **GUI-EDIT-only, default ON, macos-scheme-only** (the
   `readline off` key is the escape hatch); they are structurally absent from
   the windows table, not merely unbound.
5. Config is **cached with a 1 Hz revalidate** (`os/keys.h` `ks_cached`, the
   `wm.c saver_poll` precedent) — no new notify/broadcast mechanism; a
   Control Panel Apply reaches running apps within ~1s.
6. term's Cmd+C-types-'c' bug is fixed as a consequence of (3)+(4): GUI is
   never a text modifier in either `user32.c TranslateMessage` or
   `term.c handle_key` — an unbound ⌘ chord drops instead of typing.

## The idea

gucOS is deliberately Win95/Win7, so **Ctrl-style is the default and the native
idiom** — user32 EDIT (`^C/^X/^V/^A`), fileman accelerators, the clipboard all
use Ctrl. The scheme adds an opt-in **macOS mode** that moves the edit *verbs*
to ⌘.

The reason macOS mode is worth having is not aesthetics — it's that in Windows
mode Ctrl is overloaded (it owns select-all/copy/etc.), so a GUI text field
*cannot also* offer emacs line-editing on Ctrl; the chords collide. In macOS
mode ⌘ takes the verbs and **frees the entire Ctrl row** for emacs bindings
(^A/^E/^F/^B/^D/^W/^K…), exactly like Cocoa's NSTextField. So macOS mode is
strictly *more* editing power in GUI controls, not just different keys.

## Two facts that scope the work

1. **The "toolkit" is Win32.** `TOOLKIT.md` was superseded 2026-07-09 — the UI
   toolkit is user32/gdi32. So "the toolkit respects the OS preference"
   concretely means **user32's EDIT control reads the scheme**. One place, not
   a separate toolkit.
2. **Terminal readline already works.** busybox hush ships
   `CONFIG_FEATURE_EDITING=y` (emacs mode), so Ctrl+A/E/W/K/U already edit the
   shell line *in both modes today* — the shell provides them, not the OS. The
   ONLY thing term changes per mode is the copy/paste **chord**. The real new
   capability (0150) is emacs bindings in **GUI** text fields, which don't
   exist today.

## The two keymaps

| Verb | Windows (default) | macOS |
|---|---|---|
| Select all / Copy / Cut / Paste | Ctrl+A / C / X / V | ⌘A / C / X / V |
| Undo / Redo | Ctrl+Z / Ctrl+Y | ⌘Z / ⌘⇧Z |
| Word left / right (GUI) | Ctrl+← / → | ⌥← / → |
| Line start / end (GUI) | Home / End | ⌘← / →, and ^A / ^E |
| Doc start / end (GUI) | Ctrl+Home / End | ⌘↑ / ↓ |
| **Terminal** copy / paste | Ctrl+**Shift**+C / V | ⌘C / V |
| **Emacs line-editing in GUI** (^A ^E ^F ^B ^D ^W ^K ^U ^N ^P) | — (Ctrl = verbs) | ✓ (0150) |

## Architecture

`os/keys.h` — header-only resolver, following the `openwith.h` / `sounds.h`
precedent: first-existing whole-file config
(`~/.config/keys` → `/etc/keys` → `/usr/share/keys`; one line picks the mode),
exposing `key_action(mods, keysym) → KA_*`. Consumers:

- **user32.c** — EDIT keydown + the accelerator layer route the edit verbs
  through `key_action()` instead of hardcoded chords; 0150 adds the emacs KA_*
  actions over the existing `EditState` caret machinery.
- **term.c** — copy/paste chord selection only.
- **ctlpanel** — a Keyboard applet with a Windows/macOS radio, Apply carries
  the effective table forward (Sounds-applet pattern).
- **wm.c** — no global clipboard chords today; keep it that way (the WM only
  owns window chords — Ctrl+Alt+Tab cycle, Win+arrow snap — which are a
  separate axis, unchanged by the scheme).

## The ⌘-passthrough spike — MEASURED 2026-08-02

Run by jku, by hand, on real macOS Chrome 150 (c-compiler #396). Raw data:
`~/git/meta/meta/probes/cmd-passthrough-396/` — `RESULTS-run-A-control.json`
(run A: plain tab, no fullscreen, no lock), `RESULTS-run-B2-complete.json`
(run B: fullscreen + `navigator.keyboard.lock()` with no argument = all keys;
supersedes `RESULTS-run-B.json`, which left 3 chords untested).

**The headline — the answer to "is there really no way to tell the browser the
page wants these keys?": yes, there is a way.** `navigator.keyboard.lock()`
under fullscreen suppresses AppKit's `performKeyEquivalent:` menu dispatch, so
⌘W/⌘Q/⌘T/⌘N reach the page instead of closing the tab / quitting Chrome. That
was previously unknown to this project (and to the old placeholder here, which
listed all four as "must NOT bind").

### The three measured classes (not the two the placeholder expected)

| Class | Chords | Evidence |
|---|---|---|
| **Free today** — arrive in a plain tab; the lock contributes nothing | ⌘A ⌘C ⌘X ⌘V ⌘Z ⌘R ⌘L ⌘F ⌘, ⌘H ⌘M, Esc (tap) | arrived in run A AND run B |
| **Recovered by fullscreen + lock** — the causal result | **⌘W ⌘Q ⌘T ⌘N** | eaten in run A, arrived in run B |
| **Permanently unbindable** — macOS system-shortcut layer, ahead of app dispatch | ⌘Tab ⌘Space ⌘` | eaten in both runs; the lock cannot reach them |

The old "Expected eaten (must NOT bind)" line was wrong about ⌘W ⌘Q ⌘T ⌘N —
all four are recoverable. It was right about ⌘Tab and ⌘Space, and ⌘` joins
that class. (Incidental: ⌘' also passes through under the lock; Ctrl+Tab
arrived ×8 in run B — see limit 4.)

### Limits of the measurement — do not claim more than this

1. **Arrival ≠ exclusivity.** The probe records that the *page received* a
   chord, not that the *browser refrained from acting*. Suppression is
   INFERRED for the cases that matter: the tab never closed (⌘W), Chrome
   never quit (⌘Q), the page never reloaded (⌘R — a reload would have zeroed
   the matrix), and the omnibox never took focus (⌘L). If a chord ever needs a
   hard exclusivity guarantee, that needs its own probe.
2. **Run A varied fullscreen AND the lock together**, so the four flips are
   attributable to the *pair*, not to the lock alone. A ~20 s run A2
   (fullscreen, no lock) would isolate it. Low materiality — gucOS uses both
   together anyway.
3. **⌘H / ⌘M were not checked for double-action.** They arrive in a plain
   tab, but nobody confirmed the Chrome window did not *also* hide/minimise.
   Cheap human check; must happen before either is bound.
4. **Ctrl+Tab is UNTESTED without the lock.** It arrived ×8 in run B and was
   never probed in run A, so its unlocked class is unknown. **RULED by jku,
   verbatim: "Just do Ctrl+Tab as though it works. If it doesn't I'll file a
   bug later."** Status: bindable, unlocked class UNMEASURED, shipped by
   explicit ruling. Accepted risk, not an oversight — the failure mode is
   benign (Chrome switches tab, the user switches back). Do not gate on
   measuring it; do not re-raise it.
5. **Nothing on the Windows side has been measured.** Chrome's Keyboard Lock
   reportedly captures Alt+Tab (and never Ctrl+Alt+Del) on Windows, which
   would make the unbindable set platform-specific — but that is ASSUMED from
   documentation, not measured. Every Windows claim in this file is ASSUMED
   until someone runs the probe on a Windows host. The Windows-side section
   below (#406) carries that marking row-by-row; ticket **#416** is the probe
   that converts it.

### Caveats any binding work inherits

- **Esc:** a *tap* reaches the page; a *hold* still exits fullscreen
  (Chrome's hold-to-exit affordance). Any gucOS app wanting Esc (vi, dialogs)
  inherits that.
- **⌘W and ⌘Q degrade DESTRUCTIVELY when the lock is unavailable:** unlocked,
  ⌘W closes the tab and ⌘Q quits Chrome — the whole gucOS session dies with
  unsaved state, when the user meant "close this window". ⌘T/⌘N degrade
  harmlessly (a stray tab). The binding ticket needs a `beforeunload` guard
  so the destructive pair fails safe.

### jku's design calls (decided 2026-08-02 — record, don't re-litigate)

- **No "bindable free" vs "bindable only under lock" split in the keymap.**
  Bind uniformly, attempt fullscreen+lock opportunistically, accept
  degradation when unavailable: *"we can always just attempt and if we don't
  get them we don't get them."* The table stays bindable / not-bindable.
- **⌘Tab is out; Ctrl+Tab rotates gucOS windows** (see limit 4 for its
  measurement status).
- **⌘M → minimise the focused gucOS window** (standard macOS Window-menu
  binding; the WM already has minimise).
- **⌘H is app-hide on macOS (hides ALL windows of an app).** gucOS has no
  per-app hide concept ⇒ skip ⌘H; revisit only if gucOS grows one.
- The **"Ctrl carries NO edit verbs in the macOS scheme" CLOSED DECISION
  above stands untouched** — nothing here re-opens it.

### Still open (blocks nothing)

- Run A2 (fullscreen, no lock — isolates the lock from fullscreen). Human-only.
- The ⌘H/⌘M double-action check (limit 3). Human-only.
- Run C (installed PWA — lock *without* fullscreen; would remove the
  fullscreen tax and the Esc-hold conflict).
- Safari / Firefox baselines (neither ships Keyboard Lock).
- **The Windows probe (#416)** — converts every row of the Windows-side
  section below from 🔴 ASSUMED to MEASURED.

## The Windows-side equivalents — #406. 🔴 EVERY ROW BELOW IS ASSUMED. NOTHING IN THIS SECTION IS MEASURED.

**No probe has run on a Windows host.** Every cell below is derived from the
Keyboard Lock documentation and from Windows convention — the exact shape of
claim the #396 measurement proved wrong on macOS (the old placeholder's "must
NOT bind" line listed four chords the probe recovered). Ticket **#416** (light,
P2) names the run that converts each row to MEASURED: the #396 harness is a
static page and is portable, so a Windows run is cheap — availability of a
box, not effort, is the constraint. **Until that run, nothing in this section
may be treated as fact or built on as fact.**

Standing rule (jku): **match platform behaviour** — each row is the
Windows-native chord for the verb, not the ⌘ table with Ctrl substituted. Note
the in-OS windows *scheme* itself (Ctrl edit verbs, Win+arrow snap,
Ctrl+Alt+Tab cycle, readline rows structurally absent) is settled and is NOT
changed by this section; what this section mirrors is #396's *host-browser
passthrough* question — which chords a gucOS page running in Chrome on a
Windows host can hope to receive.

### Verb equivalents (every row 🔴 ASSUMED)

| Verb (macOS binding) | Windows-native equivalent | Assumed passthrough class | Status |
|---|---|---|---|
| Edit verbs (⌘A/C/X/V/Z) | Ctrl+A / C / X / V / Z — already the windows scheme | free today: Chrome-on-Windows reportedly delivers these to a plain tab and honours `preventDefault` | 🔴 ASSUMED |
| Close window (⌘W) | Ctrl+W (the document/tab-close convention). Alt+F4 is *window*-close — in a browser it closes the whole Chrome window, so it maps to "close all of gucOS", not to one gucOS window | eaten in a plain tab (closes the Chrome tab); reportedly recovered by fullscreen + lock — both chords | 🔴 ASSUMED |
| Quit (⌘Q) | none — Windows has no app-quit chord distinct from close; Alt+F4 on the last window is the convention | n/a | 🔴 ASSUMED (convention claim) |
| Minimise (⌘M) | Win+Down (the Aero convention; the windows scheme's Win+arrow snap already owns the Win+arrow row) | Win-key chords are OS-eaten in a plain tab (Start menu / OS actions); the lock reportedly captures the Win key under fullscreen | 🔴 ASSUMED |
| Rotate windows (Ctrl+Tab on macOS) | Ctrl+Alt+Tab — already shipped (the 0032 cycle chord). Alt+Tab is the native verb, but it is NOT being bound on documentation alone — see the conservative calls below | Alt+Tab: OS-eaten in a plain tab; reportedly captured by fullscreen + lock (unlike ⌘Tab on macOS — the platform-specific difference) | 🔴 ASSUMED |
| App-hide (⌘H — skipped on macOS) | none — Windows has no app-hide concept; Win+D show-desktop is already covered in-OS by the taskbar's Show Desktop sliver | n/a | 🔴 ASSUMED (convention claim) |

### The assumed classes (the mirror of #396's three measured macOS classes — every cell 🔴 ASSUMED)

| Class | Chords | Source |
|---|---|---|
| Assumed free today | Ctrl+A ⁄C ⁄X ⁄V ⁄Z ⁄Y, Ctrl+F ⁄L ⁄R, Esc (tap) | documentation + convention — NOT a probe |
| Assumed recovered by fullscreen + lock | Ctrl+W, Ctrl+T, Ctrl+N, Alt+F4, **Alt+Tab**, Win-key chords | Keyboard Lock documentation — NOT a probe |
| Assumed permanently unbindable | Ctrl+Alt+Del (the Secure Attention Sequence), Win+L | reportedly reserved by Windows below the app layer — NOT a probe |

If the reported Alt+Tab capture is real, the unbindable set is genuinely
platform-specific — macOS keeps ⌘Tab/⌘Space/⌘` forever while Windows loses
only the SAS-class rows. **That is the first claim #416's probe must check.**

### Conservative calls — what this section does and does not license

- **Nothing new is bound on the Windows side by this section.** The windows
  scheme already carries the Windows-native chord for every verb above that
  has one (the Ctrl edit row, Win+arrow, Ctrl+Alt+Tab). The only candidate
  upgrade — real Alt+Tab rotation under fullscreen + lock — is explicitly
  deferred until #416 measures it. Do not bind Alt+Tab on the strength of
  this table.
- **Ctrl+W-as-close inherits the destructive-degradation caveat verbatim:**
  unlocked, Ctrl+W closes the Chrome tab and the whole gucOS session with it
  — the same `beforeunload` guard requirement as ⌘W/⌘Q applies. Alt+F4
  degrades worse (the whole Chrome window).
- **Esc:** the hold-to-exit-fullscreen affordance is reportedly the same on
  Windows; a tap-vs-hold split as on macOS is ASSUMED, not measured.
- The macOS side of this file is untouched by this section: ⌘ carries the
  verbs, Ctrl stays reserved for readline (the CLOSED DECISION above), and
  Ctrl+Tab's shipped-unmeasured status (limit 4) is settled — none of that
  is re-opened here.

## Out of scope / separate axes

- Menu mnemonics (Alt+F) and dialog default buttons — a different concern;
  unchanged.
- A kill-ring (^K/^Y yank) in GUI EDIT — a follow-up to 0150, not v1.
