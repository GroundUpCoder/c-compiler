# P0: gucman "Couldn't connect to server" — the unbound-fetch receiver bug (ticket #78)

## What broke

The kernel's HTTP transport (todos/0172) stored the global `fetch` on the
Kernel instance and invoked it as `this._fetch(url, init)`. Browsers
brand-check `fetch`'s receiver: called with the Kernel as `this`, Chrome
throws `TypeError: Failed to execute 'fetch' on 'WorkerGlobalScope':
Illegal invocation` **before any network request goes out**. The libcurl
veneer saw the failed `__http_status` as `CURLE_COULDNT_CONNECT`, so gucman
printed "Couldn't connect to server" on the live deploy — a misleading
symptom three layers away from the cause.

Fix: `fetch.bind(globalThis)` at the default `_fetch` assignment
(kernel.js). The `opts.fetch` override path is untouched — embedders and
tests that inject a fake fetch own its binding.

## Why every test was green while production was broken

Two independent holes, both closed here:

1. **No browser-realm HTTP coverage.** Node's undici `fetch` does NOT
   brand-check its receiver, so the entire kernel suite (a Node realm) can
   structurally never catch this class. The in-browser `__http_*` path had
   never once executed in a real browser realm under test.
   → New `tests/browser/os-gucman.mjs` (auto-discovered by the sweep):
   boots the OS in real Chromium, `gucman install lua` through the baked
   origin-relative `/packages` repo — index fetch + streamed payload +
   sha256 verify + extract + planted-symlink run + remove, all over the
   kernel fetch. Proven RED on the unbound-fetch kernel.js (`GUC-RC=1` +
   the "Couldn't connect" symptom), green on the fix.

2. **comguc's verify.mjs was a false-green gate** (the 0171 anti-pattern,
   in a new costume): its needles (`GUCMAN-OK`, `QUAKE-INSTALLED`,
   `QUAKE-NOT-BAKED`, `HAS-DOOM`, `NO-ROM`) were substrings of the typed
   command's OWN tty echo, so `waitOut()` self-satisfied instantly
   regardless of outcome — the broken deploy verified green. Fixed (comguc
   repo) with the split-needle pattern: type `TAG""=value`, wait for the
   un-split `TAG=` only the RESULT prints, then assert the value — wrong
   outcomes now fail fast instead of by timeout. Proven: verify.mjs FAILS
   (2 checks) against a dist whose kernel.js is reverted to unbound fetch,
   PASSES on the fixed build. The `ls`/`cc hello.c` needles were already
   genuine (program output, not echoable).

## Diagnostic polish

host.js's `__http_status`/`__http_read` discarded the kernel's real error
text (`{errno:'EIO', error:'…'}` → bare EIO → CURLE_COULDNT_CONNECT). They
now `console.error` the transport's error before returning the errno — on
the red run the page console said `Illegal invocation` outright instead of
implying a network problem. The C surface is unchanged (errno only).

## Test-sync notes

- The new sweep file passes `serverTries: 600, serverInterval: 500` to
  `openOsSession`: a stale image makes serve.js re-bake before listening,
  and the default 50×100ms only covers an already-fresh tree.
- It runs `tools/mkpkg.js` up front — serve.js bakes the FAT image itself
  but does not build `dist/packages`, and the index's `minBase` must match
  the served image's version.
- Needle hygiene inside the test follows the same split-needle rule it
  exists to enforce (`echo GUC-RC""=$?` → wait `GUC-RC=` → assert `=0`).

## Gate

kernel.js is runtime JS (not baked) — image.json untouched, v123 stands;
compiler.js untouched. unit 756/756 (one unrelated `usleep_zero` timing
flake, green standalone and on rerun), host pass, blockfs 15/15, kernel
89/89, os-gucman via the sweep runner + flake gate 3/3 stable under load
×10. comguc verify: red-on-broken → green-on-fixed, quake package installs
end-to-end in-browser.
