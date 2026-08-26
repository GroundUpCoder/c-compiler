# #740 — the taskbar contract keys on ownership, not on a class name

**Lane** `lane/740`, branched from `ad8624cf`.
**Report**: "Calculator has no taskbar button and is unrecoverable once covered."

## What the symptom actually was

Reproduced headlessly on `main` before touching anything:

```
$ calc &
$ notepad /root/hello.c &
$ wmctl list
3  4  464x478+12+36  -  1  -------U  Calculator          <-- U = WMP_F_TRANSIENT
5  7  640x480+40+60  -  3  f---R---  hello.c - Notepad
$ wmctl cycle   # x2 — focus never leaves Notepad
```

`U` is `WMP_F_TRANSIENT`. `/bin/wm` keeps such a surface out of `wins[]`
entirely (`os/wm.c:3901`), which is one decision with four consequences: no
taskbar button, and `cycle`/`cascade`/`tile`/`minimize-all` all skip it. With
no taskbar route and no keyboard route, a covered Calculator is reachable only
by clicking a pixel of it that happens to still be visible.

## The general cause — and it is general

`os/win32/user32.c` `create_window_impl` set the flag like this:

```c
int transient = className && ci_eq(className, "#32770");
```

That is a class-name test standing in for an ownership test. `os/wm_proto.h`
states the contract it is implementing — "a framed, focusable modal
(MessageBox, dialogs) that **Win95 never lists in the taskbar**" — and the
Win95 rule it invokes is about **ownership**: an unowned top-level window gets
a taskbar button, an owned one does not. "MessageBox and dialogs" was the
common *case*; the code took it for the *test*.

The two readings diverge in **both** directions, and both directions ship:

| window | class `#32770`? | owned? | old | correct |
|---|---|---|---|---|
| calc's main window (`CreateDialog(..., NULL, DlgMainProc)`) | yes | **no** | not listed | **listed** |
| calc's Statistics box (`CreateDialog(..., hWnd, ...)`) | yes | yes | not listed | not listed |
| sedit's Find / Goto (`CreateWindowEx(..., win, ...)`) | **no** | yes | **listed** | not listed |
| comdlg32 Open / Save / Find / Font | **no** | yes | **listed** | not listed |
| notepad, winmine, fileman, ctlpanel main windows | no | no | listed | listed |

So this was never a calc bug. Calc is simply the app that uses a dialog as its
main window — a common Win32 idiom, and the one shape the heuristic gets
maximally wrong. Every owned common dialog in the tree was getting a spurious
taskbar button at the same time, silently, in the other direction.

## The fix

The real Win32 rule, in `create_window_impl`:

```
WS_EX_APPWINDOW        -> listed, even when owned
else an owner          -> not listed
else WS_EX_TOOLWINDOW  -> not listed
else                   -> listed
```

Three inputs, all three implemented. `WS_EX_TOOLWINDOW`/`WS_EX_APPWINDOW` had
no consumer in the tree — they are implemented anyway, because they are half of
the contract being fixed and shipping two thirds of a rule is how the next
divergence gets built. They are new in `windows.h` and are now READ, so
`style_net` stops reporting them as unimplemented ex-style bits.

### The half that is easy to miss: the producers were discarding the owner

`create_window_impl` only stored `parent` for `WS_CHILD` windows; for a
top-level, the owner argument was dropped on the floor. Worse, three producers
never passed it in the first place, even though they read it two lines later
for the modal enable/disable:

- `MessageBox` passed `NULL` and kept `owner` in a local (`ownerTop`);
- `dlg_create` passed `child ? owner : NULL` — so **every** top-level
  `DialogBoxParamW`/`CreateDialogParamW` dialog was unowned as far as the
  window system was concerned;
- `comdlg32`'s file/find/font dialogs passed `NULL` beside their `hwndOwner`.

Flipping the classifier without this would have been strictly worse than doing
nothing: every MessageBox in the OS would have grown a taskbar button. The
ownership rule and the ownership plumbing are one change, not two.

`fileman`'s "Open with" and "Rename" windows are owned dialogs of the File
Manager window and now declare `g_win`; they were producing extra taskbar
buttons for the same reason.

## Why no `hw->owner` field

The classification is a create-time decision — `SDL_WINDOW_UTILITY` is a
create-time flag — so the owner is consumed where it arrives and nothing is
stored. Storing a raw `HWND` would introduce a dangling-pointer class (the
owner can be destroyed first) in exchange for state no reader wants.

Consequence, stated rather than hidden: **changing `WS_EX_APPWINDOW` /
`WS_EX_TOOLWINDOW` with `SetWindowLongPtr` after creation does not
reclassify.** Real Windows also requires a hide/show cycle for the taskbar to
re-evaluate, so this is inside the contract, but it is a limit and it is
undocumented nowhere else. `GetParent` is deliberately unchanged: it still
returns the hierarchy parent (`NULL` for a top-level), not the owner.

## Tests

Two instruments, deliberately independent — one for the rule, one for the app.

`tests/kernel/test_taskbar_owner_e2e.js` + `tests/kernel/fixtures/tbown/`
creates four top-level windows **sharing one registered class**, one per branch
of the rule. Sharing the class is the whole point: a test that reads different
flags off them cannot be reading a class name. It also walks `wmctl cycle` and
pins that the two transient windows are never reached — the policy consequence,
read off `wins[]` rather than inferred from the flag.

`tests/kernel/test_calc_e2e.js` runs the ticket's own repro on the real shipped
app: calc's main window (unowned `#32770`) and its Statistics box (owned
`#32770`) are the same class with opposite ownership, and `notepad &` supplies
the second cyclable window the report describes.

Both were verified RED against a **red control** that restores only the
class-name expression and leaves every other change in place:

| | red control | fixed |
|---|---|---|
| `test_taskbar_owner_e2e.js` | 4 FAIL | all ok |
| `test_calc_e2e.js` (#740 legs) | 2 FAIL | ALL OK |

The two owned-window legs (`Statistics box` stays transient) are green in
**both** states — they are regression pins, not evidence, and a control that
flips them would have meant the test was measuring something else.

### A dead end worth recording

The first cut of the calc leg cycled with only calc up and asserted focus
returned to Calculator. It failed *after* the fix, and the fix was not wrong:
`os/wm.c` `cycle()` picks the highest-stamp entry in `wins[]` and then looks
for a *different* one, so with a single cyclable window it correctly sends
nothing and focus stays on the (transient) Statistics box. The ticket's repro
has two apps for a reason; the test now does too.

Whether `cycle()` should focus the sole cyclable window when the focused window
is not cyclable is a separate question about `/bin/wm` policy, deliberately not
answered here.
