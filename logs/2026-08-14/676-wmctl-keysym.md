# #676 — wmctl key/skey: omitted KEYSYM derives from the scancode

**Class: quality-gap** (per the ticket; not re-classified). Lane
`lane/676-wmctl-keysym`; fix `8675efe7`, test-target correction `994e7ad6`,
merge of main (#669) `29df1df5`.

## The gap

`wmctl key SID SCANCODE [KEYSYM [MOD]]` defaulted an omitted KEYSYM to 0
(`os/wmctl.c`, both the `key` and `skey` families). gucOS apps match keys on
`event.key.key` — char literals or `SDLK_*` — so a keysym-0 event is invisible
to virtually every app: the injection reports success and nothing reacts.
Measured harm (#508 Pass B r2): the dogfood agent injected `wmctl key $SID 80`
(LEFT scancode), saw no rotation, and burned rounds + a restart discovering it
had to pass 1073741904 (SDLK_LEFT) explicitly.

## Mechanism correction to the ticket

The ticket's fix-shape note said "the kernel owns the scancode→keysym mapping;
wmKey is the reference path". **Verified false at 911e6a78**: `kernel.js
wmKey`/`wmInjectKey` carry the keysym they are handed (kernel.js:5636, 6508)
and the kernel is deliberately keyboard-policy-blind (the grab-table comment,
kernel.js:1072). The one real mapping is **host.js `SDL_WEB.keysym()`**
(~host.js:10457): DOM `e.key`/`e.code` → SDL keysym at the browser input seam
(`os/compositor.js routeInput`). Recorded as a ticket comment so the next
reader is not misled.

## Fix shape

`sym_from_scancode()` in wmctl.c's parser, mirroring SDL_WEB's tables exactly:

- letters/digits/punctuation → the unshifted US character (`4` → `'a'`);
- Return/Escape/Backspace/Tab/Space/Delete → their named SDLK values
  (13/27/8/9/32/127 — SDL_WEB's `NAMED_KEYSYMS`);
- everything else → `scancode | 0x40000000` (SDLK_SCANCODE_MASK: arrows,
  F-keys, keypad, modifiers — `80|mask` = SDLK_LEFT = 1073741904);
- `scancode <= 0` still derives nothing (keeps the #501 "scancode 0 injects
  nothing" reading).

The derivation lives in the **parser**, not the kernel, because only the
parser can distinguish an omitted KEYSYM from an explicit 0 (the wire carries
five words either way) — so an explicit KEYSYM, including 0, keeps overriding.
Modifier application is not needed: the positional syntax can only omit KEYSYM
when MOD is also absent, so the derived press is always the unmodified one.
Applies to `key`/`keydown`/`keyup` and `skey`/`skeydown`/`skeyup`.

Back-compat swept: every omitted-KEYSYM consumer in the estate
(`os-overview.mjs:171`, `test_menubox_e2e.js:99,124`, the #501 legs in
`test_wm_service_e2e.js`) matches on scancode or any-keydown — none matches
keysym 0.

Also: GCODE.md's wmctl bullet now teaches the injection recipe (the measured
harm was the in-OS agent's confusion); image.json 262→263 (wmctl.c and
GCODE.md are baked; #669 did not bump, so this is the merge's one bump).

## The proof leg, and a lesson

`test_wm_service_e2e.js` drives the 0103 desktop rename flow with every KEYSYM
omitted — Right/F2 (masked branch), Backspace/Enter (named), 'k' (printable)
are all keysym-matched in wm.c, so the rename lands only if derivation works.

First cut aimed at `mmm` as top-left and the gate FAILED with `alaunckkk` on
the desktop — which is itself the proof the fix worked: `alauncher` minus
"her" plus "kkk" means every derived keysym landed; the leg's *target model*
was wrong (the seeded Desktop icons sort ahead of `mmm`; only `aa*` names sort
first, which is why the neighbouring rn-legs use them). Fixed by seeding a
fresh `aaa` to own the top-left cell.

Red control re-run after the leg change (pre-fix wmctl.c via
`git checkout main -- os/wmctl.c`): exactly one FAIL — the #676 leg, `aaa`
untouched, no `kkk` — every other check ok. Restored, single file PASS.

## Gate

`node tests/run.js --diff main` on `29df1df5` (post-merge): **kernel 178/178
pass, sweep 59/59 pass**, 2506 s, `filter: null`, `recorded == total`,
resumed/carried 0 in both suites. Tier `diff` — todos/unit/host/blockfs/… were
deliberately not run; this is not a ship gate.
