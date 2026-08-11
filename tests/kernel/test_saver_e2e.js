#!/usr/bin/env node
// 0096 acceptance, headless: the screensaver through the REAL /bin/wm +
// /bin/wmctl via os/boot.js. Covers: the kernel idle clock (`wmctl idle` —
// GET_IDLE/R_IDLE), the baked /usr/share/screensaver defaults, idle-raise
// from a short ~/.config/screensaver timeout (fullscreen borderless
// TOP-layer focused window, over the taskbar), the marquee animating
// (successive shots differ) on black, dismissal by screen-injected motion
// (the input the kernel stamps) with focus restored to the prior window,
// the idle clock resetting at that input (no immediate re-raise) then
// re-raising after another idle interval, `saver none` disabling both the
// idle raise and the gesture, the wmctl-saver gesture (= the Control Panel
// Preview event), the ctlpanel Screen Saver applet (radios write the store
// with carry-forward, Apply writes the timeout, Preview raises), and the
// crashed-WM story (saver refused — the saver IS policy — while `wmctl
// idle` keeps answering: the clock is mechanism).
//
// Timing: wm.c polls GET_IDLE once a second (60 frame ticks) and compares
// in whole seconds, so every wait leaves >= 2s of slack over the timeout.
//
// Run: node tests/kernel/test_saver_e2e.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { driveBoot, freshImage , readShots } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-saver-');

// Fullscreen saver shots are 1024x768 PNGs (#657): the corner-black assert
// runs host-side out of the decoded image after the boot, since a
// compressed image has no fixed byte offset per pixel. The two-shot
// `cmp` stays in-shell — libpng's fixed encoder settings make equal
// pixels equal bytes, so differing bytes still mean differing frames.

const script = [
  // ---- the mechanism: the idle clock answers from boot ----
  'wmctl idle > /root/idle0.txt && echo idle-cmd-ok',
  'cat /root/idle0.txt',
  // ---- the baked defaults ----
  'grep -q starfield /usr/share/screensaver && echo baked-default-ok',
  // ---- a short user config + a window to take focus ----
  'mkdir -p /root/.config',
  'printf "saver marquee\\ntimeout 2\\ntext HELLO\\n" > /root/.config/screensaver',
  'winbox &',
  'wmctl wait win winbox',
  // No input from here on (piped shell lines are not wm input; wmctl list
  // is a WMP query, not input) — the 2s timeout raises the saver.
  'wmctl wait win screensaver',
  'echo ==up',
  'wmctl list',
  // ---- the animation: two shots of the saver differ; corner stays black.
  'SSID=$(wmctl list | grep screensaver$ | sed "s/[^0-9].*//")',
  'wmctl shot $SSID /root/s1.png && echo shot-ok',
  'sleep 0.6',                                   // timing subject: let the marquee advance between shots
  'wmctl shot $SSID /root/s2.png',
  'cmp /root/s1.png /root/s2.png || echo anim-ok',
  // ---- dismissal: screen-injected motion is real input (it resets the
  // kernel clock AND lands on the saver window) ----
  'wmctl smove 500 300',
  'wmctl wait nowin screensaver',
  'echo ==dismissed',
  'wmctl list',
  'wmctl idle',
  // ---- no immediate re-raise (the clock reset), then re-raise ----
  'sleep 0.5',                                   // timing subject: prove no immediate re-raise
  'echo ==calm',
  'wmctl list',
  'wmctl wait win screensaver',
  'echo ==again',
  'wmctl list',
  'wmctl smove 510 300',
  'wmctl wait nowin screensaver',
  // ---- saver none: neither the idle raise nor the gesture fires ----
  'printf "saver none\\ntimeout 1\\n" > /root/.config/screensaver',
  'sleep 4',                                     // timing subject: prove `saver none` never idle-raises
  'echo ==none',
  'wmctl list',
  'wmctl saver && echo gesture-accepted',
  'sleep 1.5',                                   // timing subject: prove the gesture raised nothing under `saver none`
  'echo ==nonegesture',
  'wmctl list',
  // ---- the gesture (= the Control Panel Preview): raise NOW ----
  'printf "saver starfield\\ntimeout 300\\n" > /root/.config/screensaver',
  'wmctl saver && echo saver-cmd-ok',
  'wmctl wait win screensaver',
  'echo ==forced',
  'wmctl list',
  'wmctl smove 520 300',
  'wmctl wait nowin screensaver',
  // ---- the ctlpanel applet: radios/Apply write the store, Preview raises.
  'ctlpanel "Screen Saver" &',
  'wmctl wait win "Screen Saver Properties"',
  'wmctl click Marquee && echo radio-clicked',
  'sleep 0.5',                                   // timing subject: radio-write store settle
  'echo ==store1',
  'cat /root/.config/screensaver',
  'wmctl settext EDIT:0 7 && wmctl click Apply && echo apply-clicked',
  'sleep 0.5',                                   // timing subject: Apply-write store settle
  'echo ==store2',
  'cat /root/.config/screensaver',
  'wmctl click Preview',
  'wmctl wait win screensaver',
  'echo ==preview',
  'wmctl list',
  'wmctl smove 530 300',
  'wmctl wait nowin screensaver',
  // ---- crashed-WM story: the gesture refuses, the clock keeps answering.
  'WMPID=$(wmctl list | grep taskbar$ | sed "s/^[0-9]*.//;s/[^0-9].*//")',
  'kill $WMPID',
  'wmctl wait nowin taskbar',
  'wmctl saver || echo saver-refused',
  'wmctl idle > /root/idle1.txt && echo idle-still-ok',
  '',
].join('\n');

