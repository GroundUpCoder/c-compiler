#!/usr/bin/env node
// THE FILE GADGET OF /bin/netsurf (todos/0433).
//
// A click on <input type=file> used to reach gui_factory's EMPTY default:
// the gucOS window table supplied no file_gadget_open.  The fix routes the
// click to an OUT-OF-PROCESS picker — /bin/filepick, a new win32 app around
// one comdlg32 GetOpenFileNameW — because netsurf is SDL-native and the
// win32 modal pump cannot run in its process.  Protocol: accepted absolute
// path + '\n' on stdout (exit 0), cancel = no output (exit 1).  The browser
// reaps on SIGCHLD (flag-then-park) and applies the pick through
// browser_window_set_gadget_filename, gated on content identity; destroy
// and GW_EVENT_NEW_CONTENT kill a live picker.
//
// Coverage (the four design cases, plus the teardown-on-navigate rule):
//
//   open     a click on the gadget raises the "File Upload" dialogue (a
//            real window, served by the picker's own agent socket), and a
//            SECOND gadget click while it lives is IGNORED — proven by the
//            cancel leg's nowin wait, which would time out if a second
//            picker had spawned.
//   cancel   Cancel closes the dialogue and fires NO event and no value:
//            the js.log snapshot taken after this leg must hold no INPUT
//            marker, and the final log holds exactly ONE (the later
//            choose's) — the cancel provably touched nothing.
//   choose   a TYPED absolute path (the design's "typed path: in") + Open
//            closes the dialogue, fires the DOM `input` event with the
//            gadget value (the page listener logs INPUT:<value> to the
//            console, which is netsurf's stderr), and repaints the
//            gadget's displayed value (asserted as pixels inside the
//            measured gadget box).
//   lastdir  a re-open starts at the directory of the last ACCEPTED pick
//            (the Windows rule): the read-only Directory field reads
//            /root/fi after choosing /root/fi/deep.txt.  First opens start
//            at $HOME — the measure session's tree leg pins '/root'.
//   submit   the form is method=GET; submitting carries the gadget VALUE
//            in the query string (the result page logs location.search).
//            The submit happens with the lastdir leg's picker still OPEN,
//            which also pins the navigation teardown: GW_EVENT_NEW_CONTENT
//            kills the picker, so its window must VANISH without a click.
//            The file-BYTES half (multipart POST) needs an http fetcher:
//            todos/0437, not here.
//
// GEOMETRY IS MEASURED, NEVER DERIVED FROM FONT MATH: the gadget and the
// submit button carry probe background colours; a first session shoots the
// page and Node reads their extents out of the PNG, then a second session
// replays with computed coordinates (the select-e2e pattern).
//
// Run: node tests/kernel/test_netsurf_filegadget_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { parsePng } = require('../lib/png.js');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* must match gucos/gui.c STATUS_H */
const STATUS_H = 18;

/* probe colours: must match vendor/netsurf/test/file-input.html */
const C_GADGET = [200, 30, 90];
const C_SUBMIT = [40, 90, 160];

/* ---- seed boot, then plant the committed test pages ------------------ */
const { dir: tmp, image } = freshImage('os-nsfile-');
driveBoot('true', { image });

{
  const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const rootStore = new COMMON.NodeFileStore(fs, image.slice(0, -4) + '-root.img', false);
  const rfs = BLOCK_FS.createV4(rootStore);
  const W = 0x40 | 0x200 | 1; /* O_CREAT|O_TRUNC|O_WRONLY */
  rfs.mkdir('/root/fi', 0o755);
  for (const f of ['file-input.html', 'file-input-result.html']) {
    const bytes = fs.readFileSync(path.join(ROOT, 'vendor/netsurf/test', f));
    const fd = rfs.open('/root/fi/' + f, W, 0o644);
    rfs.write(fd, bytes, bytes.length);
    rfs.close(fd);
  }
  rootStore.flush();
  rootStore.close();
}

/* ---- shot helpers (the netsurf-e2e pattern) --------------------------- */
function parsePngs(buf, names) {
  const shots = {};
  let off = 0;
  for (const name of names) {
    let p;
    try { p = parsePng(buf, off); }
    catch (e) { throw new Error(`bad png stream at ${name}: ${e.message}`); }
    shots[name] = { w: p.w, h: p.h, data: p.rgba };
    off = p.next;
  }
  return shots;
}
const px = (s, x, y) => [s.data[(y * s.w + x) * 4],
                         s.data[(y * s.w + x) * 4 + 1],
                         s.data[(y * s.w + x) * 4 + 2]];
const near = (want, tol = 6) => (p) => Math.abs(p[0] - want[0]) < tol &&
                                       Math.abs(p[1] - want[1]) < tol &&
                                       Math.abs(p[2] - want[2]) < tol;
