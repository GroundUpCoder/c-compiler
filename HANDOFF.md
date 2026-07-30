# Handoff — start of thread (updated 2026-07-12; 0119 sent+mgp presentation tools landed)

> **HISTORICAL SNAPSHOT (2026-07-12).** Everything below reflects that date —
> the items it names shipped long ago, and the `todos/queue.js` file queue it
> references was **retired on 2026-07-30** for the cc ticket tracker. For the
> live workflow read `CLAUDE.md` ("Tickets & the work queue"); for the live
> queue run `cc-meta ticket list --project 019d77d8-f894-7d09-9099-4e747aa20bfb`.

## Latest: 0119 — sent + MagicPoint on SDL (both rounds, one pass)

**todos/0119 is DONE and committed.** The presentation-tool item shipped
whole: **vendor/sent** (suckless sent @882d54c, ISC) and
**vendor/magicpoint** (MagicPoint 1.13a, WIDE/BSD) with their display
layers ported Xlib→SDL per the item's settled fork-over-shim decision.
Seeded as `/bin/sent` + `/bin/mgp`, demo decks under `/usr/share/{sent,mgp}`,
Start menu ▸ Demos ▸ slides/mgp, `.sent`/`.mgp` in the openwith table.
Image **v80**.

- **sent**: sent.c patched to SDL + the frame callback; drw.c rewritten on
  freetype2; the fork+`2ff` farbfeld filter pipeline → native libpng/.ff
  loaders. Resizable 800×500 (WM maximize = present mode; no display-size
  query exists, and borderless would be chrome-less — deviation noted in
  `vendor/sent/README.md`).
- **mgp**: the fork's `sdlx.h/c` implements mgp's Xlib vocabulary
  (drawables = 0xRRGGBB canvases, XFlush converts+presents, SDL events →
  XEvent queue, 140-name color table) — NOT an os/ veneer, one file of the
  fork. tfont.c rewritten FreeType1→FT2; blocking main loop → frame
  callback (draw_one grew a "would block" return); plist/page-guide,
  X fonts, %system/%filter/EPS/GIF/JPEG/JIS descoped (full patch table +
  descope list in `vendor/magicpoint/README.md`). bison/flex outputs are
  COMMITTED (`grammar.c`/`scanner.c`/`tokdefs.h`, generated with `-l`/`-L`)
  plus `ctlwords.h`.
- **Compiler work**: `sizeof(a)[0]` postfix-binding parse bug FIXED
  (tests/unit/conformance/parse_sizeof_postfix, clang-verified); two new
  P0 compiler bugs filed from the port — **0158** (implicit fn decl
  crossing TUs → "emitExpr: function not found" ICE) and **0159**
  (unprototyped calls / K&R float params / empty-parens fn-pointer calls →
  invalid-wasm ICE; the C89 default-promotion ABI hole).

Dev log: `logs/2026-07-12/0119-presentation-tools-sent-mgp.md`.

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Tests / verification

- **`tests/kernel/test_present_e2e.js` — PASS** (15 checks: window
  lifecycle both apps, sent black-on-white glyphs, mgp MidnightBlue
  `%default` bg + white glyphs + green `%tab` box icons, paging, q quits).
- **`tests/browser/os-present.mjs` — PASS** (same content through the real
  compositor; window positions parsed from `wmctl list`, not hardcoded).
- Full re-run after the compiler.js parser fix: **unit 710/710 (3
  skipped), blockfs 15/15, projects 25/25, kernel all green**. The new
  e2e is REGISTERED in tests/kernel/run.js's table (easy to forget — the
  runner is table-driven, not glob-driven) and flake-gated: 3/3 under
  load; os-present.mjs 2/2.
- The two new Demos menu entries re-geometried the Start-menu flyout —
  `test_wm_service_e2e.js` and `os-shell.mjs` carry a `DEMOS` list ("bump
  when the image gains one"); both updated, both green.
- The os-shell sweep still carries the **pre-existing 0156 failure**
  (desktop-icon rename leg) — NOT related to this work.

## Gotchas carried forward

- **mgp/sent compile via bin.json at bake time** — a compiler.js/host.js/
  vendor edit re-bakes (~2min now; mgp is 800KB of wasm). Bump `image.json`
  `version` on any seeded-source edit (now **80**).
- Comment prose containing `*/` (e.g. `init_win*/get_color`) ends the
  block comment — standard C, but it broke the build twice here. Also:
  BSD `u_int` etc. aren't in this libc (sdlx.h typedefs them), libpng is
  1.6 (`png_jmpbuf`, `png_set_expand_gray_1_2_4_to_8`).
- **Playwright IS installed**; browser tests launch with
  `--enable-unsafe-webgpu --enable-features=Vulkan` via the harness.
- **`queue.js done` stages a PRE-EDIT blob** of the done file — after
  `done`, `git add todos/done/<file>` again.
- Concurrent sessions may exist: stage ONLY your own files; re-check HEAD
  before committing.

## Next in queue

`node todos/queue.js list` for the authoritative order. **0156** (os-shell
rename-leg failure) leads P0, then the new **0158**/**0159** compiler ICEs
(both have minimal repros in their bodies and would harden every old-C
port). After those, the P1 head is unchanged (0079 project dep dedup, 0080
cairo pdf/svg, 0052/0053 networking, 0064 WM sweep).

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; DISK-IMAGE.md's
layout; 0013–0155's recorded decisions. **0119's calls**: fork-the-apps,
no shared Xlib veneer (sdlx.c is mgp-fork-local by design); presentation
windows are resizable-with-chrome, not borderless-fullscreen; mgp descopes
(X fonts, %system/%filter, EPS/GIF/JPEG, JIS, page guide) are recorded in
the vendor README — revisit only with a real deck that needs them.

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want
to tackle — `node todos/queue.js list` for the order (0119 sent+mgp just
landed; P0s are 0156, then the two compiler ICEs 0158/0159 the port
uncovered)."
