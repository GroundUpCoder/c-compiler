# gucOS test-honesty audit — the HALF-SCOPED leg class

Branch `test-halfscope-audit`, worktree `~/worktree/c-compiler/test-halfscope-audit`,
base `origin/main` @ `db7edb4e`. **Read-only**: no product or test file was
modified; nothing was executed (no sweep, no kernel suite, no Playwright). The
method is reading each `tests/browser/os-*.mjs` leg against the product path it
drives.

Scope: all 40 `tests/browser/os-*.mjs` files, ~685 `check()` call sites.

---

## 0. The question asked of every leg

> Does what the leg ASSERTS actually cover what its LABEL claims — or does it stop
> at a setup / plumbing / precondition half while being labelled as the
> user-visible whole?

### The false alarm, confirmed not-a-finding

`check(<label>, true)` is the dominant form (~341 of 685). It is **not** vacuous
here: the blocking `waitPixel` / `waitOut` / `waitForFunction` immediately above
is the assertion and the `check` is a reporting line. This audit treats that
shape as sound and says nothing further about it. What it *does* do is make the
audit's real question sharper: **when the preceding blocking wait is satisfiable
by something other than the named behaviour, the leg has no assertion at all** —
and there is no second line of defence, because the `check` itself is `true`.

### The mechanism behind most of what follows

The estate already knows about this: `os-recycle.mjs` calls it "the 0089 trap",
`os-ctxmenu.mjs:153` calls it "the 0089 echo trap", and roughly two thirds of the
sweep defends against it with **split needles** (`echo FOO-O''K` → wait for
`FOO-OK`).

The mechanism, confirmed in source: the kernel tty line discipline echoes typed
input via `Tty.prototype._echo` → `this._output(...)` (`kernel.js:1637-1639`),
and `_output` is the same callback that appends to `window.__osOut`
(`os/os.html:1142`). Echo is enabled by default (`T_ECHO` in the default `lflag`,
`kernel.js:1595`) and is produced by the **line discipline, not by the reading
process** — so it lands in `__osOut` whether or not hush is alive, and it lands
at *type* time, before the command runs.

Consequence: **any `waitOut(N)` whose needle `N` appears literally in a command
line typed before it is satisfied by the echo alone.** If that needle sits behind
an `&&` guard, the guard is fully defeated — the wait fires before the guarded
command has even been dispatched.

An order-aware scan of all 40 files found 16 such sites. Nine are genuine
coverage holes (below); the rest are pacing-only (a real assertion follows and
self-heals the lost sync), and are listed separately as flake risk, not as
coverage loss.

### A systemic gap worth recording

`tests/kernel/lib/drive.js:75-94` fails a kernel test loudly on any
`wmctl: wait ... timed out after Nms` in captured output — the todos/0171 rule.
**The browser harness has no such guard** (`grep -rn "timed out" tests/browser/`
returns nothing outside `drive.js`). There are 33 `wmctl wait` invocations across
11 browser files. Every one of them relies entirely on the caller having written
a split-needle marker; where the marker is unsplit (H2, H3, H1 below) a timed-out
wait is completely silent, exactly the failure mode 0171 was written to kill.

---

## 1. Per-file verdict (all 40 files)

`legs` = `check()` call sites. A file is COVERS only if **every** leg covers its
label.

