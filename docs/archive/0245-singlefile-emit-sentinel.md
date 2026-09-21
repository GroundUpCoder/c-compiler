# 0245 — CD15 — single-file emit strips host.js's tail by prose comment; make the seam structural + fail-loud

- **Status**: done (2026-07-17) — structural `// @cc-strip-below` sentinel in host.js + one shared `prepareEmbeddedHostJs` for both emitters (missing sentinel throws); `tests/host/test_singlefile_emit.js`; unit/host/blockfs/kernel green
- **Design**: —

## Goal

Close code-debt scan CD15 (2026-07-17): the single-file `.js` emit
(`JsOutput.generate`) stripped host.js's run-if-main tail with a regex over
the literal PROSE of host.js's "Dual-purpose logic" comment. Rewording that
comment made the strip a silent no-op — the emitted bundle kept the tail and
DOUBLE-EXECUTED (the bundle itself is `require.main`, so host.js's CLI ran
against `a.wasm` before the real program), with exit 0 and zero diagnostics.
The sibling `.html` emit (`HtmlOutput.generate`) embedded host.js with the
tail left in (inert there — `require`/`module` undefined in page/worker
scripts — but dead weight, and a divergent second copy of the embed logic).

## Plan

- host.js: an explicit machine sentinel line `// @cc-strip-below` immediately
  above the dual-purpose tail — the prose comments stay free to change; the
  marker line is the contract.
- compiler.js: ONE shared `prepareEmbeddedHostJs()` (shebang strip + cut at
  the line-anchored sentinel) used by BOTH emitters, throwing an error that
  names the sentinel and host.js when it's absent — a missing/reworded
  sentinel can never again silently emit the tail (the CD26 tripwire shape).
  The HTML path strips the tail too now: both its page `<script>` and worker
  script reference host.js's top-level declarations directly (bare
  `runModule`/`SDL_WEB`/`BLOCK_FS`/`createSharedAudioBuffer`), so nothing in
  the tail (window/self re-exports included) is load-bearing in a bundle.

## Acceptance

- `tests/host/test_singlefile_emit.js`: `.js` bundle carries no tail marker
  and prints exactly one `RAN` when run; `.html` bundle carries no tail
  marker and still embeds host.js; a doctored host.js (sentinel reworded,
  prose kept) makes the emit exit nonzero naming `// @cc-strip-below` with
  no bundle written. Registered in the host suite; `^compiler\.js$` diff
  rule grew `host`.
- No codegen path touched (emitters only); no image bump (host.js change is
  comment-only; nothing baked changes).
