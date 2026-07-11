#!/usr/bin/env node
// 0105 acceptance, headless: per-surface cursor shapes + chrome resize
// cursors through the REAL kernel via os/boot.js, queried with the new
// `wmctl cursor X Y` (WMP_CURSOR_AT -> R_CURSOR). Covers:
//   - an app's SDL_SetCursor shape reads back over its client area
//     (`winbox cursor` = "curbox" claims the I-beam / TEXT = 1);
//   - a RESIZABLE frame reports the matching directional cursor
//     (right edge EW = 7, bottom NS = 8, SE corner NWSE = 5);
//   - the title bar and the desktop report the arrow (0);
//   - a FIXED-size window's frame reports the arrow (the 0024 scale-drag is
//     not advertised) and its unset client reports the arrow.
// Cursor is browser-only RENDERING (the kernel state is assertable headless,
// the 0063 glass rule); this test asserts the state, not any pixels.
//
// Run: node tests/kernel/test_cursor_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-cursor-');

// The two acceptance windows, moved to KNOWN client origins so every probe
// coordinate is deterministic (both are 240x160). curbox is resizable +
// I-beam; fixbox is fixed-size + default. They don't overlap, and (50,50)
// sits above/left of both (desktop).
const script = [
  'winbox cursor &',
  'winbox fixed &',
  'sleep 3',                                   // real wasm instantiation
  'CID=$(wmctl list | grep curbox$ | sed "s/[^0-9].*//")',
  'FID=$(wmctl list | grep fixbox$ | sed "s/[^0-9].*//")',
  'wmctl move $CID 400 300 && echo cmoved',
  'wmctl move $FID 100 100 && echo fmoved',
  'sleep 0.5',
  'echo ==geom',
  'wmctl list',
  // ---- the app's per-surface cursor over its client ----
  'echo cur-client=$(wmctl cursor 520 380)',   // curbox client center -> TEXT
  // ---- chrome resize cursors on the resizable frame ----
  'echo cur-east=$(wmctl cursor 642 380)',      // right edge (x+240+2) -> EW
  'echo cur-south=$(wmctl cursor 520 462)',     // bottom edge (y+160+2) -> NS
  'echo cur-se=$(wmctl cursor 642 462)',        // SE corner -> NWSE
  // ---- title bar + desktop -> arrow ----
  'echo cur-title=$(wmctl cursor 410 295)',     // title band (y-5) -> DEFAULT
  'echo cur-desktop=$(wmctl cursor 50 50)',     // empty desktop -> DEFAULT
  // ---- fixed-size window: frame + client both arrow ----
  'echo cur-fixframe=$(wmctl cursor 342 180)',  // fixbox right edge -> DEFAULT
  'echo cur-fixclient=$(wmctl cursor 220 180)', // fixbox client -> DEFAULT
  '',
].join('\n');

const r = driveBoot(script, { image });
const out = r.stdout;

function val(key) {
  const m = out.match(new RegExp('^' + key + '=(-?\\d+)', 'm'));
  return m ? parseInt(m[1], 10) : NaN;
}

check('both acceptance windows placed', out.includes('cmoved') && out.includes('fmoved'),
  JSON.stringify(out.split('\n').filter(l => /curbox|fixbox|moved/.test(l))));

// The app's SDL_SetCursor shape reads back over its client (SDL_SYSTEM_CURSOR_TEXT).
check('SDL_SetCursor(TEXT) shows over the app client', val('cur-client') === 1, val('cur-client'));

// Chrome resize cursors on the resizable frame (axis-pair shapes).
check('resizable right edge -> EW-resize (7)', val('cur-east') === 7, val('cur-east'));
check('resizable bottom edge -> NS-resize (8)', val('cur-south') === 8, val('cur-south'));
check('resizable SE corner -> NWSE-resize (5)', val('cur-se') === 5, val('cur-se'));

// Title bar and desktop are the plain arrow.
check('title bar -> arrow (0)', val('cur-title') === 0, val('cur-title'));
check('empty desktop -> arrow (0)', val('cur-desktop') === 0, val('cur-desktop'));

// Fixed-size window: no resize cursor on the frame, arrow over the client.
check('fixed-size frame -> arrow (0)', val('cur-fixframe') === 0, val('cur-fixframe'));
check('fixed-size unset client -> arrow (0)', val('cur-fixclient') === 0, val('cur-fixclient'));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
console.log(failures ? ('\nFAILED (' + failures + ')') : '\nPASS');
process.exit(failures ? 1 : 0);
