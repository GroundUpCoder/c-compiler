# 0255 — R4+R5 fail-loud regression batch (comdlg32 OOM row, wm fatal_sdl) + CD34/ByteQueue nits

- **Status**: done (2026-07-17) — R4: comdlg32 `fd_refill` renders every
  short listing as a VISIBLE row, R5: wm.c fatal split into errno-bearing
  `fatal()` vs SDL-cause `fatal_sdl()`; image v115; the last two members
  of the Codex adversarial-review triage (R1 0252, R2 0252, R3 0254).
- **Design**: the 0233/0252/0254 fail-loud rule — an error path must
  report the layer that actually failed, never a silent no-op or a stale
  errno.

## Goal

Two fail-loud regressions the code-debt cleanup introduced, fixed as a
CLASS, plus four completeness nits folded in.

**R4 — comdlg32.c `fd_refill`: OOM read as an empty directory.** The
CD34 heap-scoped snapshot (`malloc(512 * sizeof(ld_ent))`) silently
skipped the whole listing on allocation failure — the listbox showed only
"../", indistinguishable from a genuinely empty dir. Same class, same
site: `list_dir()` -1 (unopenable dir) also rendered as empty, and the
512-entry snapshot cap silently dropped entry 513+ (in fd_refill AND
fileman's pane — the R3-shaped silent-truncation cousin).

**R5 — wm.c `fatal()`: "Success" on the SDL/WMP recreate paths.** The
0234 fatal helper always appends `strerror(errno)` — right for the
socket/`wmp_read` die() callers (errno IS the cause; EOF names
ECONNRESET), a lie for the EV_SCREEN recreate `make_desk`/`make_bar`
callers where SDL sets no errno: "wm: cannot recreate the desktop
window: Success" (in practice a stale "No such file or directory" from
earlier config probes). The initial-create paths printed no cause at all.

## Landed

- `os/listdir.h`: `list_dir()` returns the TRUE entry count (keeps
  counting past the fill cap) so callers can see a clipped listing;
  header comment narrowed — it is the shared walk for comdlg32 + fileman
  only; wm.c `load_entries` is the tracked 3rd member deferred to the
  menu redesign (recipe in todos/done/0250).
- `os/win32/comdlg32.c` `fd_refill`: three explicit rows —
  "(cannot allocate directory listing)" on OOM, "(cannot open directory)"
  on -1 (fileman's exact wording), "(N more entries not shown)" past the
  `FD_MAX_ENT` cap.
- `os/win32/fileman.c` `refill`: the same "(N more entries not shown)"
  marker (inert to ops: it sits at index `g_nent`, past every
  `idx < g_nent` guard), and the status strip counts the directory's
  TRUE total (`g_ntotal`), never a diagnostic row.
- `os/wm.c`: `fatal_sdl(code, what)` appends `SDL_GetError()` (or omits
  the cause when empty — never lies); the EV_SCREEN recreate AND the
  initial make_desk/make_bar paths use it; the errno-bearing socket
  callers keep `fatal()`/`die()` unchanged. All `die()` callers audited:
  every one is a socket/wmp op where errno is meaningful.
- Fold-ins: 0250 + its dev log "byte-identical" claims narrowed
  (lstat-fail skip + 255-vs-240 name width are deliberate deltas), 0246
  gained the ByteQueue `Array.shift()` O(chunks²) note (todo-only —
  host.js untouched), 0242/0244 Status frontmatter flipped open→done.

## Acceptance

- `tests/kernel/test_comdlg_diag_e2e.js` (R4, red pre-fix): list_dir
  true-count semantics in-wasm over the real header; notepad's Open
  dialog in a DELETED cwd shows the cannot-open row; a 520-entry dir
  shows exactly ../ + 512 + "(8 more entries not shown)" in the dialog
  and fileman (status says "520 object(s)"); and the OOM row is proven
  with a REAL failing malloc — tests/kernel/fixtures/oomdlg heap-ballasts
  itself on an agent WM_SETTEXT trigger under `--wasm-max-mem-pages=4096`
  (readback via `wmctl tree`; gettext can't allocate its reply on a
  starved heap, which is itself the point).
- `tests/kernel/test_wm_fatal_e2e.js` (R5, red pre-fix): the REAL
  compiled wm.c against a real kernel; `wmSetScreen(9000, 500)` forces
  the recreate failure through the kernel's genuine >8192 SURFACE_CREATE
  refusal — pre-fix stderr read "cannot recreate the desktop window: No
  such file or directory" (stale errno), post-fix
  ": SDL_CreateWindow: host failed to create a window"; a second kernel
  boots at 9000x500 to pin the initial-create path.
- Image v115; kernel suite green (78 pre-registration + the 2 new files);
  browser sweep 27/27; compiler.js + host.js untouched.
