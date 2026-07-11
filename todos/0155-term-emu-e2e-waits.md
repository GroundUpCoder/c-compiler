# 0155 — Retire remaining kernel e2e sleeps: term tty-render waits + audit emulator/misc timing-subjects (0083 residue)

- **Status**: open
- **Design**: this file (spawned from `todos/0083`)

## Goal

The tail of the 0083 sleep-sync sweep that is neither pure-WM (done in 0083)
nor win32-agent-tree (0154):

- `test_term_e2e.js` (22 sleeps): `/bin/term` is a WM window (`wait win term`
  covers spawn), but most sleeps wait for **in-terminal freetype rendering /
  hush output** reflected only in `wmctl shot` pixels. Needs a tty-output or
  surface-`seq` observable (the 0083 `wait seq SID N` may suffice for
  "repainted since baseline" if the test captures a baseline seq first).
- Emulator / SDL-app e2es — `test_sameboy_e2e.js` (5), `test_punes_e2e.js` (5),
  `test_mgba_e2e.js` (2), `test_gpubox_dawn_e2e.js` (5), `test_os_apps_e2e.js`
  (3), `test_cairo_e2e.js` (3), `test_os_boot.js` (2): these sleeps largely let
  a fixed number of frames render before a pixel shot — genuine **timing
  subjects** with no cheap observable. The work here is mostly to AUDIT each,
  convert the few window-spawn sleeps to `wait win`, and annotate the rest as
  timing subjects so the "no bare sync sleep" invariant is clean and greppable.

## Plan

- term: capture `wmctl` frame_seq baselines and convert the post-input render
  settles to `wait seq $SID <baseline+1>` where a single repaint is the signal;
  keep the multi-frame animation settles as annotated timing subjects.
- emulators/misc: convert spawn sleeps to `wait win <title>`; annotate the
  frame-render settles `// timing subject`.

## Acceptance

- Every remaining `sleep N` in these files is either an event-based `wmctl wait`
  or an annotated timing subject; no bare synchronization sleeps remain.
- The full kernel suite stays green.
