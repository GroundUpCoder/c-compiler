# #399 / #183 — browser tests no longer write screenshots into committed journal folders

Two sweep tests hardcoded their screenshot OUT_DIR into `logs/YYYY-MM-DD/` —
committed journal territory — and overwrote in place on every run:

- `tests/browser/os-vt2zoom.mjs` → `logs/2026-07-18/` (`vt2-zoom-1x.png`, `vt2-zoom-2x.png`)
- `tests/browser/os-hires.mjs` → `logs/2026-07-25/` (`hires-before-1x.png`, `hires-after-05x.png`)

Three escalating consequences: every sweep dirtied every lane's tree; lanes
that `git add -A` swept the churn into unrelated commits (`d48012a2` on
`wm-hit-zones-388` carried all four PNGs, stripped by @master in `d6c77f08`);
and — the real damage — the July journal prose cites those exact images as
evidence (`vt2-zoom-vt1-bump.md:86`, `oshires-repin.md:24`), so each sweep
silently replaced July's pixels with today's. Nothing errored. A
true-sounding committed record that quietly stops being true is the worst
class we track. The 2026-07-18 "fix" (`305676db`) made it permanent by
COMMITTING the test output — converting transient strays into tracked files
guaranteed the ` M` churn recurred forever.

## What changed

- Both `OUT_DIR`s now point at gitignored scratch, per the existing suite
  convention (`os-gcode.mjs`'s `build/test-browser/gcode-shots/`):
  `build/test-browser/vt2zoom-shots/` and `build/test-browser/hires-shots/`.
  `snapshot()` prints each absolute path it writes (`  shot: …`), so the
  artifact jku sees is still findable — moved, not dropped. The stale
  header comments ("land in the dev log dir") now name the real destination
  and mark the committed July PNGs as frozen evidence.
- The stray-name drift resolves itself: `hires-before-1x.png` (written but
  never committed — the committed sibling is `-2x`) now lands under `build/`
  like everything else. No committed PNG was touched, deleted, or
  regenerated; `git diff origin/main -- logs/` is empty (bar this file).
- **Guard** (`tests/host/test_browser_out_dirs.js`, in the host suite): a
  string-literal scanner over every `.mjs` under `tests/browser/`
  (comment-aware, node_modules excluded) that FAILS on any path naming
  `logs/`, `todos/`, `docs/`, or `old/`. It carries a positive control —
  the original defect line is scanned and must be flagged on every run —
  so a tokenizer regression can't rot it into a vacuous green. Red control
  demonstrated live: repointing os-hires back to `logs/2026-07-25` fails
  the test naming file+line; 107 files scanned, zero false positives.

## Class sweep

Grepped all of `tests/browser/` for every write primitive (`writeFileSync`,
`appendFileSync`, `createWriteStream`, `mkdirSync`, `page.screenshot`). Every
other destination is already sanctioned scratch: `build/…` (os-gcode,
os-mgpp, os-rust, build-doom/quake), `media/` (shots-0210, nsdemos-* —
gitignored, and none are in the sweep glob), `/tmp` (test-blockfs), or a
`tests/browser/.gitignore`-covered name (`shot-*.png`, `fail-*.png`,
`oc-*.png`, `*-safari.png`, `*-extracted.png`, `last-screenshot.png`,
`www/*`). The two files this ticket names were the whole class.

No in-repo "restore the churned PNGs" instruction exists to retire (#183
plan step 4) — that mitigation lived in coordinator prose outside this repo;
flagged in the lane report so @master can drop it there.

Assertion parity: os-hires 23 checks before and after; os-vt2zoom 17 before
and after. Behaviour under test is untouched — only the artifact
destination moved.
