#!/usr/bin/env node
// #423 acceptance, headless: the WMP screen-path KEYBOARD verb — real wmKey
// chord traversal without a browser (the todos/0095 INJECT_SCREEN keyboard
// analogue). The REAL /bin/wm + /bin/wmctl through os/boot.js:
//   - `wmctl skey 41 27 64` (Ctrl+Esc) enters the kernel's wmKey grab table
//     -> EV_MENU -> wm.c opens the Start menu; a second chord toggles it
//     away. This chord is IMPOSSIBLE via `wmctl key`: WMP_INJECT_KEY
//     delivers straight to one window and bypasses wmKey by design. That
//     bypass is pinned as the control, FIRST: the same chord bytes through
//     `wmctl key` must NOT open the menu — if a regression ever routed
//     INJECT_KEY through wmKey, the control chord would pre-toggle the menu,
//     the skey chord below would close it, and the startmenu wait would fail
//     loud (no nap, no expected-timeout wait).
//   - `wmctl skeydown`/`skeyup` drive one edge each (EV_MENU fires on the
//     keydown edge; the up completes the both-edge swallow).
//   - Alt+Tab (`wmctl skey 43 9 256`) cycles focus between two real windows
//     through wm.c's LRU walk.
//
// Run: node tests/kernel/test_skey_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-skey-');

const r = driveBoot([
  'winbox &',
  'wmctl wait win winbox',
  'WSID=$(wmctl list | grep winbox$ | sed "s/[^0-9].*//")',
  'winbox fixed &',
  'wmctl wait win fixbox',
  'FSID=$(wmctl list | grep fixbox$ | sed "s/[^0-9].*//")',
  'wmctl wait flag $FSID f',            // last-launched holds focus
  // The bypass control (see header): same chord bytes, per-window path.
  'wmctl key $FSID 41 27 64 && echo bypass-sent',
  // The real chord: Ctrl+Esc through wmKey -> grab table -> EV_MENU -> wm.c.
  'wmctl skey 41 27 64',
  'wmctl wait win startmenu',
  'echo menu-open',
  'wmctl skey 41 27 64',
  'wmctl wait nowin startmenu',
  'wmctl wait flag $FSID f',            // dismiss hands focus back
  'echo menu-toggled',
  // Single-edge verbs: the keydown alone fires the chord, the up completes
  // the swallow (held-modifier composition is what the split edges are for).
  'wmctl skeydown 41 27 64',
  'wmctl wait win startmenu',
  'wmctl skeyup 41 27 64',
  'wmctl skey 41 27 64',
  'wmctl wait nowin startmenu',
  'wmctl wait flag $FSID f',
  'echo edges-ok',
  // Alt+Tab: wm.c walks the LRU forward — focus moves fixbox -> winbox.
  'wmctl skey 43 9 256',
  'wmctl wait flag $WSID f',
  'echo cycled',
], { image });

const out = r.stdout || '';
check('bypass control ran (wmctl key accepted the chord bytes)',
  out.includes('bypass-sent'), out);
check('Ctrl+Esc via skey opened the Start menu (real grab-table traversal)',
  out.includes('menu-open'), out);
check('second skey chord toggled the menu away, focus restored',
  out.includes('menu-toggled'), out);
check('skeydown fired the chord, skeyup completed the swallow',
  out.includes('edges-ok'), out);
check('Alt+Tab via skey cycled focus to winbox',
  out.includes('cycled'), out);
check('boot exited clean', r.status === 0, 'status=' + r.status + ' ' + (r.stderr || ''));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? 'FAILURES: ' + failures : 'all skey e2e checks passed');
process.exit(failures ? 1 : 0);
