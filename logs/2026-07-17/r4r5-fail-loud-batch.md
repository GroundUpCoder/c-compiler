# R4+R5 — the last two fail-loud regressions from the Codex triage (todos/0255)

The adversarial review of the code/arch-debt grind left two regressions
where an error path reported the wrong thing or nothing — ironic, because
the grind's whole theme (0233/0252/0254) was killing exactly that class.
Both are fixed as a class, not a line, plus four completeness nits.

## R4 — comdlg32 fd_refill: every short listing says so

The CD34 refactor replaced the 120 KB static listing buffer with a
refill-scoped `malloc` — correct — but guarded the WHOLE listing with
`if (ents) { ... }`: on OOM the dialog showed only "../", exactly an
empty directory. Auditing the site for the class found THREE silent
short-listing paths, not one:

1. **OOM** → now an explicit "(cannot allocate directory listing)" row.
2. **`list_dir()` -1** (unopenable dir) → "(cannot open directory)"
   (fileman's exact wording — it already did this; comdlg32 was the
   outlier).
3. **The 512-entry snapshot cap** → entry 513+ silently vanished, in the
   dialog AND fileman's pane. This is the R3 cfgstore shape again
   (a bounded buffer silently eating the tail), display-grade instead of
   data-loss-grade. `list_dir()` now returns the TRUE count (it keeps
   counting past the fill cap — one `if (n >= max) { n++; continue; }`),
   and both callers render "(N more entries not shown)". fileman's
   status strip also switches from `LB_GETCOUNT` to the true total, so
   a diagnostic row never inflates "N object(s)".

The marker row is inert by construction in fileman: it sits at listbox
index `g_nent`, and every selection/open/ops consumer already guards
`idx < g_nent` (`row_path` returns 0 past it).

### Proving the OOM branch with a REAL failing malloc

The interesting test-engineering problem: you can't starve a baked app's
heap from outside. The solution is `tests/kernel/fixtures/oomdlg` — a
minimal win32 app compiled at test time against the real veneer
(`os-common.js buildProject`, the mkimage pipeline) and injected into the
root volume between boots (`NodeFileStore` + `createV4` over
`os-root.img`). It opens `GetOpenFileNameW`, then on an agent
`wmctl settext oomdlg ballast` its wndproc mallocs the heap down to a
64 KiB floor (so no free block can serve the ~136 KiB snapshot, while
small allocations — the diagnostic row itself, listbox nodes, agent
replies — still work; an allocator left bone-dry couldn't render the
failure it's reporting). Determinism knob: the boot runs under
`--wasm-max-mem-pages=4096` (256 MiB cap per wasm instance; drive.js grew
a `nodeArgs` passthrough), otherwise ballast crawls toward the 4 GiB
engine limit and timing wobbles. Readback is `wmctl tree`, NOT `gettext`:
AQ_GETTEXT on the listbox must allocate its reply, which the starved heap
refuses — the tree walk reads the same text without that allocation.
That gettext-goes-quiet behavior is itself a nice artifact of the test
being real.

Red→green: pre-fix (HEAD comdlg32.c/listdir.h, image rebaked) leg A fails
outright — `capped-true-count` asserts the 520-entry dir returns 520
with a 512 buffer, pre-fix returns 512 — and legs B–D wait on rows that
never existed (driveBoot's 0171 timeout gate makes those loud). Post-fix
all 14 checks pass.

## R5 — wm.c fatal(): errno is not SDL's cause

`fatal()` (0234) always appends `strerror(errno)`. Right for every
`die()` caller — audited: all 30 are socket/wmp_read ops where errno is
meaningful (wmp_read_all names EOF as ECONNRESET). Wrong for the
EV_SCREEN recreate paths: `make_desk`/`make_bar` fail via
`SDL_CreateWindow` returning NULL, which sets `SDL_GetError()` and
touches no errno — the message read "cannot recreate the desktop window:
Success", or worse, a stale unrelated errno (in the repro it printed
"No such file or directory" left over from config probes). The
initial-create paths at main() printed no cause at all.

Split by intent: `fatal()` keeps strerror (socket callers), new
`fatal_sdl()` appends `SDL_GetError()` — and omits the suffix entirely
when SDL has no error string, because omitting is honest and appending
noise is not. Both recreate AND initial-create paths now use it (the
kickoff's "match the initial paths' truthfulness" direction, upgraded:
SDL_GetError() carries a real cause here — "SDL_CreateWindow: host
failed to create a window" — so both report it rather than both
omitting).

### Forcing the failure through the real mechanism

`tests/kernel/test_wm_fatal_e2e.js` compiles the REAL os/wm.c and runs
it as a kernel service against a real kernel (the cfgstore-e2e harness
shape). The kernel's SURFACE_CREATE genuinely rejects w > 8192, so
`kernel.wmSetScreen(9000, 500)` drives EV_SCREEN → `screen_changed` →
`make_desk` → a real SDL_CreateWindow failure → the fatal path, stderr
captured via onOutput. A second kernel constructed with
`screen: {w: 9000, h: 500}` pins the initial-create leg. Red run
(pre-fix wm.c): all three checks fail with the stale-errno line
verbatim; post-fix: PASS.

## Fold-ins

- `os/listdir.h` header: "ONE directory-listing walk" narrowed — it
  covers comdlg32 + fileman; wm.c `load_entries` is the tracked 3rd
  member deferred to the menu redesign (todos/done/0250 has the recipe).
- todos/done/0250 + the CD34 dev log: "byte-identical pre/post" was
  overstated — true over the fixture, but two deliberate deltas exist
  outside it (lstat-fail entries are skipped where the old walks showed
  the vanished name; names render to 255 chars vs the old 240
  truncation). Better behavior, not preservation; both docs now say so.
- todos/done/0246: recorded the ByteQueue `Array.shift()` O(chunks²)
  drain as a known non-blocker with the head-index+compaction improvement
  sketched. Deliberately todo-only — host.js is a JS-runtime surface
  with its own gate, wrong to ride an os/C bake commit.
- todos/done/0242 + 0244: Status frontmatter still said `open` though
  both landed; flipped to done.

## Gate

Image v115 (comdlg32/fileman/wm bake in); kernel suite 78/78 green with
all code changes, plus the two new files (registered in run.js — the
suite is an explicit list, not discovery) green through the runner;
browser sweep 27/27; compiler.js and host.js untouched — no codegen, no
SameBoy interlock.
