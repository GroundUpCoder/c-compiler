# POSIX-on-WebAssembly talk rewrite (todos/0221)

The first shipped deck treated the author's outline as slide copy. This redo
starts again from the user's draft and develops its thesis into a talk: when
the browser already owns the hardware, which operating-system responsibilities
remain ours?

The narrative now earns the DO / DON'T / DON'T NEED TO split instead of merely
listing it. It begins with the familiar hardware-stack definition, replaces it
with an OS as a bundle of promises, distinguishes a POSIX contract from a whole
system, and uses the Emscripten question to expose the missing system layer.
The three-way triage then carries the technical middle of the talk. Concrete
gucOS mechanisms support every claim: isolated wasm processes and brokered
spawn, BlockFS and hush, the compositor/window manager and sound mixer, and
cooperative signals. The exclusions are explained as substrate and design
choices rather than deficiencies.

The payoff is "the browser is the HAL": web APIs replace the device-driver
boundary, while gucOS still supplies the coherent world shared by programs.
Emulators and adjacent wasm projects are framed as other valid points in the
design space, with different semantic costs. The closer returns to the repo's
plain-text ethos by inviting the audience to right-click, edit, and reload the
deck itself.

Only directives exercised by the gucOS MagicPoint tutorial are used. The baked
image version was bumped, and the talk page-through count was updated for its
22 pages and seven progressive-reveal stops.

## Verification

- `node tests/kernel/test_present_e2e.js` — PASS; the deck rendered all 29
  stops and remained alive, with title/background and page-advance pixels
  verified.
- `node tests/kernel/test_openwith_e2e.js` — ALL OK; desktop and file-manager
  viewing plus both right-click Edit paths remained live, including opening
  the POSIX deck from its nested folder.
- `node tests/browser/os-present.mjs` — PASS after explicitly prebaking v108;
  the first attempt expired in `waitForServer` while that new image was being
  built, before any browser assertion ran.
- `node tests/run.js --diff` — 3/3 suites PASS: projects 26/26, kernel 75/75,
  browser sweep 27/27.

## Visual-review correction

The first post-commit contact sheet exposed a failure the automated gates did
not: the default size-8 headings wrapped mid-word across much of the deck, and
several long payoff lines overflowed too. The parser and page-through tests
correctly proved that the deck rendered, but they did not prove that it was
presentable. Headings now use a size-5 budget that fits the longest title;
long rhetorical lines use size 4 or 5, and the one over-budget WASIX bullet was
shortened. Image v109 carries the corrected seeded source. A fresh 22-slide
render and manual contact-sheet review confirmed that headings, bullets, and
the final payoff slides now stay inside their intended areas.
