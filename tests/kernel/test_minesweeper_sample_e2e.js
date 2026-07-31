#!/usr/bin/env node
// Minesweeper sample tap-to-run acceptance, headless (image v163): the ONE
// seeded file /root/Desktop/Presentations/samples/minesweeper-programming-
// rainbow.sh — the live build-from-GitHub demo — and its $TERM re-exec
// mechanism.
//
// The tap gesture is the whole point: double-click the Presentations folder
// on the desktop -> fileman opens at it (0185) -> open samples -> open the
// .sh (a #!/bin/sh file, mode 0755) -> launch_activate's runnable branch
// spawns it HEADLESS (spawn_path env is {PATH, HOME} — no TERM) -> the
// script's first line `[ -n "$TERM" ] || exec term "$0"` re-execs it into a
// TERM WINDOW (term's child env sets TERM=xterm-256color, so the second pass
// proceeds), making curl/cc progress visible. NB `[ -t 1 ]` would NOT work
// here: the system tty is interactiveOut, so even a desktop-tapped child
// sees a tty-kind fd 1.
//
// Deterministic, network-free by design: the assertions stop at "the term
// window is up (the re-exec fired) and the script is executing" (its first
// post-guard act, mkdir $HOME/minesweeper, runs before any curl). The full
// curl -> cc -> game window flow needs live GitHub and minutes of compile —
// that leg is notes/run-minesweeper-sample-demo.mjs, not this gate.
//
// Run: node tests/kernel/test_minesweeper_sample_e2e.js
'use strict';
const path = require('path');
const { driveBoot, freshImage, deskEntries, deskCell,
        userDirEntries } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
function section(out, name) {
  return (out.split('==' + name + '\n')[1] || '').split('==cut')[0];
}

const { image } = freshImage('os-mswsample-');

// The desktop grid model (drive.js): the sample lives INSIDE Presentations,
// so the top-level grid is unchanged by this seed — only the folder cell
// matters here.
const LIST = deskEntries();
const P = deskCell(LIST, 'Presentations');

const SAMPLES = '/root/Desktop/Presentations/samples';
const SH = 'minesweeper-programming-rainbow.sh';
// fileman rows are strcmp-sorted dirs-first, and BOTH folders this test
// walks are DERIVED (drive.js userDirEntries: image.json's user section +
// every baked package's seeds) rather than counted by hand. That matters:
// the netsurf-demos package seeds a folder INTO samples/, which moved the
// .sh off row 0 — a hardcoded DOWN-count would have failed as a mystery
// timeout instead of following the manifest. Selection is driven by
// KEYBOARD (click row 0 to focus the listbox, then HOME + DOWNs — the
// fileman_nav "row-height-agnostic" pattern; a computed row-center click is
// a latent off-by-one against the font-derived pitch).
const PRES_ROWS = userDirEntries('/root/Desktop/Presentations').map((e) => e.name);
const SAMPLE_ROWS = userDirEntries(SAMPLES).map((e) => e.name);
const rowOf = (rows, name, where) => {
  const i = rows.indexOf(name);
  if (i < 0) throw new Error(`${where} no longer holds "${name}" — the ` +
    `manifest/package set changed; rows are ${JSON.stringify(rows)}`);
  return i;
};
const SAMPLES_ROW = rowOf(PRES_ROWS, 'samples', 'Presentations/');
const SH_ROW = rowOf(SAMPLE_ROWS, SH, 'samples/');
// Display rows are pixel-fitted (#317): the 33-char name elides to its
// measured share of the row ("minesweeper-programming..."), so LISTBOX
// waits key on a prefix comfortably inside any plausible metric drift.
// Ops still resolve by index (g_ents), and the seed check above asserts
// the FULL name via ls.
const SH_NEEDLE = SH.slice(0, 16);
const CLICK_TOP = 'wmctl click $SID 100 40';   // inside the listbox, row 0
const HOME = 'wmctl key $SID 74 1073741898';
const DOWN = 'wmctl key $SID 81 1073741905';
const ENTER = 'wmctl key $SID 40 13';

const r = driveBoot([
  'wmctl wait win desktop 15000',

  // ---- the seed itself: ONE file, 0755, #! + the $TERM re-exec guard ----
  'echo ==seed',
  `ls -l ${SAMPLES}`,
  `head -30 ${SAMPLES}/${SH} | grep -c "exec term"`,
  `head -1 ${SAMPLES}/${SH}`,
  'echo ==cut',

  // ---- the real tap chain: desktop folder -> fileman -> the .sh ----
  'DSID=$(wmctl list | grep desktop$ | sed "s/[^0-9].*//")',
  `wmctl dblclick $DSID ${P.cx} ${P.cy}`,
  'wmctl wait win "File Manager - /root/Desktop/Pr" 15000',
  'SID=$(wmctl list | grep "File Manager" | sed "s/[^0-9].*//")',
  'wmctl wait text LISTBOX:0 samples 8000',
  CLICK_TOP, HOME, ...Array(SAMPLES_ROW).fill(DOWN),
  'wmctl wait text LISTBOX:0 "> samples" 8000',
  ENTER,
  // Focus stays on the listbox across the navigate — HOME alone selects
  // row 0. (A second click at the same spot would land inside the 400ms
  // double-click window when wmctl runs back-to-back and open the row
  // EARLY as LBN_DBLCLK — the ENTER then opens it again: two terms.)
  `wmctl wait text LISTBOX:0 "${SH_NEEDLE}" 8000`,
  HOME, ...Array(SH_ROW).fill(DOWN),
  `wmctl wait text LISTBOX:0 "> ${SH_NEEDLE}" 8000`,
  ENTER,

  // The tap spawned the script HEADLESS (no TERM in spawn_path's env); a
  // term window appearing IS the proof the $TERM re-exec guard fired.
  'wmctl wait win term 20000',
  'echo ==tapped',
  'wmctl list',
  'echo ==cut',

  // The script's first post-guard act (before any network) is mkdir
  // $HOME/minesweeper — poll the fs for it as the "script is really
  // executing in that term" marker (no wmctl condition covers an fs path;
  // bounded loud-fail loop).
  'n=0; while [ ! -d /root/minesweeper ] && [ $n -lt 60 ]; do sleep 0.5; n=$((n+1)); done',
  'echo ==msw',
  '[ -d /root/minesweeper ] && echo MSWDIR-OK',
  'echo ==cut',
], { image, timeout: 300000, maxBuffer: 64 * 1024 * 1024 });

const out = r.stdout || '';
const seed = section(out, 'seed');
check('the sample is seeded 0755, and samples/ holds exactly the derived set',
  (seed.match(/-rwxr-xr-x/g) || []).length === 1 && seed.includes(SH) &&
  SAMPLE_ROWS.every((n) => seed.includes(n)), seed + '\nrows: ' + JSON.stringify(SAMPLE_ROWS));
check('the script carries the $TERM re-exec guard',
  /^1$/m.test(seed), seed);
check('it is a #!/bin/sh script', seed.includes('#!/bin/sh'), seed);

const tapped = section(out, 'tapped');
check('single-file tap opened a term window (the $TERM re-exec fired)',
  /\bterm\b/.test(tapped), tapped);
check('script is executing in the term (mkdir landed)',
  section(out, 'msw').includes('MSWDIR-OK'), section(out, 'msw'));

process.exit(failures ? 1 : 0);
