# #346 + #347 — fractional mouse-wheel deltas: LISTBOX + Term

Two instances of one defect: a WM_MOUSEWHEEL/SDL-wheel consumer that
truncates each event independently, so high-resolution wheels and trackpads
(whose events are fractions of a notch) scroll nothing — every sub-quantum
event dies at the division/cast and the motion never accumulates.

- **#346, `os/win32/user32.c` `lb_proc`**: `st->top - 3 * (delta / WHEEL_DELTA)`
  truncated every |delta| < 120 to zero. Fixed with the 0210 EDIT idiom —
  the same accumulator shape, deliberately not a new one: `wheelAcc +=
  delta; lines = wheelAcc / (WHEEL_DELTA / 3); wheelAcc -= lines * ...`.
  C division truncates toward zero, so the remainder keeps its sign and
  opposite-sign motion cancels without drift. `LB_RESETCONTENT` zeroes the
  carry (the recycle path — fileman refills through it on navigation);
  `WM_CREATE`'s calloc covers fresh controls.
- **#347, `os/term/term.c`**: `scroll_view((int)e.wheel.y * 3)` — the cast
  bound before the multiply, so |wheel.y| < 1.0 became 0. New
  `scroll_wheel(notches)` at the scrollback model boundary accumulates
  `notches * 3` lines in a float carry and feeds whole lines through
  `scroll_view` (the one viewport mutator — PgUp/menu/scrollbar all share
  it). Reset semantics: `hist_clear` (RIS + Clear Scrollback), `enter_alt`
  (either direction), and `sb_set_max` (scrollback config change) zero the
  carry; a keypress deliberately does not (a sub-line carry surviving a
  snap-to-live is harmless and the EDIT precedent keeps its carry too).

The upstream conversion (`user32.c` SDL→WM pump) multiplies BEFORE its
cast — that is *why* sub-WHEEL_DELTA deltas exist downstream — and is
correct; a marker comment now records the second-order caveat that motion
below 1/120 notch per event still truncates there with no carry (120×
finer than the class fixed here; deliberately left).

## Evidence

- `tests/kernel/test_lb_vscroll_e2e.js`: six-step sub-notch leg through the
  real input path (`wmctl wheel` takes fractional notches already — atof).
  0.25-notch = 30 units vs the 40-unit line quantum: single event no-op,
  second crosses, opposite sign cancels the remainder, an exactly-consumed
  remainder does not linger, a live remainder carries. Gotcha: LBN_SELCHANGE
  only fires when sel CHANGES, so the evidence clicks alternate rows —
  same-row re-clicks are silent and the ordered-marker chain never sees them.
- `tests/kernel/test_term_e2e.js` session S: fw0–fw5 shots; a fresh
  full-ink marker row's grid position tracks view_off exactly (0.25 notch =
  0.75 lines; 19px/line).
- `tests/browser/os-wheel.mjs` (NEW, in the sweep by discovery): real
  Chromium `page.mouse.wheel` at deltaY 25 (= 0.25 notch via the
  compositor's 1/100-per-px conversion) over term scrollback, the fileman
  LISTBOX, and the notepad EDIT. The EDIT leg is the positive control the
  #346 acceptance names — and the booted-browser evidence #30 (0134) was
  waiting on: the 0210 handler exists AND works under trackpad-sized input.
  Probe gotchas that cost a round each: white-ground controls need a
  dark-ink probe (a bright probe matches the background), and the EDIT's
  sunken-edge border is a static full-width dark row — the scan floor must
  sit below it or the band never "moves".
- Red controls (fixes stashed, tests kept): kernel LISTBOX leg 3 FAIL,
  kernel term leg 4 FAIL (marker pinned at row 9 across all six shots),
  browser term leg FAIL at the first movement assert. The no-move probes
  pass either way by construction; the movement probes are the
  discriminators.

Row-height note: ctldemo's LISTBOX rows are 22px but fileman's are 30px and
the EDIT's lines 28px (per-window font metrics), so the browser legs measure
the per-line pixel delta live instead of hardcoding it.
