# /bin/deck Lane 2 — live reload, placards, seeding, tests, ship (todos/0284)

Lane 2 of the slide-presenter build (Lane 1: `deck-l1-core.md`). Delivered:
the reload-safety contract (FS_WATCH live reload + last-good + on-screen
placards), self-maximize, the seeded demo deck + `.deck` association
(image v153), the kernel e2e + browser leg, flake-gated. Lane 3 (authoring
the 013 deck in-OS) follows.

## The reload-safety contract (design §1.2 — the on-camera moment)

Verbatim mgp blueprint over `os/fswatch.h`: a PATH-keyed watch on the deck
file (survives tmp+rename-over saves), composed into the idle park via the
kernel's unified WAIT (`__wait{fd ⊕ ring}`, the `sdlx_wait_event_fd`
idiom). WAIT-first discipline: the watch is drained to EAGAIN at EVERY
frame entry (so the fd can never hot-spin the park), and reacts once on
`CLOSE_WRITE|OVERFLOW` — the mgp `wantreload()` rule; CREATE/DELETE/
SELF_GONE alone are mid-save shapes whose settle lands CLOSE_WRITE.

- **Success**: decks swap preserving the current slide **by id** (an agent
  reordering slides keeps the presenter on the slide being edited; id gone
  → index clamp). Proven by the e2e's reorder leg: `two` moves index 1→2
  and the view follows the id, not the index.
- **Failure**: the LAST-GOOD deck stays rendered under a red banner naming
  the error + parse byte offset + failing element context
  (`deck-l2-banner-hold.png`). Never blank, never lose the page.
- Warnings render as a bottom amber placard (first 3 + count,
  `deck-l2-warnings.png`) — strictness visible, never fatal. Both placards
  composite into the fit-rect canvas in present mode only; `--shot`
  goldens never see them. Everything also still prints to stderr
  (`deck: reloaded ...` / `deck: holding last-good deck` are the e2e's
  markers).
- Ctrl-R = manual reload (works where FS_WATCH is ENOSYS).
- Images re-read on EVERY present render (overwrite shows on next
  reload/nav/resize — documented v1; per-image watches stay v1.1).

## The rm_init uninitialized-bbox crash (P0-class, found in-lane)

First maximized present render trapped `memory access out of bounds` in
the frame callback — deterministic with a 640x360 deck, absent at
1280x720. No name section in the wasm, so the root-cause tool was
**rebuilding with `compilerOptions.emitNames` and mapping the trap's
function indices**: `frame_cb → render_slide → rm_init → rm_reset`.
Lane 1's `rm_init` called `rm_reset()` **before** the calloc NULL check —
on a mask whose dirty-bbox fields were still stack garbage. Any residue
resembling a non-empty rect made rm_reset memset a wild range (calloc
success or not); the maximized path merely changed the stack residue.
Fix: set the empty-rect state directly in rm_init (which also repairs the
old `dx0=dy0=0` init that pinned the min/max bbox narrowing at 0 —
composite scanned full-width rows). Pattern for the estate: **a
"reset"-style helper must never run on a partially-constructed object** —
constructors initialize fields directly.

## Self-maximize: the SDL window id is NOT the kernel sid

`SDL_GetWindowID` returns the per-process host handle (1-based). Sending
`wmctl max <that>` maximized... surface 1, the desktop → EPERM
(borderless). The kernel sid never reaches C, so deck resolves itself the
way the tests do — `system("wmctl max $(wmctl list | grep -F '<title>' |
sed ...)")` — spawned after `SDL_CreateWindow` returns; the EV_CREATED →
ACTIVATE ordering on the WM socket makes it race-free. Browser tests must
`wmctl wait dim` before reading geometry (the maximize is async; os-deck's
`waitMaxed` helper, split-needle echo per the typed-echo gotcha).

## Test gotchas worth keeping

- Piped `boot.js` keeps app fd 2 out of the tty stream: stderr asserts in
  a driveBoot test must check `r.stdout + r.stderr`.
- `boot.js --image=X/os.img` puts the ROOT volume at `X/os-root.img` —
  `rm os.img` alone resurrects stale /root state across "fresh" sessions.
- Compositor probes of the alpha-235 banner must expect the BLEND with the
  held slide color (`(c*235 + under*20)/255`), not the raw banner color.
- Golden probes on labeled boxes must dodge the centered label glyphs.

## Seeding (image v152 → v153)

`/usr/bin/deck`; `/usr/share/deck/{gucos.deck,deck-title.png}` (masters);
Demos menu entry; openwith `deck → /bin/deck` (dedicated extension — bare
`json` stays free); user-section rw copy at
`/root/Desktop/Presentations/gucOS/`; wm.c `desk_ext_map` gained
`deck → DK_DECK`. The demo deck is 4 slides (title / arch diagram /
made-with / edit-me); `deck-title.png` is the demo's own title slide
rendered by `deck --shot` and downscaled — the tool demonstrating itself
(`deck-l2-arch.png` is the diagram slide golden source).

**Deploy leg**: user-section `bin` entries fetch over HTTP at first boot,
so the external embedder's build allowlist gained a globbed
`os/deck/demo/*` copy list and its magicpoint-only seed cross-check was
generalized to every user-seeded path family (committed there, unpushed).

## Tests + gate

- `tests/kernel/test_deck_e2e.js` (registered): --validate on the seeded
  demo; --shot golden pixels on the arch slide (decoded PNG, probes for
  fills/arrow/background); broken-deck --validate exit 1 + byte offset;
  present-mode: self-maximize (`wait dim`), nav, rename-over reload with
  by-id slide preservation, broken-save hold + banner fraction, recovery,
  Ctrl-R (3rd `deck: reloaded` line), openwith via open(1), seeding
  checks. Colors asserted as dominant-fraction (the mgp precedent).
- `tests/browser/os-deck.mjs` (sweep-discovered): seeded demo maximized to
  the live work area, title ink, ArrowRight → diagram fill through the
  fit map, and the live-reload leg — external save composites (waitPixel
  as the marker, no sleeps), broken save holds under the banner, recovery
  drops it.
- Gate: kernel suite 103/104 (the one fail = test_clang_pkgs_e2e's known
  -j dist/packages race, passes isolated); flake gate stable 3/3 under
  load for BOTH new legs; targeted sweep os-shell/os-wm/os-present/
  os-boots green (menu-row model tests derive from image.json, so the new
  Demos row is absorbed).
