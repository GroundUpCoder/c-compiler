# #343 — BUTTON BS_NOTIFY notifications + EDIT ES_NUMBER digit filter

Two style bits the #318 created-style net had allowlisted as
tracked-not-implemented (ex-L69) become real features.

## BS_NOTIFY (0x4000)

`btn_proc` now sends the gated notification set through the new
`btn_notify()` helper — the exact `WM_COMMAND` packing `btn_fire` has
always used for `BN_CLICKED` (code high word, control id low word,
control handle as lParam), so there is one send idiom, not two:

- `BN_SETFOCUS` / `BN_KILLFOCUS` from the `WM_SETFOCUS`/`WM_KILLFOCUS`
  arms, only when `BS_NOTIFY` is set.
- `BN_DBLCLK` from `WM_LBUTTONDBLCLK`, the Windows/Wine button-proc
  shape: with the bit, the second click of a pair NOTIFIES instead of
  pressing (no focus/capture, and the following button-up fires no
  `BN_CLICKED`); without the bit it falls through to the plain press —
  byte-identical to the old behavior.
- `BN_CLICKED` stays ungated (it never required `BS_NOTIFY`).

The BUTTON class now registers with `CS_DBLCLKS`, matching the real
BUTTON class — without it the input router never synthesizes
`WM_LBUTTONDBLCLK` for buttons and `BN_DBLCLK` would be dead code from
real input. Non-notify buttons are unaffected: `btn_proc` treats the
dblclk as a plain press, which is what the second rapid click already
did. No test in the estate double-clicks a BUTTON by pixel, so no
existing expectation moved.

Recorded divergence: Windows also auto-sends `BN_DBLCLK` for
`BS_RADIOBUTTON`/`BS_OWNERDRAW` *without* `BS_NOTIFY` (the Wine
button-proc condition). The ticket's acceptance explicitly scopes the
gate to `BS_NOTIFY` alone ("a button without the bit must behave exactly
as it does today"), so that nuance is deliberately not implemented; the
gate comment in `btn_proc` records it.

## ES_NUMBER (0x2000)

`edit_proc`'s `WM_CHAR` arm rejects any printable non-digit when the
style is set — `MessageBeep(MB_OK)` (the veneer's real beep path, the
0094 sound scheme) and no insert, before any buffer mutation, so
`EN_CHANGE` doesn't fire on a reject. Control characters (backspace)
pass, and `WM_PASTE` is deliberately unfiltered — classic Windows lets
paste through — with a selftest check pinning that so a future "fix" is
a decision, not a drive-by.

## The allowlist step — the ticket's wording was wrong twice

The acceptance said "delete the two `CLS_LOW_KNOWN` entries"; the
coordinator corrected that to "clear the bit from the mask". Reading
`style_net` shows BOTH are wrong: the mask lists bits that do NOT report
(`unk = style & ~known`), and its own header defines KNOWN as "some code
path READS the bit". Clearing 0x4000/0x2000 would have made every calc
boot (keypad passes `BS_NOTIFY`) and notepad GoTo report a freshly
implemented feature as "unread — nothing implements them". The masks
therefore keep their values (`0x4F0F`/`0x29C4`); only the comments
changed, from "tracked, #343" to "read (#343 …)" — the bits moved from
the ticketed-gap KNOWN category to the read KNOWN category. The green
run's stderr confirms the net stays clean on both bits (only the
selftest's deliberate BS_FLAT/0x100 probes report).

L69 (the register entry funding this gap) is deleted in the same commit.

## Tests

- `ctldemo selftest`: 9 new checks (90 total) — focus pair, clicked-
  without-bit, clicked-with-bit, dblclk-notify + not-a-press, plain-
  dblclk-stays-a-press, digit filter, backspace passthrough, paste
  unfiltered, plain-EDIT-still-accepts-letters. Red control: with
  user32.c stashed (headers kept), exactly the 8 feature checks fail;
  the two regression pins still pass.
- `test_user32_e2e.js`: a real injected double-click on Greet (now
  `BS_NOTIFY`, printing `greet-dblclk` on `BN_DBLCLK`) proves the
  `CS_DBLCLKS` synthesis → `btn_proc` → parent route end to end.