/* bounding extent of a probe colour (count + box) */
function colourExtent(s, want) {
  const p = near(want);
  let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < s.h - STATUS_H; y++) {
    for (let x = 0; x < s.w; x++) {
      if (p(px(s, x, y))) {
        n++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return { n, x0, y0, x1, y1 };
}
function regionDiffers(a, b, x0, y0, x1, y1) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const pa = px(a, x, y), pb = px(b, x, y);
      if (pa[0] !== pb[0] || pa[1] !== pb[1] || pa[2] !== pb[2]) return true;
    }
  }
  return false;
}

/* post-load settle: shot until two consecutive frames match */
const pollStable = (sid, out) => [
  `wmctl shot ${sid} ${out}`,
  `for i in $(seq 1 100); do sleep 0.1; wmctl shot ${sid} /root/poll.png; ` +
  `cmp -s /root/poll.png ${out} && break; cp /root/poll.png ${out}; done`,
];
const sidOf = (v, title) => `${v}=$(wmctl list | grep "\t${title}$" | sed "s/[^0-9].*//")`;

/* ---- session 1: measure (and the $HOME first-open rule) --------------- */
const measureOut = driveBoot([
  'printf "deep payload\\n" > /root/fi/deep.txt',
  'netsurf /root/fi/file-input.html 2>/root/js.log &',
  'wmctl wait win NsFile 30000',
  sidOf('K', 'NsFile'),
  ...pollStable('$K', '/root/s0.png'),
  'echo shot-s0-ok',
  /* first open: the dialogue exists, is agent-served, and starts at $HOME.
   * The label wait is the agent barrier (the notepad pattern): the window
   * lists before the picker's socket serves, so tree/gettext must wait on
   * a control, not on the window. */
  'wmctl click $K 20 12',
  'wmctl wait win "File Upload" 15000 && echo picker-up',
  'wmctl wait label Open 15000',
  'echo ==tree',
  'wmctl tree',
  'echo ==cut',
  'wmctl click Cancel',
  'wmctl wait nowin "File Upload" 8000 && echo picker-gone',
  'wmctl close $K && wmctl wait gone $K 8000 && echo k-closed',
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

check('measure: shot s0 taken', measureOut.includes('shot-s0-ok'));
check('measure: the first gadget click opened the dialogue',
      measureOut.includes('picker-up'));
check('measure: Cancel closed it', measureOut.includes('picker-gone'));
check('measure: window closed', measureOut.includes('k-closed'));

/* NB not section(): `wmctl tree` opens with an `== pid N` heading, which
 * is section()'s own end-of-section delimiter — match the raw output (the
 * dialog lines are unique in this session) */
check('picker: the dialogue is the comdlg32 file dialog on its own agent',
      measureOut.includes('class=WCFileDlg') &&
      measureOut.includes("text='File Upload'"));
check('picker: the first open starts at $HOME (/root)',
      /class=EDIT id=100 [^\n]*text='\/root'/.test(measureOut),
      JSON.stringify(measureOut.match(/class=EDIT id=100 [^\n]*/)));

/* NB the measure session's gadget click at (20,12) assumes only that the
 * gadget's box reaches that point from the page's top-left corner; the
 * REPLAY session below uses the measured extents throughout. */
const back1 = driveBoot('cat /root/s0.png\n',
                        { image, encoding: null, maxBuffer: 64 * 1024 * 1024 });
const m1 = parsePngs(back1.stdout, ['s0']);

const gad = colourExtent(m1.s0, C_GADGET);
const sub = colourExtent(m1.s0, C_SUBMIT);
check('s0: the gadget probe strip is on screen', gad.n > 500,
      JSON.stringify(gad));
check('s0: the submit probe strip is on screen', sub.n > 300,
      JSON.stringify(sub));
const gadX = Math.round((gad.x0 + gad.x1) / 2);
const gadY = Math.round((gad.y0 + gad.y1) / 2);
const subX = Math.round((sub.x0 + sub.x1) / 2);
const subY = Math.round((sub.y0 + sub.y1) / 2);

/* ---- session 2: cancel / choose / lastdir / submit, replayed ---------- */
const gadgetClick = `wmctl click $K ${gadX} ${gadY}`;
const actOut = driveBoot([
  'netsurf /root/fi/file-input.html 2>/root/js.log &',
  'wmctl wait win NsFile 30000',
  sidOf('K', 'NsFile'),
  ...pollStable('$K', '/root/a0.png'),
  'echo shot-a0-ok',

  /* open + the one-picker rule + cancel.  The second gadget click MUST be
   * ignored: if it spawned a second dialogue, the nowin wait below would
   * time out (driveBoot fails the test on any wmctl wait timeout). */
  gadgetClick,
  'wmctl wait win "File Upload" 15000 && echo c-open-ok',
  'wmctl wait label Cancel 15000',
  gadgetClick,
  'wmctl click Cancel',
  'wmctl wait nowin "File Upload" 8000 && echo c-cancel-ok',
  'cp /root/js.log /root/js-after-cancel.log',

  /* choose: a typed absolute path + Open fires `input` with the value
   * (the label wait is the agent barrier for settext) */
  gadgetClick,
  'wmctl wait win "File Upload" 15000 && echo ch-open-ok',
  'wmctl wait label Open 15000',
  'wmctl settext EDIT:1 /root/fi/deep.txt',
  'wmctl click Open',
  'wmctl wait nowin "File Upload" 8000 && echo ch-accept-ok',
  'for i in $(seq 1 100); do grep -q "INPUT:" /root/js.log && break; sleep 0.1; done',
  'echo ch-marker-waited',
  /* the gadget repaints its displayed value: poll until the frame moved
   * off a0, then hand the stable frame back for the region assert */
  'for i in $(seq 1 100); do wmctl shot $K /root/ach.png; ' +
  'cmp -s /root/ach.png /root/a0.png || break; sleep 0.1; done',
  'echo shot-ach-ok',

  /* lastdir: the re-open starts at the last ACCEPTED pick's directory —
   * and this picker deliberately STAYS OPEN for the submit leg */
  gadgetClick,
  'wmctl wait win "File Upload" 15000 && echo ld-open-ok',
  'wmctl wait label Open 15000',
  'echo ==lastdir',
  'wmctl gettext EDIT:0',
  'echo ==cut',

  /* submit WITH the dialogue open: the kernel enforces no modality, so
   * the browser window still takes the click; the navigation must (a)
   * carry the gadget value in the GET query and (b) kill the picker at
   * GW_EVENT_NEW_CONTENT — the nowin wait needs no click to succeed */
  `wmctl click $K ${subX} ${subY}`,
  'wmctl wait nowin "File Upload" 8000 && echo nav-teardown-ok',
  'for i in $(seq 1 100); do grep -q "QUERY:" /root/js.log && break; sleep 0.1; done',
  'echo q-marker-waited',
  'echo ==jsfinal',
  'cat /root/js.log',
  'echo ==cut',
  'echo ==jscancel',
  'cat /root/js-after-cancel.log',
  'echo ==cut',
  'wmctl close $K && wmctl wait gone $K 8000 && echo a-closed',
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

for (const tag of ['shot-a0-ok', 'c-open-ok', 'c-cancel-ok', 'ch-open-ok',
                   'ch-accept-ok', 'ch-marker-waited', 'shot-ach-ok',
                   'ld-open-ok', 'nav-teardown-ok', 'q-marker-waited',
                   'a-closed']) {
  check(`act: ${tag}`, actOut.includes(tag));
}

/* ---- the console-log oracle ------------------------------------------ */
const jsCancel = section(actOut, 'jscancel');
const jsFinal = section(actOut, 'jsfinal');
check('cancel: NO input event and no value before the choose leg',
      !jsCancel.includes('INPUT:') && !jsCancel.includes('QUERY:'),
      JSON.stringify(jsCancel));

const inputLines = jsFinal.split('\n').filter((l) => l.includes('INPUT:'));
check('choose: exactly ONE input event fired, carrying the typed path',
      inputLines.length === 1 &&
      inputLines[0] === 'js: console: log: INPUT:/root/fi/deep.txt',
      JSON.stringify(inputLines));

check('lastdir: the re-open started at the last accepted directory',
      section(actOut, 'lastdir').trim() === '/root/fi',
      JSON.stringify(section(actOut, 'lastdir')));

const queryLines = jsFinal.split('\n').filter((l) => l.includes('QUERY:'));
const rawQuery = queryLines.length === 1
  ? queryLines[0].replace('js: console: log: QUERY:', '').replace(/^\?/, '')
  : '';
check('submit: the GET query carries the gadget VALUE (the picked path)',
      decodeURIComponent(rawQuery) === 'f=/root/fi/deep.txt',
      JSON.stringify(queryLines));

/* ---- the displayed-value repaint -------------------------------------- */
const back2 = driveBoot('cat /root/a0.png /root/ach.png\n',
                        { image, encoding: null, maxBuffer: 64 * 1024 * 1024 });
const m2 = parsePngs(back2.stdout, ['a0', 'ach']);
check('choose: the gadget repainted its displayed value',
      regionDiffers(m2.a0, m2.ach, gad.x0, gad.y0, gad.x1 + 1, gad.y1 + 1));

/* ---- done ---- */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* leave it */ }
if (failures) {
  console.log(`\nFAILED (${failures})`);
  process.exit(1);
}
console.log('\nAll netsurf file-gadget e2e checks passed');