| file | legs | verdict | why |
|---|---|---|---|
| os-aero.mjs | 17 | COVERS | Every leg is an exact composited-pixel assert (ABLEND src-over, shadow falloff, corner SDF, live peek thumbnail); tail uses split `AERO-SHELL-O''K`. |
| os-boots.mjs | 14 | **HALF-SCOPED (1)** | H7 — the boot-race VT leg. All others assert real product output (`ls` tree, `hello, wasm world`, file bytes after `:wq`, `image: reused/v4`, guard DOM state). |
| os-cairo.mjs | 13 | **HALF-SCOPED (1)** | H9 — unsplit `echo CAIRO-SHELL-OK`. The 11 scene-pixel legs mirror `draw_scene` coordinates exactly. |
| os-clipboard.mjs | 9 | COVERS (as labelled) | The known precedent. Each leg's label is narrowly accurate ("reaches the kernel slot", "re-reads the host clipboard"); the over-claim lives in the file header, not in a leg. See §4. |
| os-compositor.mjs | 14 | COVERS | Counter deltas ARE the subject (parks/frames/submits/vsyncNotifies); `flatWindow` + `settle` give both positive and flat-window controls. |
| os-ctxmenu.mjs | 15 | COVERS | Pixel gutter probes for every popup; fs effect via split `FOLDER-O""K`; paste asserted through `GOT-$(wmctl gettext EDIT:0)-END` command substitution — explicitly marker-wrapped against the echo trap. |
| os-deck.mjs | 12 | COVERS | `waitMaxed` uses split `MAX""ED-`; geometry parsed from real `wmctl list` output; live-reload legs assert the held-slide colour *under* the banner (a two-sided witness). |
| os-doom.mjs | 13 | COVERS | Region-hash frames vs a pre-launch baseline; close markers split (`CLOSE-S""ENT-1`); shell-alive uses `echo DOOM-GONE-$?` — `$?` expands, so the echo cannot satisfy it. The correct pattern. |
| os-drop.mjs | 13 | COVERS | md5 byte-identity both sides of a reload; icon cells derived via `deskEntries`/`deskCell`; launcher proven by winbox actually compositing. |
| os-edittab.mjs | 7 | **HALF-SCOPED (1)** | H1 — the headline-repro leg cannot fail. The six tab-gap pixel legs are strong (widest-gap ≥40px plus an all-blank-gap check). |
| os-fileman.mjs | 11 | COVERS | Model file. `shLine` appends a split needle AND throws a named error if it never echoes; every fs effect gated on `test -f` / `test ! -e`. All 16 `wmctl wait`s properly guarded. |
| os-gdi.mjs | 17 | **HALF-SCOPED (1)** | H9 — unsplit `echo GDI-SHELL-OK`. The 15 GDI-primitive pixel legs are exact. |
| os-gpubox.mjs | 11 | **HALF-SCOPED (1)** | H9 — unsplit `echo GPU-SHELL-OK`. Cube/animation/popup/resize legs all poll real pixels with named throw-on-timeout. |
| os-gucman.mjs | 13 | COVERS | Every leg asserts an exit code or a parsed table row; all markers split (`GUC-RC""=$?`). Includes a real negative (`no "Couldn't connect to server"`). |
| os-hires.mjs | 23 | COVERS | Zoom probes, store contents, pane geometry and the ×2 pointer map all asserted; `wmctl wait` markers split (`DPW""IN`, `DPW2-""OK`). |
| os-keybind.mjs | 11 | COVERS | Best negative controls in the estate: "GUI+Left did NOT snap", "Ctrl+Alt+Left no longer snaps" — both prove the *absence* of the grab, not just the presence. |
| os-mgpp.mjs | 10 | **HALF-SCOPED (1)** | H9 — unsplit `echo MGPP-SHELL-OK`. Green-box presence/absence is a genuine two-sided page witness. |
| os-mobile2x.mjs | 11 | COVERS | Zoom/persistence/control-visibility states ARE the subject; desktop-viewport leg is the negative control for the phone default. |
| os-osk.mjs | 43 | COVERS | Every key path verified by effect (file contents via `cat`, `clip -o`, `wmctl list` focus flag), plus explicit negative controls ("menu spot is not menu-face before the chord", "modifier never repeats"). |
| os-overview.mjs | 11 | **HALF-SCOPED (2)** | H6 — the two exit legs rest on an unasserted precondition (that the overview clears a window's own spot). Enter/live-miniature/gpu legs are strong. |
| os-paint.mjs | 8 | **HALF-SCOPED (1)** | H9 — unsplit `echo PAINT-SHELL-OK`. Tool/colour picks gated on product markers (`paint: tool=5`), plus a negative ("outside the rectangle stays white"). |
| os-present.mjs | 9 | **HALF-SCOPED (1)** | H9 — unsplit `echo PRESENT-SHELL-OK`. Slide pixels and window geometry derived from live `wmctl list`. |
| os-quake.mjs | 15 | COVERS | Explicit negatives throughout ("not locked before any gesture", "title drag does not re-offer the lock"); shell-alive uses `$?` expansion. |
| os-recycle.mjs | 9 | COVERS | Two-sided fs asserts (`test ! -f src && test -f store`), glyph flips both ways, all markers split. |
| os-sameboy.mjs | 10 | **HALF-SCOPED (1)** | H9 — unsplit `echo SB-SHELL-OK`. Palette-set membership and freeze/animate probes are exact. |
| os-saver.mjs | 11 | COVERS | Includes a real negative control ("no immediate re-raise — the waking input reset the idle clock"); markers split. |
| os-scale.mjs | 24 | COVERS | Scaled composite, inverse-mapped input, DST column, refusal and unscale all asserted; markers split. |
| os-screen.mjs | 16 | COVERS | Screen dims read from the live probe; re-clamp asserted as exact geometry from `wmctl list`; markers split. |
| os-shell.mjs | 78 | **HALF-SCOPED (2)** | H5 (override-revert leg) + H9 (unsplit `echo SHELL-OK`). The other 76 are strong — `winCount()` is coordinate-free, the map-on-placement burst capture is a genuine negative control. |
| os-snap.mjs | 16 | COVERS | Preview/tile/maximize/restore all pixel-asserted with desktop-side negatives; geometry cross-checked via `wmctl list`; markers split. |
| os-sounds.mjs | 8 | **HALF-SCOPED (1)** | H4 — the muted leg is an absence assertion with no proof the stimulus was delivered. Whole applet sequence is blind-`sleep()` paced (violates the CLAUDE.md no-fixed-sleep rule). |
| os-sweep.mjs | 0 | n/a | The suite runner, not a test — discovery + heavy-lock + prebake only. No legs to audit. |
| os-term.mjs | 15 | **HALF-SCOPED (2)** | H2 + H3 — both menu legs are satisfied by the echo of their own `wmctl wait` command line. The 11 render/typing/resize legs are strong (incl. a real UTF-8 round-trip). |
| os-touch.mjs | 14 | COVERS | `shellRun` builds split markers; drag asserted as an exact delta; two-finger pan asserted by a dark-glyph census going to zero. |
| os-user32.mjs | 18 | **HALF-SCOPED (1)** | H9 — unsplit `echo U32-SHELL-OK`. Everything else rides `ctldemo:` product markers, incl. exact `WM_COMMAND` payloads. |
| os-vt.mjs | 23 | **HALF-SCOPED (1)** | H8 — the boot-streams-on-VT1 leg passes whenever the probe lands after boot. The wm-death legs are properly `&&`-chained with split needles. |
| os-vt1mobile.mjs | 34 | COVERS | Every strip key verified by effect, not probe; md5 upload identity; touch-action table asserts the whole cluster plus its two deliberate exceptions. |
| os-vt2zoom.mjs | 17 | COVERS | The /Z pointer seam proven by a menu opening at the right logical coord, with an explicit "not menu-face before the click" negative. |
| os-winmine.mjs | 9 | **HALF-SCOPED (1)** | H9 — unsplit `echo WINMINE-SHELL-OK`. Cell reveal uses a whole-rect FNV signature (correctly tolerant of a flat blank reveal). |
| os-wm.mjs | 63 | **HALF-SCOPED (1)** | H9 — unsplit `echo WM-SHELL-OK`. The other 62 are exemplary (no-WM chord legs wait for each toggle in turn so two flips can't cancel into a no-op). |

No leg required running to judge — **zero CANNOT-JUDGE-WITHOUT-RUNNING**. Every
verdict above is decidable from the test source plus the product path it drives
(`kernel.js` tty echo, `os/os.html` `__osOut`, `tests/kernel/lib/drive.js`).

---

## 2. Every HALF-SCOPED leg in detail

### H1 — `os-edittab.mjs:158` · the leg that cannot fail

**Label:** `'notepad opens the tab-indented deck (headline repro)'`

**Strongest assertion** (`os-edittab.mjs:154-159`):
```js
await page.keyboard.type('notepad /usr/share/mgp/talks/posix-on-wasm.mgp &\r');
await page.keyboard.type('wmctl wait win "posix-on-wasm.mgp - Notepad" 30000\r');
await waitOut('posix-on-wasm.mgp - Notepad', 40000).catch(() => {});
const nl = await page.evaluate(() => window.__osOut);
check('notepad opens the tab-indented deck (headline repro)',
  /posix-on-wasm\.mgp - Notepad/.test(nl), ...);
```

Three independent defeats stack here. The needle is a literal substring of the
`wmctl wait win "..."` command line typed one statement earlier, so the tty echo
puts it in `__osOut` at type time; the `.catch(() => {})` swallows a timeout
anyway; and the final `check` re-tests the same never-cleared cumulative buffer.
**This check is unconditionally true from the moment line 155 is typed.**

**Not proven:** that notepad launched at all, that it opened this deck, that it
survived rendering tab-indented lines, or that it ever created a window — i.e.
the entire headline repro of todos/0274.

**Would have to assert instead:** a split marker on the guard —
`wmctl wait win "posix-on-wasm.mgp - Notepad" 30000 && echo NP-DE""CK` — waited on
without `.catch`, ideally plus a client pixel (the EDIT well going white at the
notepad window's live `wmctl list` geometry).

---

### H2 — `os-term.mjs:172` · the dropdown that is never observed opening

**Label:** `'bar click opened the engine dropdown (anchored child "#32768")'`

**Strongest assertion** (`os-term.mjs:170-172`):
```js
await page.keyboard.type('wmctl wait win "#32768" && echo MENUOPEN-OK\r');
await page.waitForFunction(() => window.__osOut.includes('MENUOPEN-OK'), ...);
check('bar click opened the engine dropdown (anchored child "#32768")', true);
```

`MENUOPEN-OK` is unsplit and sits in the typed line, so the echo satisfies the
wait before `wmctl wait win` runs — the `&&` guard never gates anything. Because
the browser harness has no `wmctl: wait ... timed out` guard (§0), a 20s timeout
here is entirely silent. Nothing else in the file touches the dropdown.

**Not proven:** that the bar click at `(TX+20, TY+15)` opened anything at all.

**Would have to assert instead:** split the needle (`echo MENUOPEN-O""K`), and/or
sample the popup's row-0 gutter for `COLOR_MENU` the way `os-gpubox.mjs:126` and
`os-sameboy.mjs:118` already do for the identical menucore popup.

---

### H3 — `os-term.mjs:182` · and the dismissal that is never observed either

**Label:** `'Esc dismissed the dropdown'`

**Strongest assertion** (`os-term.mjs:180-182`):
```js
await page.keyboard.type('wmctl wait nowin "#32768" && echo MENUGONE-OK\r');
await page.waitForFunction(() => window.__osOut.includes('MENUGONE-OK'), ...);
check('Esc dismissed the dropdown', true);
```

Same defeat. Worse in one respect: the Esc is delivered as a synthetic
`KeyboardEvent` at the canvas because — per the file's own comment at line 163 —
"page.keyboard focus is unreliable on VT2". So the leg drives a path the author
flagged as fragile, and then cannot observe whether it worked.

**Not proven:** that Esc reached the menu, or that the popup ever closed. Note
that if H2 already failed (no popup), `wmctl wait nowin` succeeds trivially — the
two legs fail *together and silently*.

**Would have to assert instead:** split needle plus the inverse pixel probe
(gutter back to client pixels), mirroring `os-gpubox.mjs:136-142`.

---

### H4 — `os-sounds.mjs:112` · silence with no proof the stimulus fired

**Label:** `'muted: MessageBox raise stays silent'`

**Strongest assertion** (`os-sounds.mjs:108-112`):
```js
const w2 = await wposAt();
await page.keyboard.type('wmctl click About\r');
await sleep(2500);
const w3 = await wposAt();
check('muted: MessageBox raise stays silent', w3 === w2, { w2, w3 });
```

`w3 === w2` — "the mixer's producer cursor did not advance" — is satisfied
identically by *mute working* and by *the About box never opening*. The entire
applet sequence that precedes it (`ctlpanel &`, `wmctl click Sounds`,
`wmctl click "Enable event sounds"`) is paced by bare `sleep(1200)` / `sleep(1500)`
with no marker, which is precisely the fixed-sleep-as-sync-primitive pattern
CLAUDE.md's test-sync discipline prohibits. A dropped click anywhere in that
chain lands this leg in the trivially-true branch.

Partial mitigation, stated fairly: the later `check('unmuted: the Test button
plays', w5 !== w4)` is a positive control showing that *some* `wmctl click` in
this window reached the applet. It does not show that this particular
`wmctl click About` raised a dialog.

**Not proven:** that a MessageBox was actually raised while muted — so not proven
that muting suppresses a beep that would otherwise fire.

**Would have to assert instead:** gate on the dialog existing before sampling —
`wmctl click About && wmctl wait win "About ctldemo" 8000 && echo ABOUT-U""P` —
then assert `w3 === w2` with the box demonstrably open, and dismiss via
`wmctl wait nowin`.

---

### H5 — `os-shell.mjs:329` · cleanup labelled as a behavioural revert

**Label:** `'override removed: back to the baked default'`

**Strongest assertion** (`os-shell.mjs:326-329`):
```js
await page.keyboard.type('rm -rf /etc/menu && echo MENU""-RESET\r', { delay: 40 });
await page.waitForFunction(() => window.__osOut.includes('MENU-RESET'), ...);
await setVt(2);
check('override removed: back to the baked default', true);
```

The needle is correctly split, so the wait genuinely proves `rm -rf /etc/menu`
succeeded. But that is a *filesystem* fact, and the label claims a *Start-menu*
fact. The preceding legs proved that adding `/etc/menu/solo` makes `solo`
searchable and launchable; **nothing proves that removing it makes `solo` stop
appearing.** This is the missing-negative-control shape: the feature's "on"
direction is tested, its "off" direction is asserted by fiat.

**Not proven:** that wm re-read the tree, that the `solo` entry left the search
index, or that the union reverted to the baked `/usr/share/menu` set.

**Would have to assert instead:** re-open the menu, type `solo`, and assert the
top-hit row does **not** go navy (the inverse of the `waitPixel(100, SM_Y+14, NAVY)`
used at line 319) — or `winCount()` unchanged after Enter.

---

### H6 — `os-overview.mjs:152` and `:163` · exits resting on an unasserted precondition

**Labels:** `'Esc dismisses the overview (winbox restored to its spot)'` and
`'Task-View button again EXITS the overview'`

**Strongest assertion** (`os-overview.mjs:150-154`):
```js
await page.keyboard.press('Escape');
await waitSample(WP.x, WP.y, p => near(p, GREEN) || near(p, ORANGE));
check('Esc dismisses the overview (winbox restored to its spot)',
  near(await sample(WP.x, WP.y), GREEN) || near(await sample(WP.x, WP.y), ORANGE), ...);
```

`WP` is winbox's own client point. This discriminates "overview exited" from
"overview still up" **only if entering the overview removes winbox from `WP`**.
The file header claims exactly that — "`wmctl overview` enters (the window's spot
clears, a live miniature appears)" — but no leg asserts it. The ENTER legs assert
only that a miniature appears at the work-area centre `MCX/MCY`. If the overview
regressed to drawing miniatures *without* taking over the screen, every ENTER leg
would still pass and both EXIT legs would pass trivially, while the feature was
visibly broken.

**Not proven:** that the overview is a takeover at all; consequently, that Esc or
the Task-View button exit anything.

**Would have to assert instead:** one added ENTER-side leg — after
`wmctl overview`, assert `WP` is **not** winbox's fill (the same
`waitSample(..., p => !gpuContent(p))` shape already used at line 125 for the
post-close gpubox check). That single assertion makes both existing EXIT legs
discriminating.

---

### H7 — `os-boots.mjs:115` · a race the leg cannot lose

**Label:** `'manual VT choice during boot survives ready (todos/0070)'`

**Strongest assertion** (`os-boots.mjs:112-116`):
```js
await page.evaluate(() => window.__osVtSwitch(1));
await page.waitForFunction(() => window.__osState === 'ready', ...);
check('manual VT choice during boot survives ready (todos/0070)',
  await page.evaluate(() => window.__osVt) === 1);
```

`__osVt === 1` is satisfied by a plain post-`ready` switch. The file documents
this itself at lines 108-110: *"if ready wins the race this degrades to a plain
post-ready switch and the check passes vacuously"*. Reported here because the
**label** does not carry that caveat — a reader auditing coverage of the 0070
during-boot rule sees a green leg that may never have exercised it.

**Not proven (when the race is lost):** that a manual VT choice made *during*
boot beats the ready auto-switch.

**Would have to assert instead:** record `__osState` at the moment of the switch
and skip-or-fail explicitly when it was already `ready` (a reported skip, not a
silent pass), so the leg's green means the same thing every run.

---

### H8 — `os-vt.mjs:38` · same shape, boot-stream flavour

**Label:** `'boot streams on VT1 (log visible during boot)'`

**Strongest assertion** (`os-vt.mjs:36-39`):
```js
const early = await page.evaluate(() => ({ vt: window.__osVt, state: window.__osState }));
check('boot streams on VT1 (log visible during boot)',
  early.state !== 'booting' || early.vt === 1, early);
```

The `early.state !== 'booting'` disjunct makes the leg pass whenever the probe
lands outside the booting window — again self-documented at line 36 ("vacuously
true if ready won") but not reflected in the label.

**Not proven (when the probe is late):** that boot output is visible on VT1 at all.

**Would have to assert instead:** the same explicit skip/fail split as H7, or poll
from `page.goto` so the booting state is sampled deterministically.

---

### H9 — the `shell alive after X` tail, ×12 files

**Labels:** `'shell alive after gdidemo exits'`, `'shell alive after paint exits'`,
`'shell alive after the terminal session'`, `'shell alive after windowed app exits'`,
`'VT1 shell alive after menu driving'`, and 7 more.

**Strongest assertion** (`os-gdi.mjs:89-91`, representative):
```js
await page.keyboard.type('echo GDI-SHELL-OK\r');
await page.waitForFunction(() => window.__osOut.includes('GDI-SHELL-OK'), ...);
check('shell alive after gdidemo exits', true);
```

The needle is unsplit, so the tty echo satisfies it at type time. Because echo is
produced by the kernel line discipline independently of any reader, **this passes
with hush dead.** These are the last legs in their files, so nothing downstream
would catch it either.

Affected sites: `os-cairo.mjs:87`, `os-gdi.mjs:91`, `os-gpubox.mjs:198`,
`os-mgpp.mjs:156`, `os-paint.mjs:119`, `os-present.mjs:112`, `os-sameboy.mjs:188`,
`os-shell.mjs:816`, `os-term.mjs:206`, `os-user32.mjs:198`, `os-winmine.mjs:151`,
`os-wm.mjs:232`.

**Not proven:** that pid 1 survived the windowed child — the one thing the leg
exists to check.

**Would have to assert instead:** what the other half of the estate already does —
split the needle (`echo X-SHELL-O''K`, as in os-aero/os-snap/os-scale/os-saver/
os-recycle/os-touch/os-fileman/os-ctxmenu/os-keybind) or expand a variable
(`echo DOOM-GONE-$?`, as in os-doom/os-quake). The inconsistency is the tell:
this is drift, not design.

---

## 3. Ranked — likelihood the unproven half is actually broken today

1. **H2 + H3 (os-term menu open/dismiss).** Highest. Both drive
   coordinate-sensitive paths the file itself flags as fragile (a raw mouse click
   into a 30px bar strip; an Esc via synthetic `KeyboardEvent` because "page.keyboard
   focus is unreliable on VT2"), the menu bar is recent work (todos/0273c on the
   0259 menucore engine — a component whose z-order/focus behaviour has already
   regressed once, todos/0282), nothing else in the file covers it, and the two
   legs fail *together* so neither backstops the other. If anything in this audit
   is silently red today, it is these.
2. **H6 (os-overview exits).** The unproven precondition — overview clears a
   window's own spot — is a real regression surface: it is exactly the
   compositor-takeover behaviour that map-gating and layer normalization touch.
   Both exit legs go trivially green if it breaks.
3. **H4 (os-sounds muted silence).** The blind-`sleep` chain means a dropped click
   is quite plausible, and the leg's assertion is an absence. Ranked below H6 only
   because the later `Test`-button positive control gives partial evidence that
   clicks reach the applet in that window.
4. **H1 (os-edittab headline repro).** Worst assertion *quality* in the audit
   (literally cannot fail), but the underlying behaviour is partly covered
   elsewhere: the same file's ctldemo tab-gap pixel legs prove the shared EDIT
   control expands tabs. What is unproven is narrower — notepad opening this
   specific deck without crashing.
5. **H5 (os-shell override revert).** `rm -rf` + a coarse wm re-read tick is
   unlikely to be broken, but the missing negative means a stale-index bug in the
   0259 /etc + /usr/share menu union would be invisible here.
6. **H9 (shell-alive tails, ×12).** Least likely broken — a dead pid 1 would
   usually take the rest of the boot with it — but it is 12 legs across 12 files,
   it is pure drift from a pattern the estate already applies elsewhere, and it is
   the cheapest thing on this list to fix.
7. **H7 + H8 (boot-race legs).** Lowest. Both are honestly documented in comments;
   the risk is not a hidden product bug but a coverage claim that silently
   evaporates on fast boots.

---

## 4. On the os-clipboard precedent

Judged against the same rule, `os-clipboard.mjs` has **no half-scoped leg**. Each
label is narrowly accurate about what it asserts: "focus sync read the host
clipboard (`__osClipFromHost`)", "chord-synced text reaches the kernel slot",
"OSK Ctrl+V on the desktop re-reads the host clipboard". The needles are genuine
(`HOST-TO-GUC-79` arrives from `clip -o` output, not from the typed line), and the
loop-guard leg is a real negative control.

The over-claim is in the **file header**, which advertises the bridge "both
directions" and is read as covering the seam end to end, while no leg drives
delivery into a focused app. That is a real gap — it is just located in the
header rather than in a leg label, which is why leg-level auditing alone would
not have surfaced it. Two files here share that shape: `os-overview.mjs` (H6, where
the header claims "the window's spot clears" and no leg asserts it) and this one.

**Recommendation, recorded not applied:** treat the file header as an auditable
claim too. Both gaps are one added assertion each.

---

## 5. Minor findings — sync hygiene, not coverage loss

Recorded for completeness; none of these is a HALF-SCOPED leg.

- **Defeated sync markers (flake risk, self-healing).** Needle echoed at type
  time, but a genuine assertion follows and absorbs the lost sync:
  `os-wm.mjs:403` (`WM-DEAD`, covered by the following `waitPixel(400, BARY, TEAL)`),
  `os-osk.mjs:162` (`/root/r`, covered by `N=2=M`),
  `os-vt1mobile.mjs:101` (`/root/arr`, covered by `N=2=M`).
  Under load these lose their pacing and the real assertion may race.
- **`os-shell.mjs:367`** — `waitForFunction(() => !/\twinbox$/m.test(window.__osOut) || true, ...)`.
  The `|| true` makes the predicate unconditionally true; the wait resolves on the
  first poll and can never fail. Vestigial.
- **`os-overview.mjs:102, 130`** — `sh('gpubox &', '~ #')` waits for a needle that
  has been in the never-cleared `__osOut` since boot, so it returns immediately and
  paces nothing. Harmless only because `winGeom` retries independently.
- **`os-wm.mjs:236`** — `waitForFunction(() => window.__osOut.includes('taskbar'))`
  matches a generic word against a cumulative buffer that is never cleared; it
  cannot distinguish "this `wmctl list` printed taskbar" from "the word appeared
  earlier in the run".
- **`os-sounds.mjs`** — nine bare `sleep()` calls used as sync primitives with no
  annotation, against the CLAUDE.md rule that fixed sleeps must be genuine
  no-marker settles and must carry a comment saying so.

## 6. What the estate already does right

Worth recording so a fix does not invent a new convention: the correct patterns
are all already in-tree.

- `tests/browser/os-fileman.mjs:41-45` — `shLine` appends a split needle **and
  throws a named error** when it never echoes. The single best primitive here.
- `tests/browser/os-touch.mjs:98-104` — `shellRun` builds the split marker
  mechanically from the marker string, so it cannot be forgotten.
- `os-doom.mjs:179`, `os-quake.mjs:191` — `echo X-GONE-$?`: variable expansion
  makes the needle unreachable by echo *and* asserts the exit status.
- `os-keybind.mjs`, `os-quake.mjs`, `os-saver.mjs`, `os-vt2zoom.mjs` — explicit
  negative controls ("did NOT snap", "not locked before any gesture", "no immediate
  re-raise", "not menu-face before the click").
- `tests/kernel/lib/drive.js:75-94` — the `wmctl wait ... timed out` fail-loud
  guard that the browser harness lacks.
