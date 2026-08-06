# Batch J — #309, #365, #176, #173, #438 (five light P2s, one gate)

Base `d765a542` (the batch-i merge), branch `batch-j`. One commit per
ticket; the one image bump (v239→v240) rides #173's commit and covers the
whole batch.

## #309 — wm.c chrome_font() comment (comment-only)

Premise held: the `:660` block still claimed chrome equals the
`SYSTEM_FONT` stock and that chrome/controls/software-center render
identically — the exact opposite of C2 (`f69daa43`). **Ticket correction:**
the ticket says C2 updated the neighbouring comment at `:1715`; it did not
(verified: C2's only wm.c hunk is the `mc_set_font` comment at `:4618`).
The `:1715` parenthetical ("the DC default … is ALSO this font") was still
pre-C2 and false, and it mentions SYSTEM_FONT, so the ticket's own
acceptance grep required fixing it too. Both rewritten; the two surviving
SYSTEM_FONT mentions in wm.c are now post-C2-accurate. No standalone bump
spent (comment-only ⇒ identical compiled bytes); rides #173's.

## #365 — welcome.html "no network, no scripts"

Premise held and verified against the tree: JS is ON by default
(`gucos/main.c set_defaults`, Duktape, 10 s watchdog, Choices/CLI
off-switches) and http(s) is real (`gucos/httpfetch.c`, #182). Every other
page claim checked: keys match `gucos_key` (Alt+arrows history, Backspace
back, PageUp/Down/Home/End), `.html` double-click matches the package
openwith, `file:///root/` listings real, `about:logo` real. Rewritten to
state the actual capability; added how to reach a network url (there is
still no address bar — `gucos_url_from_arg` takes any scheme'd argv[1]).
Same falsehood fixed in `vendor/netsurf/README.md:5` (repo-authored doc,
not upstream — no patches/netsurf.diff impact) plus two residual
"file-only" rationales (README WITH_CURL note, layout-e2e forms comment)
in a follow-up commit. Ships via the netsurf package res/ tree
(content-addressed payload) and the fat bake (image.json-version-keyed —
rides the batch bump). In-OS render re-verified: the welcome legs of
`test_netsurf_content_e2e` pass on the rewritten page.

## #176 — netsurf image-cache ceiling: PREMISE REFUTED, sizing kept

Measured before writing code. On unmodified main, a generated 3200×1400
PNG (72 KB file, **17.1 MB decoded — 5.7× the 3 MB image cache**) renders
**fully at load** in the `<img>` case (465 600/465 600 client-area pixels
carry the stripe colours) and decodes fine as a direct url (window titles
"big.png (PNG image 3200x1400 …)" within 5 s). Source agrees:
`image_cache_redraw()` converts lazily with **no size refusal**; the limit
only drives the age- and `rand()`-gated background eviction
(`image_cache__clean`). So "does not fit the cache ⇒ never renders, even
at load" was never the mechanism. The original sighting is explained by
todos/0410 (`a64dd585`, co-filed the same day): a large image completes
late, post-DONE completions were never reflowed — "zero height, no ink" —
and that fix cured load-time too.

What survives is the ticket's Fix section: stop inheriting upstream's
2010-era 12 MB default now that networking exists. `set_defaults` (the
enable_javascript seam — chosen over patching `desktop/*`, which would
grow patches/netsurf.diff for no need) sets `memory_cache_size` 64 MB ⇒
16 MB image cache. Rationale: the ceiling gates RETENTION — one modern
image over it forces a full re-decode on every expose after the ~10 s
clean. Cost: a ceiling, not a preallocation; worst case +52 MB while
content fills it, inside the growable wasm heap. Behaviour above the new
ceiling: renders anyway (measured semantics), retention just shrinks.
Rejected design: a size-derived/eviction-policy rework — forks upstream
cache code for no measured failure. Acceptance: new `big.html` leg in
`test_netsurf_content_e2e` (in-test PNG encoder; striped so partial
decodes can't fake counts). Red control: truncated IDAT ⇒ both ink legs
FAIL (7200/465600); reverted; 30/30 green.

## #173 — wmctl shot crop rect

Premise verified: `shot_to_ppm` holds the whole RGBA surface in userspace,
so the crop is wmctl-only (no kernel/WMP change, as the 0386 §4.3 design
said). `shot SID|screen [FILE [X Y W H]]`: rect clamped to the surface,
clamp-to-empty refuses loudly (stderr + exit 1, no file), operands through
`need_i32` (#501 discipline), two-arg shot byte-identical. Consumer:
`pollStableRegion` in the mutation e2e settles the FIELD BAND while the
tick region repaints — the two small-ticky TRUE-settle sleeps
(`sleep 6`/`sleep 8`) became region settles (the tick is still live when
they complete: typing ends ~4 s into the 7.5 s tick run). Deliberately NOT
converted: the big-page arms (bt2/bu2) — their vprobe asserts read
whole-frame mirror rows with unpinned geometry; noted in place as the
follow-on. Acceptance: exact-crop byte-equality against an independently
shot full frame on the settled static page + dims check + loud empty
refusal. Red control: a 1-px x-shift of the crop rect ⇒ byte-equality
FAILs with diff=574; reverted; full file green.

## #438 — os-touch 9.5-min stall: DID NOT REPRODUCE (findings)

Ran it as scoped: 1× alone (pass, 37.5 s — the historical average) and 3×
under `--under-load` ×10 (3/3 stable, ~39 s each). Mechanism analysis from
source: every harness wait in the file is bounded (waitOut 20–60 s,
waitPixel/waitScreen 30 s, waitForServer 120 s loud, in-file Date.now()
loops 20 s) — so a ≥9.5-minute SILENT freeze cannot be a helper timeout;
the only unbounded awaits are raw protocol calls (`page.evaluate`,
`keyboard.type/press`, and the raw CDPSession `Input.dispatchTouchEvent` —
os-touch is the only member driving raw CDP touch). Playwright puts no
timeout on those: a transiently wedged renderer/kernel-worker parks the
await forever with zero output, which matches the symptom exactly.
Recommended (not implemented — would be a speculative harness-wide change
on an unreproduced intermittent): a watchdog/timeout wrapper for protocol
awaits in the browser harness, and a run-start marker in summary.json so a
killed run leaves a trace (the ticket's third bullet; same class as
#167/#431).

**Out-of-fence finding (report, no fix):** 12 sweep members share 4 fixed
ports — 3199: os-drop/os-gdi/os-screen/os-user32; 3197:
os-gpubox/os-shell/os-quake/os-term; 3226: os-ctxmenu/os-snap; 3207:
os-sounds/os-paint. Safe only under -j1 AND clean server deaths; a
lingering serve.js (slow SIGTERM death, or an orphan from a killed run)
lets `waitForServer` take a 200 from the STALE server and run the next
same-port file against the wrong tree. The sweep preflight catches
orphans at sweep START, not mid-sweep. Batch I's os-doompage pair
(3176/3177) is the same class.