const r = driveBoot(script, { image });

const out = r.stdout;
function section(name) {
  const m = out.split('==' + name + '\n');
  return m.length > 1 ? m[1].split('==')[0] : '';
}
const row = (sec, title) =>
  sec.split('\n').find(l => l.endsWith('\t' + title)) || '';
const geom = (line) => line.split('\t')[2] || '';
const flags = (line) => line.split('\t')[5] || '';
const zcol = (line) => parseInt(line.split('\t')[4], 10);

// ---- the mechanism ----
check('wmctl idle answers (GET_IDLE/R_IDLE)', out.includes('idle-cmd-ok'));
check('the baked /usr/share/screensaver defaults exist', out.includes('baked-default-ok'));

// ---- the idle raise ----
{
  const up = section('up');
  const sv = row(up, 'screensaver');
  check('idle past the timeout raises the saver, fullscreen at the origin',
    geom(sv) === '1024x768+0+0', JSON.stringify(up));
  check('the saver is borderless, top layer, and FOCUSED (keys land on it)',
    flags(sv).includes('b') && flags(sv).includes('T') && flags(sv)[0] === 'f', sv);
  const bar = row(up, 'taskbar');
  check('the saver stacks ABOVE the taskbar (the +1 band raise)',
    sv && bar && zcol(sv) > zcol(bar), sv + ' | ' + bar);
}

// ---- the animation ----
check('saver window shot written', out.includes('shot-ok'));
check('successive shots differ (the marquee animates)', out.includes('anim-ok'));
{
  const { s1 } = readShots(tmp, { s1: 's1.png' });
  check('saver shot is the full 1024x768 window', s1.w === 1024 && s1.h === 768,
    `${s1.w}x${s1.h}`);
  check('the saver background is black',
    String(s1.px(2, 2).slice(0, 3)) === '0,0,0', String(s1.px(2, 2)));
}

// ---- dismissal + clock reset ----
{
  const d = section('dismissed');
  check('screen-injected motion dismisses the saver',
    row(d, 'screensaver') === '', JSON.stringify(d));
  check('focus returns to the previously focused window',
    flags(row(d, 'winbox'))[0] === 'f', row(d, 'winbox'));
  check('no immediate re-raise (the input reset the idle clock)',
    row(section('calm'), 'screensaver') === '', JSON.stringify(section('calm')));
  check('a fresh idle interval re-raises it',
    geom(row(section('again'), 'screensaver')) === '1024x768+0+0',
    JSON.stringify(section('again')));
}

// ---- saver none ----
check('saver none: the idle raise is disabled',
  row(section('none'), 'screensaver') === '', JSON.stringify(section('none')));
check('saver none: the gesture is accepted but raises nothing',
  out.includes('gesture-accepted') &&
  row(section('nonegesture'), 'screensaver') === '',
  JSON.stringify(section('nonegesture')));

// ---- the gesture ----
check('wmctl saver accepted', out.includes('saver-cmd-ok'));
check('wmctl saver raises the configured saver immediately',
  geom(row(section('forced'), 'screensaver')) === '1024x768+0+0',
  JSON.stringify(section('forced')));

// ---- the ctlpanel applet ----
check('Marquee radio clicked via the agent tree', out.includes('radio-clicked'));
{
  const store1 = section('store1');
  check('the radio wrote saver=marquee, preserving the other USER key (CS3 delta)',
    /saver\tmarquee/.test(store1) && /timeout[ \t]300/.test(store1), JSON.stringify(store1));
  const store2 = section('store2');
  check('Apply wrote timeout=7, preserving the saver choice (CS3 delta)',
    /timeout\t7\n/.test(store2) && /saver\tmarquee/.test(store2), JSON.stringify(store2));
}
check('the applet Preview raises the saver (WMP SAVER)',
  geom(row(section('preview'), 'screensaver')) === '1024x768+0+0',
  JSON.stringify(section('preview')));

// ---- no WM ----
check('wmctl saver with no WM is refused (the saver IS policy)',
  out.includes('saver-refused'));
check('wmctl idle still answers with no WM (the clock is mechanism)',
  out.includes('idle-still-ok'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\nsaver e2e: ${failures} FAILED` : '\nsaver e2e: PASS');
