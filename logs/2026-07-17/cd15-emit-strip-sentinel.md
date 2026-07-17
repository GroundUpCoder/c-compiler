# CD15 — single-file emit: strip host.js's tail at a structural sentinel (todos/0245)

## The debt

`JsOutput.generate` (the `.js` single-file emit) removed host.js's
run-if-main tail by regexing the literal PROSE of host.js's
`// Dual-purpose logic: …` comment:

```js
const hostBody = strippedHostJs.replace(/\/\/\s*-+\s*\n\/\/\s*Dual-purpose logic[\s\S]*$/, '');
```

Reword or re-wrap that comment and the regex matches NOTHING — the strip is
a silent no-op and the emitted bundle keeps the tail. The bundle itself is
`require.main`, so the tail's `if (require.main === module)` CLI executes
BEFORE the real program. Demonstrated pre-fix at 284dbd8: rewording the
comment in a scratch copy produced an exit-0 emit whose run printed stray
output (host.js's CLI running against a stale `a.wasm` in cwd) ahead of the
program's own output — silent double execution, zero diagnostics. The same
class CD26 closed for the SAB layout: cross-file agreement enforced by
nothing.

## The fix (structural seam, fail loud)

- **host.js** owns a machine sentinel line, `// @cc-strip-below`, directly
  above the dual-purpose tail. The surrounding prose is free to change; the
  marker line is the contract (its comment block says so).
- **compiler.js** gets ONE shared `prepareEmbeddedHostJs()` — shebang strip
  + cut at the line-anchored sentinel (`/^\/\/ @cc-strip-below\b/m`) — used
  by BOTH emitters. Sentinel absent → throw naming the sentinel and
  host.js; a reworded comment now kills the emit loudly instead of
  double-executing silently.
- **The sibling HTML path** (`HtmlOutput.generate`) previously embedded
  host.js with the tail left in. Audited: the tail was inert-or-redundant
  there — `require`/`module` are undefined in the page `<script>` and the
  blob worker, and both scripts reference host.js's TOP-LEVEL declarations
  directly (bare `runModule`/`SDL_WEB`/`BLOCK_FS`/`createSharedAudioBuffer`
  …), so the tail's `window.*`/`self.*` re-export blocks carry no load.
  Rather than documenting an exemption + keeping a second divergent embed
  regex, the HTML path now calls the same helper: every host.js embed strips
  at the sentinel, uniformly, fail-loud. HTML bundles shrink by the dead
  tail as a side effect.

Repo-wide scrub for other prose-coupled strips of host.js: the only other
hit is `tools/disasm/index.html` — gitignored `build.py` output that inlines
compiler.js verbatim; it picks the fix up on next regen. `tests/browser/www/`
bundles are likewise untracked artifacts or hand-written spikes.

## Test

`tests/host/test_singlefile_emit.js` (host suite): `.js` bundle carries no
tail marker and prints exactly one `RAN`; `.html` bundle carries no tail
marker and still embeds host.js; tripwire leg copies compiler.js + a
doctored host.js (sentinel reworded, prose intact) into a tempdir — the emit
must exit nonzero naming `// @cc-strip-below`, with no bundle written.
`tests/run.js`'s `^compiler\.js$` rule grew `host` (the emitters live in
compiler.js; their test lives in the host suite).

## Gate

No codegen path touched — the diff is confined to the HtmlOutput/JsOutput
emitters + a comment-only host.js insertion, so no SameBoy interlock and no
image bump (nothing baked changes; host.js is loaded as a file at runtime,
comments inert). unit (757 pass/8 xfail), host (incl. the new test), blockfs,
kernel (76 pass) all green foreground.
