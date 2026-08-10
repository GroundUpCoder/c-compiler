# #626 — GCODE.md: the non-letter `SDLK_*` constants DO exist

Follow-up to #625 (`6c3c2431`), filed by @master at that merge. #625's sentence
("the `SDLK_a`…`SDLK_z` letter-key constants do NOT exist") is true, but an
agent can over-generalise it to "no `SDLK_*` at all" and then avoid
`SDLK_ESCAPE`/`SDLK_LEFT`/`SDLK_RIGHT` — exactly the keys a game needs for
quit and movement. Same harm class #625 fixes: a wrong platform belief that
costs the agent turns. The omission misleads, not the sentence.

## The measured surface (verified, not copied from the ticket)

The ticket's list was measured independently per its own instruction. Result:
**exactly 43 `SDLK_*` constants**, verified two ways:

- `rg -o 'SDLK_[A-Z0-9_]+' compiler.js | sort -u` → 43 names
  (`rg -c '#define SDLK_' compiler.js` → 43; positive control: the same
  search finds `SDLK_ESCAPE`).
- The same 43 extracted from
  `createDefaultPPRegistry().standardHeaders.get('SDL.h')` — the map the
  compiler resolves `<SDL.h>` from AND the text `foldStdlibHeaders` bakes to
  `/usr/include/SDL.h`, so compile surface and readable surface are one.

The ticket's list (21 names + "and more") was **correct but incomplete** — it
omitted `SDLK_RETURN`/`SDLK_TAB`/`SDLK_SPACE`, `SDLK_PLUS`,
`SDLK_PRINTSCREEN`/`SDLK_SCROLLLOCK`, F2–F12, and the R-side modifiers.
Nothing in it was wrong.

## Where the boundary actually falls

The `#define` block (compiler.js:21706) has two tiers, matching what
host.js's `keysym()` puts on `event.key.key`:

- **ASCII tier** — the constant IS the character code the event carries:
  `BACKSPACE` 8, `TAB` 9, `RETURN` 13, `ESCAPE` 27, `SPACE` 32, `PLUS` 43,
  `MINUS` 45, `EQUALS` 61, `DELETE` 127. (host.js `NAMED_KEYSYMS` +
  one-char `e.key.charCodeAt(0)`.)
- **Extended tier** — `0x40000000 | scancode` (SDL's named-key scheme;
  host.js falls through to `SCANCODE_MAP[e.code] | 0x40000000`): `CAPSLOCK`,
  `F1`–`F12`, `PRINTSCREEN`, `SCROLLLOCK`, `PAUSE`, `INSERT`, `HOME`,
  `PAGEUP`, `END`, `PAGEDOWN`, arrows, `NUMLOCKCLEAR`, and the eight L/R
  modifiers. E.g. `SDLK_LEFT` = 1073741904 = `0x40000000|80` (ArrowLeft).

**Absent**: all letters (#625), all digits, all keypad `SDLK_KP_*` (keypad
keys DO produce `0x40000000|scancode` keysyms via host.js `KP_CODES`, but no
named constants exist for them), and all punctuation except
`PLUS`/`MINUS`/`EQUALS`. Verified behaviorally: `SDLK_0`, `SDLK_COMMA`,
`SDLK_KP_1` each fail as `Undeclared identifier` through the real
`createCcDriver`.

## What changed

- `os/gcode/GCODE.md` — the #625 bullet extended in place: the special-key
  `SDLK_*` constants DO exist and match `event.key.key` (named groups, full
  list delegated to the `SDLK_` block in `<SDL.h>`, which the doc already
  tells the agent is the authoritative surface); digits/punctuation are char
  literals like the letters (with the three punctuation exceptions named);
  `SDLK_KP_*` don't exist. Deliberately `<SDL.h>`, not
  `/usr/include/SDL.h` in backticks: the test's path extractor checks
  backticked absolute file paths against the raw manifest, and the header is
  planted later by `foldStdlibHeaders` — the raw-manifest check would
  false-positive on it.
- `tests/host/test_gcode_orientation.js` — section 7, same `ccHarness`:
  - all 43 compile in one program, with negative-array-size value pins on
    the whole ASCII tier (`SDLK_ESCAPE==27` … `SDLK_PLUS=='+'`) plus
    `SDLK_LEFT==(0x40000000|80)` pinning the extended scheme;
  - `SDLK_0`/`SDLK_COMMA`/`SDLK_KP_1` stay undeclared (boundary);
  - set-equality of the 43 against `standardHeaders.get('SDL.h')` — a
    future `SDLK_` addition/removal is a loud resync-the-doc failure naming
    the delta, not silent drift;
  - RED controls: a wrong-value pin (`SDLK_ESCAPE==9999`) fails the
    compile, and the comparator flags both an injected and a removed name.

## Red-control evidence (live, per the #97 standard)

- Doc claim redacted (`DO exist` → `REDACTED`): run FAILED exactly
  `every special-key SDLK_* compiles…`, exit 1.
- `SDLK_RGUI` dropped from the test's surface list (temp copy in
  `tests/host/`, non-`test_` name so the registry never sees it): run FAILED
  exactly `the full SDLK_ surface…` with
  `new in header: [SDLK_RGUI]`, exit 1.
- Final green on the real files: 18/18 checks, exit 0.

NB an earlier red-control attempt ran the temp copy from `/tmp` — it exited 1
by crashing on `ROOT` resolution, which a bare exit-code read would have
accepted as the red firing. Re-ran in-tree with the failure text asserted.

## Not changed

`os/image.json` untouched — content-addressed invalidation; #625 set the
precedent and no gate demanded a bump. Acceptance is on correctness (the #505
ruling: the builds-at-cap-12 instrument cannot resolve a context change this
size); no A/B run.
