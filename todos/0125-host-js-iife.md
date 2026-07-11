# 0125 — Wrap host.js so its top-level bindings don't leak onto the page

- **Status**: open
- **Design**: this file (self-contained); see the tail of `host.js` for the
  current `window.*` / `module.exports` / `self.*` export blocks.

## Goal

`host.js` is a single flat classic script: every top-level `const`/`let`/
`function` (`ENV_KEY`, `wrapLseekI64`, `CURSOR_CSS`, …) lives at the file's
top scope with no IIFE or module boundary. In Node that scope IS the module,
so nothing leaks. But `os/os.html` loads host.js as a plain
`<script src="../host.js">` (on the page ONLY for `createAudioReceiver`,
todos/0017) — so in the browser those bindings land in the PAGE's global
lexical environment, sharing scope with os.html's own inline `<script>`.

That is a live footgun: adding `const CURSOR_CSS` to host.js (todos/0105)
collided with os.html's `var CURSOR_CSS`, and because a `var` may not
redeclare an existing lexical `const`, the browser rejected os.html's ENTIRE
inline block at parse time — gucOS failed to boot under `serve.js`, with no
Node-side test catching it (boot.js `require()`s host.js, where the same
`const` stays module-scoped). We patched the symptom by renaming the os.html
copy to `CURSOR_CSS_MAP`; this item removes the hazard class so the next
top-level name in host.js can't silently break the page again.

## Plan

Wrap host.js's body in an IIFE (or otherwise give it a private scope) whose
only escape hatches are the existing, explicit export blocks:

- `module.exports.*` (Node),
- `window.*` (page: `createAudioReceiver` et al.),
- `self.*` (worker: `runModule`, `createBrowserSDL`, `BLOCK_FS`, …).

Keep the `#!/usr/bin/env node` shebang as line 1 (an IIFE `(function(){…})()`
after it is fine). Nothing outside those three blocks should reach any global
object. Watch for any code that today relies on a top-level `function`/`const`
being hoisted onto `globalThis` (grep the worker/page bridges + tests for bare
references to host.js internals — there should be none, but verify: the whole
point is that the leak was accidental).

Consider whether a lighter touch fits the repo better than a full IIFE — e.g.
an ESM/`type=module` load for the page (module top-level is already private),
or a build-free `{ … }` block for the lexical decls. Pick whichever keeps the
dual browser/Node portability contract (CLAUDE.md "Portability") with the least
churn; record the choice in the dev log.

## Acceptance

- `serve.js` + a browser boot of gucOS succeeds; `os/os.html` and `host.js`
  can each declare a top-level `const X` of the same name with no collision
  (add a throwaway pair to prove it during dev, then remove).
- Node `boot.js` and the kernel suite (`node tests/kernel/run.js`) still pass
  — host.js's exports are unchanged in both environments.
- Nothing in host.js reaches a global except through the three export blocks;
  `os-boots.mjs` (browser) still boots clean.
