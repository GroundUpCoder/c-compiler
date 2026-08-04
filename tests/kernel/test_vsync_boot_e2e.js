#!/usr/bin/env node
// #424: `os/boot.js --vsync[=hz]` — the headless host drives kernel.vsyncTick()
// from a timer, so frame-paced code (host.js's frame-loop driver pacing SDL
// main-loop apps off KernelClient.vsyncWait, todos/0100/0167) is exercisable
// under the fast Node host instead of only under a real browser rAF.
//
// Legs:
//   1. flag validation — `--vsync=abc` and `--vsync=0` refuse loudly (exit 2,
//      a `bad --vsync` message naming the flag, before any image work).
//   2. pacing honesty — with `--vsync=20` a frame-loop app (real C compiled
//      by the in-OS cc, emscripten_set_main_loop-style callback) measures 30
//      frame intervals at >= 1.1s wall. The no-vsync deadline pacer runs the
//      same 30 frames at ~0.5s (60Hz), so this bound fails if the flag is
//      ignored or the pacer silently falls back — the load-bearing red.
//   3. bare `--vsync` — defaults to 60Hz: the same app completes with a sane
//      elapsed figure (ticks flow; no tick source would park vsyncWait
//      forever and the marker never appears).
//
// A plain boot (no flag) must stay byte-identical — that half is covered by
// construction: every other kernel e2e boots without the flag.
//
// Run: node tests/kernel/test_vsync_boot_e2e.js
'use strict';
const path = require('path');
const cp = require('child_process');
const { driveBoot, section } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');
const BOOT = path.join(ROOT, 'os/boot.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// ---- leg 1: flag validation (arg parse precedes all image work — no image
// needed, and a refusal that started materializing anything would hang here) --
console.log('flag validation:');
for (const bad of ['--vsync=abc', '--vsync=0', '--vsync=-5', '--vsync=9999']) {
  const r = cp.spawnSync('node', [BOOT, bad], { input: '', encoding: 'utf8', timeout: 30000 });
  check(`${bad} refused with exit 2`, r.status === 2, `status=${r.status}`);
  check(`${bad} names the flag (bad --vsync)`,
    String(r.stderr || '').includes('bad --vsync'),
    JSON.stringify(String(r.stderr || '').slice(0, 200)));
}

// ---- the frame-loop app: counts main-loop callbacks, prints the wall time
// spanning 30 frame intervals, then clears the callback to let the C exit
// path run. No window, no SDL_Init — the frame-loop driver paces any
// registered callback (host.js runModule), which is exactly the seam
// --vsync must reach.
const APP_LINES = [
  "cat > /root/frames.c << 'EOF'",
  '#include <SDL3/SDL.h>',
  '#include <stdio.h>',
  '#include <time.h>',
  'static int n = 0;',
  'static long long t0;',
  'static long long now_ms(void) {',
  '    struct timespec ts;',
  '    clock_gettime(CLOCK_MONOTONIC, &ts);',
  '    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;',
  '}',
  'static void frame(void) {',
  '    if (n == 0) t0 = now_ms();',
  '    n++;',
  '    if (n > 30) {',
  '        printf("ELAPSED %lld FRAMES %d\\n", now_ms() - t0, n - 1);',
  '        fflush(stdout);',
  '        __setAnimationFrameFunc((void (*)(void))0);',
  '    }',
  '}',
  'int main(void) {',
  '    __setAnimationFrameFunc(frame);',
  '    return 0;',
  '}',
  'EOF',
  'cd /root && cc frames.c -o frames',
];

function elapsedOf(out) {
  const m = /ELAPSED (\d+) FRAMES 30/.exec(String(out));
  return m ? Number(m[1]) : null;
}

// ---- leg 2: 20Hz pacing through the real boot ---------------------------
console.log('pacing (--vsync=20):');
const r20 = driveBoot([
  ...APP_LINES,
  'echo ==run',
  './frames',
  'echo rc=$?',
  'echo ==done',
  'exit',
], { prefix: 'os-vsync-', args: ['--vsync=20'], timeout: 600000 });
check('session exits clean', r20.status === 0,
  `status=${r20.status} stderr=${String(r20.stderr || '').slice(-300)}`);
const e20 = elapsedOf(section(r20.stdout, 'run'));
check('frame loop ran 30 frames and reported ELAPSED', e20 !== null,
  JSON.stringify(String(r20.stdout).slice(-400)));
// 30 intervals at 20Hz = ~1500ms nominal. The 60Hz deadline pacer (what runs
// when the flag is ignored) does it in ~500ms — require >= 1100ms so the
// tick TIMER is provably the pacer. Late timers only stretch this; a loose
// upper bound still catches a wedged/absurd clock without load flake.
check('30 frames at 20Hz take >= 1100ms (timer paces, not the fallback pacer)',
  e20 !== null && e20 >= 1100, `elapsed=${e20}`);
check('30 frames at 20Hz take <= 8000ms (ticks actually flow)',
  e20 !== null && e20 <= 8000, `elapsed=${e20}`);

// ---- leg 3: bare --vsync defaults to 60Hz (same image: warm reboot) ------
console.log('default hz (bare --vsync):');
const r60 = driveBoot([
  'echo ==run',
  '/root/frames',
  'echo rc=$?',
  'echo ==done',
  'exit',
], { image: r20.image, args: ['--vsync'], timeout: 600000 });
check('session exits clean', r60.status === 0,
  `status=${r60.status} stderr=${String(r60.stderr || '').slice(-300)}`);
const e60 = elapsedOf(section(r60.stdout, 'run'));
check('bare --vsync ticks at the 60Hz default (30 frames, sane elapsed)',
  e60 !== null && e60 >= 300 && e60 <= 3000, `elapsed=${e60}`);

process.exit(failures ? 1 : 0);
