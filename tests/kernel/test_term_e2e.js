#!/usr/bin/env node
// 0020 acceptance, headless: the wasm terminal (/bin/term — SDL surface +
// kernel pty + freetype, seeded from os/term/bin.json) runs hush on a pty
// inside a WM window, driven through os/boot.js:
//   - `term &` opens a 640x486 window (80x24 at the mono font's 8x19 cell
//     + the 30px menu bar strip on top, todos/0273c — the grid renders at
//     y offset 30, so every row-anchored pixel probe below adds GRID_Y)
//   - injected SDL keys become pty bytes: `ls /bin` renders MORE text
//     (screenshot pixel deltas prove the echo + output path)
//   - busybox vi works INSIDE the terminal: alt screen, insert, :wq — the
//     file assertion is authoritative (cat from the system shell)
//   - `wmctl resize` -> SURFACE_CONFIGURE ack (geometry changes only then)
//     -> grid reflow + TIOCSWINSZ; the post-resize shot is at the new size
//     and still renders text
//   - typing `exit` ends hush -> term reaps it and closes its window
// Shots are shm and bit-exact: the pixel assertions (counts, deltas, the
// vi status row) are deterministic — freetype is vendored at a fixed rev.
//
// Run: node tests/kernel/test_term_e2e.js
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

const { dir: tmp, image } = freshImage('os-term-');

// The 0273c menu bar: a "menubar" strip child owns the top GRID_Y px of the
// window; the grid band starts below it (shots are the term SURFACE — the
// strip child is a separate surface, so the band renders as background).
const GRID_Y = 30;

// Inject a string as SDL key events (down+up per char). SDL3 keysyms are
// modifier-applied characters, so term maps them straight to pty bytes;
// scancode 0 is fine (term reads only key/mod).
const keys = (s) => [...s].map((ch) => 'wmctl key $TSID 0 ' + ch.charCodeAt(0)).join('\n');

/* ---- session A: seed, launch term, type, vi, resize, exit ---- */
function sessionTerm() {
  const script = [
    'term &',
    'wmctl wait win term',                         // window spawn (0155)
    'sleep 2',                                     // timing subject: hush banner + prompt freetype render (multi-frame)
    'echo ==list1',
    'wmctl list',
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    'wmctl shot $TSID /root/t1.ppm && echo shot1-ok',
    keys('ls /bin\r'),
    'sleep 2',                                     // timing subject: pty echo + ls output freetype render (multi-frame)
    'wmctl shot $TSID /root/t2.ppm && echo shot2-ok',
    // vi inside the terminal. ESC is sent alone with air on both sides:
    // vi's read_key resolves a lone ESC by timeout.
    keys('vi /tmp/t.txt\r'),
    'sleep 2.5',                                   // timing subject: vi alt-screen render (multi-frame)
    'wmctl shot $TSID /root/tvi.ppm && echo shotvi-ok',
    keys('ihey from term'),
    'sleep 1.5',                                   // timing subject: insert-mode text render (multi-frame)
    keys('\x1b'),
    'sleep 1.5',                                   // timing subject: lone-ESC resolves by vi's read_key timeout
    keys(':wq\r'),
    'sleep 2.5',                                   // timing subject: write + return-to-shell render (multi-frame)
    // Drag-resize equivalent over the agent channel (the kernel path is
    // identical past the drag): reflow + TIOCSWINSZ + re-render.
    'wmctl resize $TSID 500 260',
    'wmctl wait dim $TSID 500x260',                // resize ack: SURFACE_CONFIGURE + reflow landed (0155)
    'echo ==list2',
    'wmctl list',
    'wmctl shot $TSID /root/trs.ppm && echo shotrs-ok',
    // Session teardown: hush exits -> term reaps it -> window gone.
    keys('exit\r'),
    'wmctl wait nowin term',                       // hush exits -> term reaps -> window gone (0155)
    'echo ==list3',
    'wmctl list',
    'echo ==cat',
    'cat /tmp/t.txt',
    '',
  ].join('\n');

  const a = driveBoot(script, { image, timeout: 420000 });
  const out = a.stdout;

  const list1 = (out.split('==list1\n')[1] || '').split('==')[0];
  const termRow = list1.split('\n').find((l) => l.endsWith('\tterm')) || '';
  check('term opens a WM window titled "term"', termRow !== '', JSON.stringify(list1));
  check('term window is 640x486 (80x24 at the 8x19 mono cell + the menu bar)',
    termRow.includes('640x486'), termRow);
  check('all four shots written',
    out.includes('shot1-ok') && out.includes('shot2-ok') &&
    out.includes('shotvi-ok') && out.includes('shotrs-ok'));

  const list2 = (out.split('==list2\n')[1] || '').split('==')[0];
  const termRow2 = list2.split('\n').find((l) => l.endsWith('\tterm')) || '';
  check('resize acked: geometry is 500x260 (SURFACE_CONFIGURE landed)',
    termRow2.includes('500x260'), termRow2);

  const list3 = (out.split('==list3\n')[1] || '').split('==')[0];
  check('typed exit ends the session: term window gone',
    !list3.includes('\tterm'), JSON.stringify(list3));

  const body = (out.split('==cat\n')[1] || '');
  check('vi-in-term wrote the file (insert + ESC + :wq over the pty)',
    body.startsWith('hey from term'), JSON.stringify(body.slice(0, 40)));
}

/* ---- session B: extract the PPMs byte-clean, assert rendered text ---- */
function sessionFrames() {
  const b = driveBoot('cat /root/t1.ppm /root/t2.ppm /root/tvi.ppm /root/trs.ppm\n', { image, timeout: 120000, maxBuffer: 16 * 1024 * 1024, encoding: null });

  function parsePPM(buf, off) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w = +m[1], h = +m[2], data = off + m[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }
  // Foreground = any non-black pixel (the terminal's default bg is black;
  // glyphs are light gray + antialiasing ramps).
  function fgPixels(buf, ppm, y0, y1) {
    let n = 0;
    const ya = y0 === undefined ? 0 : y0, yb = y1 === undefined ? ppm.h : y1;
    for (let y = ya; y < yb; y++) {
      for (let x = 0; x < ppm.w; x++) {
        const i = ppm.data + (y * ppm.w + x) * 3;
        if (buf[i] | buf[i + 1] | buf[i + 2]) n++;
      }
    }
    return n;
  }

  const t1 = parsePPM(b.stdout, 0);
  check('shot1 parses at 640x486', t1 && t1.w === 640 && t1.h === 486,
    t1 && `${t1.w}x${t1.h}`);
  if (!t1) return;
  const t1fg = fgPixels(b.stdout, t1);
  check('shot1 shows rendered text (hush banner + prompt)', t1fg > 1500, String(t1fg));

  const t2 = parsePPM(b.stdout, t1.end);
  check('shot2 parses at 640x486', t2 && t2.w === 640 && t2.h === 486);
  if (!t2) return;
  const t2fg = fgPixels(b.stdout, t2);
  check('ls /bin rendered more text (echo + output over the pty)',
    t2fg > t1fg + 1000, `${t1fg} -> ${t2fg}`);

  const tvi = parsePPM(b.stdout, t2.end);
  check('vi shot parses at 640x486', tvi && tvi.w === 640 && tvi.h === 486);
  if (!tvi) return;
  // The alternate screen replaced the shell: mostly empty rows of tildes +
  // the status line in the bottom cell row (cell height 18).
  const statusFg = fgPixels(b.stdout, tvi, tvi.h - 18, tvi.h);
  check('vi status line rendered in the bottom row', statusFg > 100, String(statusFg));
  const middleFg = fgPixels(b.stdout, tvi, GRID_Y + 5 * 19, GRID_Y + 6 * 19);
  check('vi cleared the shell scrollback (alt screen row is tilde-only)',
    middleFg > 0 && middleFg < 200, String(middleFg));

  const trs = parsePPM(b.stdout, tvi.end);
  check('post-resize shot parses at 500x260 (reflowed present)',
    trs && trs.w === 500 && trs.h === 260, trs && `${trs.w}x${trs.h}`);
  if (!trs) return;
  const rsfg = fgPixels(b.stdout, trs);
  check('post-resize shot still renders text', rsfg > 800, String(rsfg));
}

/* ---- session C: nested-term lifecycle (0039 follow-up, user report) ----
 * `term &` typed INSIDE a term spawns a second, independent session.
 * - Parent KILLED (SIGKILL; the close box is the same cascade): pty1's
 *   master closes -> kernel SIGHUPs the fg pgroup (the inner hush) ->
 *   hush resends SIGHUP to its jobs and exits (hush.c's documented,
 *   bash-consistent teardown) -> the child term dies too. No ghosts.
 * - Parent hush EXITS (typed exit): plain exit does NOT HUP background
 *   jobs, so the child SURVIVES its parent — orphaned (reparented to
 *   init) but fully functional: typed input still executes and the
 *   close box still reclaims it. The historical "orphaned child term
 *   wedges" report is what this session pins as fixed. */
function sessionNested() {
  const keysT = (v, s) => [...s].map((ch) => `wmctl key $${v} 0 ${ch.charCodeAt(0)}`).join('\n');
  const TROW = 'wmctl list | grep "\tterm$" | sort -n';
  const script = [
    // A: SIGKILL the parent -> the whole nested session dies
    'term &',
    'wmctl wait win term',                         // window spawn (0155)
    'sleep 2',                                     // timing subject: inner hush startup before it can read typed input
    `T1=$(${TROW} | head -n 1 | cut -f1)`,
    `P1=$(${TROW} | head -n 1 | cut -f2)`,
    keysT('T1', 'term &\r'),
    'wmctl wait count term 2',                     // the nested term's window (0155)
    `T2=$(${TROW} | tail -n 1 | cut -f1)`,
    `P2=$(${TROW} | tail -n 1 | cut -f2)`,
    'echo ==nest1',
    'wmctl list',
    'kill -9 $P1',
    'wmctl wait nowin term',                       // SIGHUP cascade tears the whole nested session down (0155)
    'echo ==nest2',
    'wmctl list',
    'kill -0 $P2 || echo nested-child-died-with-parent',
    // B: exit the parent shell -> the bg child survives, works, closes
    'term &',
    'wmctl wait win term',                         // window spawn (0155)
    'sleep 2',                                     // timing subject: inner hush startup before it can read typed input
    `T1=$(${TROW} | head -n 1 | cut -f1)`,
    keysT('T1', 'term &\r'),
    'wmctl wait count term 2',                     // the nested term's window (0155)
    `T2=$(${TROW} | tail -n 1 | cut -f1)`,
    `P2=$(${TROW} | tail -n 1 | cut -f2)`,
    keysT('T1', 'exit\r'),
    'wmctl wait count term 1',                     // parent exits -> its window closes; the orphan child survives (0155)
    'echo ==nest3',
    'wmctl list',
    'kill -0 $P2 && echo orphan-alive',
    keysT('T2', 'mkdir /qnest\r'),
    'for i in $(seq 1 120); do [ -d /qnest ] && break; sleep 0.05; done',  // orphan executes typed input (bounded poll, 0155)
    'test -d /qnest && echo orphan-responsive',
    'wmctl close $T2',
    'wmctl wait gone $T2',                          // close box reclaims the orphan (0155)
    'echo ==nest4',
    'wmctl list',
    '',
  ].join('\n');
  const c = driveBoot(script, { image, timeout: 420000 });
  const out = c.stdout;
  const sec = (n) => (out.split('==' + n + '\n')[1] || '').split('==')[0];
  const terms = (s) => s.split('\n').filter((l) => l.endsWith('\tterm')).length;
  check('nested: term-in-term brings up two term windows', terms(sec('nest1')) === 2,
    JSON.stringify(sec('nest1')));
  check('nested: SIGKILL of the parent takes the child session down (no ghosts)',
    terms(sec('nest2')) === 0 && out.includes('nested-child-died-with-parent'),
    JSON.stringify(sec('nest2')));
  check('nested: typed exit orphans the bg child — window stays up, process alive',
    terms(sec('nest3')) === 1 && out.includes('orphan-alive'),
    JSON.stringify(sec('nest3')));
  check('nested: the orphaned term still executes typed input (not wedged)',
    out.includes('orphan-responsive'), JSON.stringify(out.slice(-400)));
  check('nested: close box reclaims the orphan', terms(sec('nest4')) === 0,
    JSON.stringify(sec('nest4')));
}

/* ---- session D: less inside the terminal (todos/0035) ----
 * The pager is pure tty work over the same pty the vi leg proved: alt
 * screen in, space to page, q back to the shell. Assertions: the shell
 * regains the keyboard after q (the rc-file echo executes), rc is 0, and
 * the shot taken while less was up actually rendered the file (pixel
 * count) with a status row at the bottom. */
function sessionLess() {
  const script = [
    'seq 100 > /tmp/big.txt',
    'term &',
    'wmctl wait win term',                         // window spawn (0155)
    'sleep 2',                                     // timing subject: hush banner + prompt render before it can read typed input
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    keys('less /tmp/big.txt\r'),
    'sleep 2.5',                                   // timing subject: less alt-screen render (multi-frame)
    'wmctl shot $TSID /root/tless.ppm && echo shotless-ok',
    keys(' '),                       // space: page down inside less
    'sleep 1.5',                                   // timing subject: page-down render (multi-frame)
    keys('q'),                       // quit back to hush
    'sleep 1.5',                                   // timing subject: return-to-shell render (multi-frame)
    keys('echo lessrc=$? > /tmp/lessrc\r'),
    'for i in $(seq 1 120); do [ -s /tmp/lessrc ] && break; sleep 0.05; done',  // typed echo wrote the rc file (bounded poll, 0155)
    keys('exit\r'),
    'wmctl wait nowin term',                       // hush exits -> term reaps -> window gone (0155)
    'echo ==rc',
    'cat /tmp/lessrc',
    'echo ==done',
    '',
  ].join('\n');
  const d = driveBoot(script, { image, timeout: 420000 });
  const out = d.stdout;
  check('less shot written', out.includes('shotless-ok'), out.slice(-300));
  const rc = (out.split('==rc\n')[1] || '').split('==')[0].trim();
  check('q quits less back to the shell, exit 0 (typed echo ran at hush)',
    rc === 'lessrc=0', JSON.stringify(rc));

  // Pixel pass on the in-less shot (same parser as session B).
  const b = driveBoot('cat /root/tless.ppm\n', { image, timeout: 120000, maxBuffer: 16 * 1024 * 1024, encoding: null });
  const head = b.stdout.toString('latin1', 0, 32);
  const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
  check('less shot parses at 640x486', !!m && +m[1] === 640 && +m[2] === 486,
    JSON.stringify(head.slice(0, 16)));
  if (m) {
    const w = +m[1], h = +m[2], data = m[0].length;
    const fg = (y0, y1) => {
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < w; x++) {
          const i = data + (y * w + x) * 3;
          if (b.stdout[i] | b.stdout[i + 1] | b.stdout[i + 2]) n++;
        }
      }
      return n;
    };
    check('less rendered the file body (numbered lines fill the screen)',
      fg(0, h - 18) > 1500, String(fg(0, h - 18)));
    check('less status row rendered in the bottom cell row',
      fg(h - 18, h) > 100, String(fg(h - 18, h)));
  }
}

/* ---- session G: SGR 2 dim/faint (#304) ----
 * gcode's chrome is CDIM (\033[2m). Dim halves the resolved fg RGB at draw
 * time, so over the black default bg a dim glyph CORE is exactly half the
 * theme fg (220 -> 110) while a normal core is exactly 220 — and no AA
 * ramp of normal text can produce 110 (a*220/255 = 110 has no integer
 * alpha), so exact-value pixel counts identify each population precisely.
 * SGR 22 must clear dim (ECMA-48 normal intensity): the "BACK" tail types
 * after \033[22m and feeds the bright count. */
function sessionDim() {
  const script = [
    'term &',
    'wmctl wait win term',                         // window spawn (0155)
    'sleep 2',                                     // timing subject: hush banner + prompt freetype render (multi-frame)
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    keys("printf '\\033[2mdim dim dim dim\\033[22mBACK\\n'; echo done>/tmp/dimdone\r"),
    'for i in $(seq 1 120); do [ -s /tmp/dimdone ] && break; sleep 0.05; done',  // typed printf ran (bounded poll, 0155)
    'sleep 1.5',                                   // timing subject: freetype glyph render (multi-frame)
    'wmctl shot $TSID /root/tdim.ppm && echo shotdim-ok',
    keys('exit\r'),
    'wmctl wait nowin term',                       // hush exits -> term reaps -> window gone (0155)
    'echo ==done',
    '',
  ].join('\n');
  const d = driveBoot(script, { image, timeout: 420000 });
  check('dim shot written', d.stdout.includes('shotdim-ok'), d.stdout.slice(-300));

  const b = driveBoot('cat /root/tdim.ppm\n', { image, timeout: 120000, maxBuffer: 16 * 1024 * 1024, encoding: null });
  const head = b.stdout.toString('latin1', 0, 32);
  const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
  check('dim shot parses at 640x486', !!m && +m[1] === 640 && +m[2] === 486,
    JSON.stringify(head.slice(0, 16)));
  if (!m) return;
  const w = +m[1], h = +m[2], data = m[0].length;
  // Exact-value scan; the last 16 px columns are excluded so the 0273b
  // scrollbar overlay blends can never alias into either population.
  const countRGB = (v) => {
    let n = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w - 16; x++) {
        const i = data + (y * w + x) * 3;
        if (b.stdout[i] === v && b.stdout[i + 1] === v && b.stdout[i + 2] === v) n++;
      }
    return n;
  };
  const dimCores = countRGB(110), brightCores = countRGB(220);
  check('SGR 2 renders dim glyph cores at half theme fg (110,110,110)',
    dimCores > 40, String(dimCores));
  check('normal text (banner/prompt + post-SGR-22 tail) stays full fg (220,220,220)',
    brightCores > 200, String(brightCores));
}

/* ---- session U: Unicode (gucOS Unicode Phase A — W1/W2/W5) ----
 * Input: typed keysyms ARE code points (2-byte é, 3-byte €, 4-byte astral
 * 😀) — term UTF-8-encodes them onto the pty, hush redirects them into a
 * file, and the system-shell cat proves the exact bytes. Output: the term
 * decodes a multi-script UTF-8 stream (stateful across split pty reads)
 * into uint32 cells and renders real glyphs through the codepoint cache;
 * a CJK char the face lacks renders a tofu BOX and malformed bytes become
 * U+FFFD (never '?'). Selection copy re-encodes cell code points to UTF-8
 * into the clipboard (clip -o proves the bytes). */
function sessionUnicode() {
  // Type by CODE POINT: [...s] iterates code points, so astral chars inject
  // as one keysym (the ring word is Int32 — the host.js surrogate-pair fix
  // is browser-side; headless injection carries the code point directly).
  const keysU = (s) => [...s].map((ch) => 'wmctl key $TSID 0 ' + ch.codePointAt(0)).join('\n');
  const script = [
    // Multi-script sample seeded byte-clean from the SYSTEM shell (the
    // drive script is piped UTF-8; printf only expands the \n).
    "printf 'héllo €αλж\\n' > /tmp/uu.txt",
    'term &',
    'wmctl wait win term',                         // window spawn (0155)
    'sleep 2',                                     // timing subject: hush banner + prompt render (multi-frame)
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    'wmctl shot $TSID /root/u0.ppm && echo shotu0-ok',
    // W1: typed non-ASCII reaches the app as correct UTF-8 bytes.
    keysU('echo héllo€😀 >/tmp/u1.txt\r'),
    'for i in $(seq 1 120); do [ -s /tmp/u1.txt ] && break; sleep 0.05; done',  // typed redirect landed (bounded poll, 0155)
    'echo ==u1',
    'cat /tmp/u1.txt',
    // W2 output: real glyphs for everything the baked face covers.
    keysU('cat /tmp/uu.txt\r'),
    'sleep 2',                                     // timing subject: freetype glyph render (multi-frame)
    'wmctl shot $TSID /root/u1.ppm && echo shotu1-ok',
    // Tofu + U+FFFD: CJK the face lacks draws a box; malformed bytes
    // (invalid lead FF, stray continuation 80) become U+FFFD.
    keysU('printf "\\xe6\\xb1\\x89 \\xff\\x80 x\\n"\r'),
    'sleep 2',                                     // timing subject: tofu render (multi-frame)
    'wmctl shot $TSID /root/u2.ppm && echo shotu2-ok',
    // Selection copy: clear + print héllo at home, drag cells 0..4 of row
    // 0 (8x19 cells; BUTTON_UP does not extend, so hover supplies the
    // final motion), chord-copy, read the kernel slot from the system
    // shell. 5 cells -> 6 UTF-8 bytes.
    keysU('printf "\\033[2J\\033[H"; echo héllo\r'),
    'sleep 1.5',                                   // timing subject: clear + echo render (multi-frame)
    'wmctl down $TSID 2 39',
    'wmctl hover $TSID 38 39',
    'wmctl up $TSID 38 39',
    'wmctl key $TSID 0 67 65',                     // Ctrl+Shift+C (SDL LCTRL|LSHIFT) -> KA_COPY
    'for i in $(seq 1 120); do clip -o >/dev/null 2>&1 && break; sleep 0.05; done',  // copy landed in the kernel slot (bounded poll, 0155)
    'echo ==uclip',
    'clip -o',
    'echo ==uclipend',
    keysU('exit\r'),
    'wmctl wait nowin term',                       // hush exits -> term reaps -> window gone (0155)
    '',
  ].join('\n');
  const u = driveBoot(script, { image, timeout: 420000 });
  const out = u.stdout;

  check('unicode: all three shots written',
    out.includes('shotu0-ok') && out.includes('shotu1-ok') && out.includes('shotu2-ok'));
  const u1 = (out.split('==u1\n')[1] || '').split('==')[0];
  check('unicode: typed é/€/😀 reached the app as correct UTF-8 bytes',
    u1.startsWith('héllo€😀'), JSON.stringify(u1.slice(0, 40)));
  const clip = (out.split('==uclip\n')[1] || '').split('==uclipend')[0].replace(/\n$/, '');
  check('unicode: selection copy re-encoded cell code points to UTF-8 (clip bytes)',
    clip === 'héllo', JSON.stringify(clip));

  // Pixel pass: the Unicode output rendered real glyphs, and the tofu/
  // U+FFFD line added more (a box outline is pixel-heavy).
  const b = driveBoot('cat /root/u0.ppm /root/u1.ppm /root/u2.ppm\n',
    { image, timeout: 120000, maxBuffer: 16 * 1024 * 1024, encoding: null });
  function parsePPM(buf, off) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w = +m[1], h = +m[2], data = off + m[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }
  function fgPixels(buf, ppm) {
    let n = 0;
    for (let y = 0; y < ppm.h; y++) {
      for (let x = 0; x < ppm.w; x++) {
        const i = ppm.data + (y * ppm.w + x) * 3;
        if (buf[i] | buf[i + 1] | buf[i + 2]) n++;
      }
    }
    return n;
  }
  const p0 = parsePPM(b.stdout, 0);
  check('unicode: baseline shot parses at 640x486', p0 && p0.w === 640 && p0.h === 486);
  if (!p0) return;
  const p1 = parsePPM(b.stdout, p0.end);
  check('unicode: post-cat shot parses', !!p1);
  if (!p1) return;
  const f0 = fgPixels(b.stdout, p0), f1 = fgPixels(b.stdout, p1);
  check('unicode: é/€/α/λ/ж rendered as real glyphs (fg pixels grew)',
    f1 > f0 + 200, `${f0} -> ${f1}`);
  const p2 = parsePPM(b.stdout, p1.end);
  check('unicode: tofu shot parses', !!p2);
  if (!p2) return;
  const f2 = fgPixels(b.stdout, p2);
  check('unicode: CJK tofu box + U+FFFD rendered (fg pixels grew again)',
    f2 > f1 + 50, `${f1} -> ${f2}`);
}

/* ---- session W: double-width cells + wcwidth erase (Unicode Phase D) ----
 * A CJK code point (wcwidth 2) owns TWO terminal cells: the glyph — here
 * the 2-cell tofu box, the minimal image bakes only Noto Sans Mono — spans
 * both, the cursor advances 2, and the tty's canonical-mode ERASE echoes
 * 2x[BS SP BS] so the erase wipes BOTH cells (the kernel wcwidthCp /
 * os/wcwidth.h twin tables). */
function sessionWide() {
  const keysU = (s) => [...s].map((ch) => 'wmctl key $TSID 0 ' + ch.codePointAt(0)).join('\n');
  const script = [
    'term &',
    'wmctl wait win term',
    'sleep 2',                                     // timing subject: hush banner + prompt render (multi-frame)
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    // Wide output: clear + home, then 日 (U+65E5, 3 bytes) followed by a
    // narrow X — 日 must own cells 0+1 and X land at cell 2.
    keysU('printf "\\033[2J\\033[H\\xe6\\x97\\xa5X\\n"\r'),
    'sleep 2',                                     // timing subject: glyph render (multi-frame)
    'wmctl shot $TSID /root/w0.ppm && echo shotw0-ok',
    // Canonical-mode wide ERASE: `read` holds the tty canonical at home;
    // type 日 (tty echo renders its 2-cell tofu), then ONE Backspace —
    // the width-aware erase echo must wipe BOTH cells.
    keysU('printf "\\033[2J\\033[H"; read x; echo got:$x\r'),
    'sleep 1.5',                                   // timing subject: clear + read prompt (multi-frame)
    keysU('日'),
    'sleep 1',                                     // timing subject: echo render (multi-frame)
    'wmctl shot $TSID /root/w1.ppm && echo shotw1-ok',
    'wmctl key $TSID 0 8',                         // Backspace -> tty ERASE
    'sleep 1',                                     // timing subject: erase echo render (multi-frame)
    'wmctl shot $TSID /root/w2.ppm && echo shotw2-ok',
    keysU('ok\r'),
    keysU('exit\r'),
    'wmctl wait nowin term',
    '',
  ].join('\n');
  const w = driveBoot(script, { image, timeout: 420000 });
  check('wide: all three shots written',
    w.stdout.includes('shotw0-ok') && w.stdout.includes('shotw1-ok') &&
    w.stdout.includes('shotw2-ok'));

  const b = driveBoot('cat /root/w0.ppm /root/w1.ppm /root/w2.ppm\n',
    { image, timeout: 120000, maxBuffer: 16 * 1024 * 1024, encoding: null });
  function parsePPM(buf, off) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w2 = +m[1], h = +m[2], data = off + m[0].length;
    return { w: w2, h, data, end: data + w2 * h * 3 };
  }
  // Ink pixels of one 8x19 cell at (col, row 0) — below the menu bar band.
  function cellInk(buf, ppm, col) {
    let n = 0;
    for (let y = GRID_Y; y < GRID_Y + 19; y++) {
      for (let x = col * 8; x < col * 8 + 8; x++) {
        const i = ppm.data + (y * ppm.w + x) * 3;
        if (buf[i] | buf[i + 1] | buf[i + 2]) n++;
      }
    }
    return n;
  }
  const p0 = parsePPM(b.stdout, 0);
  check('wide: w0 parses', !!p0);
  if (!p0) return;
  const c0 = cellInk(b.stdout, p0, 0), c1 = cellInk(b.stdout, p0, 1),
        c2 = cellInk(b.stdout, p0, 2), c3 = cellInk(b.stdout, p0, 3);
  check('wide: 2-cell tofu spans cells 0 AND 1', c0 > 0 && c1 > 0, `${c0},${c1}`);
  check('wide: narrow X advanced to cell 2 (cursor moved 2)', c2 > 0, String(c2));
  check('wide: cell 3 stays blank', c3 === 0, String(c3));
  const p1 = parsePPM(b.stdout, p0.end);
  check('wide: w1 parses', !!p1);
  if (!p1) return;
  check('wide: typed CJK echo renders into the continuation cell',
    cellInk(b.stdout, p1, 1) > 0, String(cellInk(b.stdout, p1, 1)));
  const p2 = parsePPM(b.stdout, p1.end);
  check('wide: w2 parses', !!p2);
  if (!p2) return;
  check('wide: ONE erase wiped the continuation cell too',
    cellInk(b.stdout, p2, 1) === 0, String(cellInk(b.stdout, p2, 1)));
}

/* ---- session S: scrollback history ring (todos/0273a) ----
 * Lines that scroll off the top of the viewport are kept in a history ring;
 * the user scrolls UP into them with the mouse-wheel and PageUp/PageDown,
 * and new output or a keypress snaps back to the live bottom. The probe: a
 * full-width '#' marker line is printed, then `seq 300` floods it off the
 * top (it becomes the OLDEST history line). row-0 ink cleanly discriminates
 * the marker (a 40-# row, ~2000 ink px) from the live seq numbers (3 digits,
 * ~140 px). RED without the ring: PageUp/wheel are inert and row 0 stays a
 * live seq number, so the marker is never seen (verified 2026-07-23). */
function sessionScrollback() {
  const PGUP = 1073741899, PGDN = 1073741902;   // SDLK_PAGEUP / SDLK_PAGEDOWN
  const HASH = '#'.repeat(40);
  const script = [
    'term &',
    'wmctl wait win term',                         // window spawn (0155)
    'sleep 2',                                     // timing subject: hush banner + prompt render (multi-frame)
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    // clear+home, a full-ink marker line, then flood past the 24-row viewport.
    keys("printf '\\033[2J\\033[H'; printf '" + HASH + "\\n'; seq 300\r"),
    'sleep 3',                                     // timing subject: 300 lines echo + scroll (multi-frame)
    'wmctl shot $TSID /root/sb_live.ppm && echo sb-live-ok',
    // PageUp to the top of history (clamps at the oldest line = the marker).
    ...Array(20).fill('wmctl key $TSID 0 ' + PGUP),
    'sleep 1',                                     // timing subject: scrolled-view repaint (multi-frame)
    'wmctl shot $TSID /root/sb_up.ppm && echo sb-up-ok',
    // PageDown back down: clamps exactly at the live bottom.
    ...Array(20).fill('wmctl key $TSID 0 ' + PGDN),
    'sleep 1',                                     // timing subject: repaint back to live (multi-frame)
    'wmctl shot $TSID /root/sb_pgdn.ppm && echo sb-pgdn-ok',
    // Mouse-wheel up to the marker (the other scroll input, todos/0210).
    'wmctl wheel $TSID 100',
    'sleep 1',                                     // timing subject: wheel-scrolled repaint (multi-frame)
    'wmctl shot $TSID /root/sb_wheel.ppm && echo sb-wheel-ok',
    // New output snaps the view back to the live bottom (Terminal behaviour).
    keys('echo SNAPMARK\r'),
    'sleep 2',                                     // timing subject: echo output + snap repaint (multi-frame)
    'wmctl shot $TSID /root/sb_snap.ppm && echo sb-snap-ok',
    // Fractional wheel (#347): trackpads report |wheel.y| < 1 per event.
    // Print a fresh marker + a 12-line tail so the marker sits mid-screen,
    // then wheel in 0.25-notch (= 0.75-line) steps: one event cannot move
    // a line, the sum must, and the signed remainder must carry (up AND
    // back down). The marker's ROW tracks view_off exactly.
    keys("printf '" + HASH + "\\n'; seq 12\r"),
    'sleep 2',                                     // timing subject: echo + 13 lines render (multi-frame)
    'wmctl shot $TSID /root/fw0.ppm && echo fw0-ok',
    'wmctl wheel $TSID 0.25',                      // carry 0.75: below one line
    'sleep 1',                                     // timing subject: (non-)repaint settle
    'wmctl shot $TSID /root/fw1.ppm && echo fw1-ok',
    'wmctl wheel $TSID 0.25',                      // 1.5 -> 1 line up, rem 0.5
    'sleep 1',                                     // timing subject: scrolled repaint (multi-frame)
    'wmctl shot $TSID /root/fw2.ppm && echo fw2-ok',
    'wmctl wheel $TSID 0.25',                      // 0.5+0.75=1.25 -> 1 more line
    'sleep 1',                                     // timing subject: scrolled repaint (multi-frame)
    'wmctl shot $TSID /root/fw3.ppm && echo fw3-ok',
    'wmctl wheel $TSID -0.25',                     // 0.25-0.75=-0.5: no move either way
    'sleep 1',                                     // timing subject: (non-)repaint settle
    'wmctl shot $TSID /root/fw4.ppm && echo fw4-ok',
    'wmctl wheel $TSID -0.25',                     // -1.25 -> 1 line back down
    'sleep 1',                                     // timing subject: scrolled repaint (multi-frame)
    'wmctl shot $TSID /root/fw5.ppm && echo fw5-ok',
    keys('exit\r'),
    'wmctl wait nowin term',                       // hush exits -> term reaps -> window gone (0155)
    '',
  ].join('\n');
  const s = driveBoot(script, { image, timeout: 420000 });
  const out = s.stdout;
  check('scrollback: all five shots written',
    out.includes('sb-live-ok') && out.includes('sb-up-ok') &&
    out.includes('sb-pgdn-ok') && out.includes('sb-wheel-ok') &&
    out.includes('sb-snap-ok'), out.slice(-300));
  check('scrollback: all six fractional-wheel shots written (#347)',
    ['fw0', 'fw1', 'fw2', 'fw3', 'fw4', 'fw5'].every((n) => out.includes(n + '-ok')),
    out.slice(-300));

  const b = driveBoot('cat /root/sb_live.ppm /root/sb_up.ppm /root/sb_pgdn.ppm /root/sb_wheel.ppm /root/sb_snap.ppm'
    + ' /root/fw0.ppm /root/fw1.ppm /root/fw2.ppm /root/fw3.ppm /root/fw4.ppm /root/fw5.ppm\n',
    { image, timeout: 120000, maxBuffer: 64 * 1024 * 1024, encoding: null });
  function parsePPM(buf, off) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w = +m[1], h = +m[2], data = off + m[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }
  // Ink pixels of the TOP cell row (below the bar band — the 8x19 cell).
  function row0Ink(buf, ppm) {
    let n = 0;
    for (let y = GRID_Y; y < GRID_Y + 19; y++)
      for (let x = 0; x < ppm.w; x++) {
        const i = ppm.data + (y * ppm.w + x) * 3;
        if (buf[i] | buf[i + 1] | buf[i + 2]) n++;
      }
    return n;
  }
  // Row r's ink (cell rows are 19px below the GRID_Y band) — the marker's
  // ROW in a shot is the one full-ink row (>1000; seq numbers ~140).
  function markerRow(buf, ppm) {
    for (let r = 0; r < 24; r++) {
      let n = 0;
      for (let y = GRID_Y + r * 19; y < GRID_Y + (r + 1) * 19; y++)
        for (let x = 0; x < ppm.w; x++) {
          const i = ppm.data + (y * ppm.w + x) * 3;
          if (buf[i] | buf[i + 1] | buf[i + 2]) n++;
        }
      if (n > 1000) return r;
    }
    return -1;
  }
  let off = 0;
  const shots = {};
  const frows = {};
  for (const nm of ['live', 'up', 'pgdn', 'wheel', 'snap',
                    'fw0', 'fw1', 'fw2', 'fw3', 'fw4', 'fw5']) {
    const p = parsePPM(b.stdout, off);
    if (!p) { check('scrollback: ' + nm + ' shot parses', false); return; }
    if (nm.startsWith('fw')) frows[nm] = markerRow(b.stdout, p);
    else shots[nm] = row0Ink(b.stdout, p);
    off = p.end;
  }
  // The marker line is a full row of '#': ~2000 ink px. A live seq number is
  // ~140. Thresholds sit well clear of both (measured live 139, marker 1960).
  check('scrollback: live view shows a seq number at the top (not the marker)',
    shots.live < 500, `row0=${shots.live}`);
  check('scrollback: PageUp scrolls UP into history — the off-screen marker is now visible',
    shots.up > 1000, `row0=${shots.up} (live was ${shots.live})`);
  check('scrollback: PageDown returns to the live bottom (clamped)',
    shots.pgdn < 500, `row0=${shots.pgdn}`);
  check('scrollback: mouse-wheel scrolls UP into history (marker visible)',
    shots.wheel > 1000, `row0=${shots.wheel}`);
  check('scrollback: new output snaps the view back to live',
    shots.snap < 500, `row0=${shots.snap}`);

  // Fractional wheel (#347): the marker's row tracks view_off exactly —
  // each up-scrolled line pushes the visible content (and the marker) one
  // row DOWN. R = the marker's live row after the fresh print.
  const R = frows.fw0;
  const fr = JSON.stringify(frows);
  check('fractional wheel: marker visible mid-screen before the leg',
    R >= 2 && R <= 19, fr);
  check('fractional wheel: one 0.25-notch event (0.75 lines) cannot move a line',
    frows.fw1 === R, fr);
  check('fractional wheel: the second event crosses one line (carry summed)',
    frows.fw2 === R + 1, fr);
  check('fractional wheel: the 0.5-line remainder carries into the third event',
    frows.fw3 === R + 2, fr);
  check('fractional wheel: opposite sign cancels the remainder (no move)',
    frows.fw4 === R + 2, fr);
  check('fractional wheel: accumulated down-motion scrolls one line back',
    frows.fw5 === R + 1, fr);
}

/* ---- session AS: the `autoscroll` config key (#354) ----
 * Gates the OUTPUT-driven snap (drain loop) only — the keypress snap and
 * the sb_drag hold are deliberately independent and unchanged. Four arms
 * in one boot, all against the session-S marker probe (row-0 ink: ~2000
 * for the full-width '#' history marker, <500 for live content). Output
 * is produced ON DEMAND: a foreground `while ! test -f /tmp/goN` loop
 * typed into the term emits its line only when the BOOT shell touches
 * the trigger file, so no shot races a timer (0171 discipline).
 *   P1  key ABSENT (startup default): scrolled-up view snaps on output.
 *   P2  LIVE edit -> `autoscroll off` (cfgwatch reload, no restart):
 *       scrolled-up view survives new output. `touch /tmp/done2` runs in
 *       the same command list as the echo — its existence proves the
 *       output really arrived (a no-op trigger would false-pass).
 *   P3  LIVE edit -> `autoscroll 1` (the numeric spelling): snaps again.
 *   P4  drag-HOLD with autoscroll on: output mid-drag never snaps (the
 *       0273b rule composes with the new gate; in off mode it is
 *       subsumed — no snap regardless of drag).
 * RED without the feature: as4 shows live content (the off store key
 * changes nothing and the P2 output snaps the view). */
function sessionAutoscroll() {
  const PGUP = 1073741899;                        // SDLK_PAGEUP
  const HASH = '#'.repeat(40);
  const waitLoop = (n) =>
    keys('while ! test -f /tmp/go' + n + '; do sleep 0.2; done; ' +
         'echo GO' + n + '; touch /tmp/done' + n + '\r');
  const pgup20 = Array(20).fill('wmctl key $TSID 0 ' + PGUP);
  const script = [
    'term &',
    'wmctl wait win term',                         // window spawn (0155)
    'sleep 2',                                     // timing subject: hush banner + prompt render (multi-frame)
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    keys("printf '\\033[2J\\033[H'; printf '" + HASH + "\\n'; seq 300\r"),
    'sleep 3',                                     // timing subject: 300 lines echo + scroll (multi-frame)
    // --- P1: key absent (startup default on) — output snaps ---
    waitLoop(1),
    'sleep 1',                                     // timing subject: typed loop line lands (it emits nothing)
    ...pgup20,
    'sleep 1',                                     // timing subject: scrolled-view repaint (multi-frame)
    'wmctl shot $TSID /root/as1.ppm && echo as1-ok',
    'touch /tmp/go1',
    'sleep 2',                                     // timing subject: triggered echo + snap repaint (multi-frame)
    'wmctl shot $TSID /root/as2.ppm && echo as2-ok',
    // --- P2: live edit -> off; the scrolled view must survive output ---
    "printf 'autoscroll\\toff\\n' > /root/.config/term",
    'sleep 1',                                     // timing subject: FS_WATCH settled event + reload
    waitLoop(2),
    'sleep 1',                                     // timing subject: typed loop line lands
    ...pgup20,
    'sleep 1',                                     // timing subject: scrolled-view repaint (multi-frame)
    'wmctl shot $TSID /root/as3.ppm && echo as3-ok',
    'touch /tmp/go2',
    'sleep 2',                                     // timing subject: triggered echo drained (view must NOT move)
    'wmctl shot $TSID /root/as4.ppm && echo as4-ok',
    'test -f /tmp/done2 && echo done2-seen',       // the P2 output really ran
    // --- P3: live edit -> the numeric spelling `1` — snaps again ---
    "printf 'autoscroll\\t1\\n' > /root/.config/term",
    'sleep 1',                                     // timing subject: FS_WATCH settled event + reload
    waitLoop(3),                                   // typing also key-snaps back to live first (unchanged rule)
    'sleep 1',                                     // timing subject: typed loop line lands
    ...pgup20,
    'sleep 1',                                     // timing subject: scrolled-view repaint (multi-frame)
    'wmctl shot $TSID /root/as5.ppm && echo as5-ok',
    'touch /tmp/go3',
    'sleep 2',                                     // timing subject: triggered echo + snap repaint (multi-frame)
    'wmctl shot $TSID /root/as6.ppm && echo as6-ok',
    // --- P4: thumb HELD with autoscroll on — mid-drag output never snaps ---
    waitLoop(4),
    'sleep 1',                                     // timing subject: typed loop line lands
    'wmctl down $TSID 636 476',                    // grab the bottom-anchored thumb (0273b geometry)
    'wmctl hover $TSID 636 32',                    // drag to the top: clamps at the marker
    'sleep 1',                                     // timing subject: drag-scrolled repaint (multi-frame)
    'wmctl shot $TSID /root/as7.ppm && echo as7-ok',
    'touch /tmp/go4',
    'sleep 2',                                     // timing subject: triggered echo drained (drag holds the view)
    'wmctl shot $TSID /root/as8.ppm && echo as8-ok',
    'test -f /tmp/done4 && echo done4-seen',       // the P4 output really ran
    'wmctl up $TSID 636 32',
    keys('exit\r'),
    'wmctl wait nowin term',                       // hush exits -> term reaps -> window gone (0155)
    '',
  ].join('\n');
  const s = driveBoot(script, { image, timeout: 420000 });
  const out = s.stdout;
  check('autoscroll: all eight shots written',
    ['as1', 'as2', 'as3', 'as4', 'as5', 'as6', 'as7', 'as8']
      .every((n) => out.includes(n + '-ok')), out.slice(-300));
  check('autoscroll: P2 triggered output really arrived (done2)',
    out.includes('done2-seen'));
  check('autoscroll: P4 triggered output really arrived (done4)',
    out.includes('done4-seen'));

  const b = driveBoot('cat /root/as1.ppm /root/as2.ppm /root/as3.ppm /root/as4.ppm /root/as5.ppm /root/as6.ppm /root/as7.ppm /root/as8.ppm\n',
    { image, timeout: 120000, maxBuffer: 48 * 1024 * 1024, encoding: null });
  function parsePPM(buf, off) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w = +m[1], h = +m[2], data = off + m[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }
  function row0Ink(buf, ppm) {
    let n = 0;
    for (let y = GRID_Y; y < GRID_Y + 19; y++)
      for (let x = 0; x < ppm.w; x++) {
        const i = ppm.data + (y * ppm.w + x) * 3;
        if (buf[i] | buf[i + 1] | buf[i + 2]) n++;
      }
    return n;
  }
  let off = 0;
  const ink = {};
  for (const nm of ['as1', 'as2', 'as3', 'as4', 'as5', 'as6', 'as7', 'as8']) {
    const p = parsePPM(b.stdout, off);
    if (!p) { check('autoscroll: ' + nm + ' shot parses', false); return; }
    ink[nm] = row0Ink(b.stdout, p);
    off = p.end;
  }
  check('autoscroll: P1 scrolled up to the marker (key absent)',
    ink.as1 > 1000, `row0=${ink.as1}`);
  check('autoscroll: P1 output snapped the view (absent = on, the default preserved)',
    ink.as2 < 500, `row0=${ink.as2}`);
  check('autoscroll: P2 scrolled up to the marker (after the live off edit)',
    ink.as3 > 1000, `row0=${ink.as3}`);
  check('autoscroll: P2 output did NOT move the view (off, applied live — no restart)',
    ink.as4 > 1000, `row0=${ink.as4} (as3 was ${ink.as3})`);
  check('autoscroll: P3 scrolled up to the marker (after the live `1` edit)',
    ink.as5 > 1000, `row0=${ink.as5}`);
  check('autoscroll: P3 output snapped the view (numeric 1 parses as on)',
    ink.as6 < 500, `row0=${ink.as6}`);
  check('autoscroll: P4 thumb drag reached the marker (autoscroll on)',
    ink.as7 > 1000, `row0=${ink.as7}`);
  check('autoscroll: P4 mid-drag output never snapped (sb_drag hold composes)',
    ink.as8 > 1000, `row0=${ink.as8}`);
}

/* ---- session X: selection while scrolled (ticket #355) ----
 * Selection anchors are VIRTUAL (content) rows — hist_count - view_off +
 * viewport_row, the renderer's view_row space. The pre-#355 code stored
 * viewport rows as live-grid rows and hid the highlight while scrolled
 * (show_sel), so a drag over a scrolled-back line silently copied the
 * LIVE bottom rows. Three arms:
 *   X1 scrolled copy: a marker floods into history (the oldest line),
 *      PageUp to the top, drag across the marker row, Ctrl+Shift+C ->
 *      clip -o must return the MARKER text (red pre-fix: live seq
 *      digits) and the drag must render inverted cells at the dragged
 *      row (red pre-fix: show_sel suppressed them).
 *   X2 content tracking: a selection made on the live grid keeps copying
 *      the same TEXT after output pushes it into history (virt indices
 *      are content-stable), and CLEARS when the ring evicts its content
 *      — the chord becomes a no-op and a sentinel stays in the slot.
 *      scrollback=10 (startup config) makes eviction cheap.
 *   X3 RIS hygiene: ESC c (hist_clear) drops the selection — a chord
 *      after a reset must not copy stale coords. */
function sessionSelScroll() {
  const PGUP = 1073741899;                        // SDLK_PAGEUP
  const MARK = 'SEL-COPY-MARKER';
  // Drag cells 0..20 of viewport row 0 (8x19 cells; y=39 -> row 0 below
  // the GRID_Y band; BUTTON_UP does not extend, hover supplies the final
  // motion). Cols past the text are trailing blanks the copy trims.
  const dragRow0 = [
    'wmctl down $TSID 2 39',
    'wmctl hover $TSID 162 39',
    'wmctl up $TSID 162 39',
  ];
  const chord = 'wmctl key $TSID 0 67 65';        // Ctrl+Shift+C -> KA_COPY
  const clipRead = (tag) => [
    'echo ==' + tag,
    'clip -o',
    'echo ==' + tag + 'end',
  ];
  const script1 = [
    'term &',
    'wmctl wait win term',                         // window spawn (0155)
    'sleep 2',                                     // timing subject: hush banner + prompt render (multi-frame)
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    // clear+home, the marker line, then flood it off the top into history.
    keys("printf '\\033[2J\\033[H'; echo " + MARK + '; seq 300\r'),
    'sleep 3',                                     // timing subject: 300 lines echo + scroll (multi-frame)
    // PageUp clamps at the oldest history line = the marker at row 0.
    ...Array(20).fill('wmctl key $TSID 0 ' + PGUP),
    'sleep 1',                                     // timing subject: scrolled-view repaint (multi-frame)
    'wmctl shot $TSID /root/x_pre.ppm && echo x-pre-ok',
    ...dragRow0,
    'sleep 1',                                     // timing subject: selection repaint (multi-frame)
    'wmctl shot $TSID /root/x_sel.ppm && echo x-sel-ok',
    chord,
    'for i in $(seq 1 120); do clip -o >/dev/null 2>&1 && break; sleep 0.05; done',  // copy landed in the kernel slot (bounded poll, 0155)
    ...clipRead('xclip'),
    keys('exit\r'),
    'wmctl wait nowin term',                       // hush exits -> term reaps -> window gone (0155)
    '',
  ].join('\n');
  const s1 = driveBoot(script1, { image, timeout: 420000 });
  const out1 = s1.stdout;
  const grab = (out, tag) =>
    (out.split('==' + tag + '\n')[1] || '').split('==' + tag + 'end')[0].replace(/\n$/, '');
  check('selscroll: X1 both shots written',
    out1.includes('x-pre-ok') && out1.includes('x-sel-ok'), out1.slice(-300));
  check('selscroll: X1 copy while scrolled returns the marker under the cursor (not live rows)',
    grab(out1, 'xclip') === MARK, JSON.stringify(grab(out1, 'xclip')));

  // Pixel arm: the drag must add inverted cells on row 0 (the selected
  // cells' bg becomes the fg — a large nonzero-px delta over the plain
  // marker text; pre-fix show_sel hides the highlight => delta ~0).
  const b1 = driveBoot('cat /root/x_pre.ppm /root/x_sel.ppm\n',
    { image, timeout: 120000, maxBuffer: 16 * 1024 * 1024, encoding: null });
  function parsePPM(buf, off) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w = +m[1], h = +m[2], data = off + m[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }
  function row0Ink(buf, ppm) {
    let n = 0;
    for (let y = GRID_Y; y < GRID_Y + 19; y++)
      for (let x = 0; x < ppm.w; x++) {
        const i = ppm.data + (y * ppm.w + x) * 3;
        if (buf[i] | buf[i + 1] | buf[i + 2]) n++;
      }
    return n;
  }
  const pPre = parsePPM(b1.stdout, 0);
  const pSel = pPre && parsePPM(b1.stdout, pPre.end);
  if (!pPre || !pSel) { check('selscroll: X1 shots parse', false); return; }
  const inkPre = row0Ink(b1.stdout, pPre), inkSel = row0Ink(b1.stdout, pSel);
  check('selscroll: X1 scrolled selection renders inverted cells at the dragged row',
    inkSel > inkPre + 1500, `pre=${inkPre} sel=${inkSel}`);

  // X2 + X3 in a second boot with a tiny ring so eviction is cheap.
  const script2 = [
    "printf 'scrollback\\t10\\n' > /root/.config/term",
    'term &',
    'wmctl wait win term',                         // window spawn (0155)
    'sleep 2',                                     // timing subject: hush banner + prompt render (multi-frame)
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    keys("printf '\\033[2J\\033[H'; echo EV-TRACK-LINE; seq 5\r"),
    'sleep 1.5',                                   // timing subject: short output render (multi-frame)
    // Select the live EV-TRACK-LINE row, copy: the identity baseline.
    ...dragRow0,
    chord,
    'for i in $(seq 1 120); do clip -o >/dev/null 2>&1 && break; sleep 0.05; done',  // copy landed in the kernel slot (bounded poll, 0155)
    ...clipRead('evclip1'),
    // Push the selected line into history (4-5 pushes, cap 10 — no
    // eviction): the chord must still copy the SAME text (virt rows are
    // content-stable across hist_push).
    keys('seq 20\r'),
    'sleep 1.5',                                   // timing subject: 20 lines echo + scroll (multi-frame)
    chord,
    'sleep 1.5',                                   // timing subject: chord -> CLIP_SET lands (no readiness marker: the slot is already non-empty)
    ...clipRead('evclip2'),
    // Evict it (~40 more pushes past the cap of 10): the selection must
    // CLEAR — the chord is a no-op and the sentinel stays in the slot.
    'echo EV-SENTINEL | clip',
    keys('seq 40\r'),
    'sleep 2',                                     // timing subject: 40 lines echo + scroll (multi-frame)
    chord,
    'sleep 1.5',                                   // timing subject: a no-op chord has no marker; settle before reading the slot
    ...clipRead('evclip3'),
    // X3: RIS (ESC c -> hist_clear) drops the selection.
    keys("printf '\\033[2J\\033[H'; echo RIS-LINE\r"),
    'sleep 1.5',                                   // timing subject: clear + echo render (multi-frame)
    ...dragRow0,
    'echo RIS-SENT | clip',
    keys("printf '\\033c'\r"),
    'sleep 1.5',                                   // timing subject: RIS redraw (multi-frame)
    chord,
    'sleep 1.5',                                   // timing subject: a no-op chord has no marker; settle before reading the slot
    ...clipRead('risclip'),
    keys('exit\r'),
    'wmctl wait nowin term',                       // hush exits -> term reaps -> window gone (0155)
    // The image is SHARED across sessions: leave no scrollback=10 residue
    // for scrollbar/menubar/settings (they assume the startup default).
    'rm -f /root/.config/term',
    '',
  ].join('\n');
  const s2 = driveBoot(script2, { image, timeout: 420000 });
  const out2 = s2.stdout;
  check('selscroll: X2 live-view baseline copy (identity mapping)',
    grab(out2, 'evclip1') === 'EV-TRACK-LINE', JSON.stringify(grab(out2, 'evclip1')));
  check('selscroll: X2 selection follows its content into history (copy after pushes)',
    grab(out2, 'evclip2') === 'EV-TRACK-LINE', JSON.stringify(grab(out2, 'evclip2')));
  check('selscroll: X2 eviction clears the selection (chord no-op, sentinel intact)',
    grab(out2, 'evclip3') === 'EV-SENTINEL', JSON.stringify(grab(out2, 'evclip3')));
  check('selscroll: X3 RIS clears the selection (chord no-op, sentinel intact)',
    grab(out2, 'risclip') === 'RIS-SENT', JSON.stringify(grab(out2, 'risclip')));
}

/* ---- session R: side scrollbar (todos/0273b) ----
 * The 8px overlay bar at the right edge is a pure view + controller over
 * the (a) ring: hidden with no history, track (dim, 25% blend) + thumb
 * (bright, 75% blend -> channel ~150 over the black bg) once output has
 * scrolled off the top, thumb drag scrolls the view, track click pages.
 * Probes: right-edge 8px strip ink (any nonzero = bar present) and strip
 * BRIGHT pixels (>100 = thumb; the dim track never crosses it on the
 * blank right column). The (a) marker discriminates the view position:
 * a full-width '#' row (~2000 row-0 ink px) vs live seq numbers (~140,
 * +152 for the bar strip's track). RED without the bar: the strip stays
 * black and down/hover/up in the strip is inert (or starts a selection,
 * never a view change). */
function sessionScrollbar() {
  const HASH = '#'.repeat(40);
  const script = [
    'term &',
    'wmctl wait win term',                         // window spawn (0155)
    'sleep 2',                                     // timing subject: hush banner + prompt render (multi-frame)
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    // No history yet: the bar must be hidden (byte-identical right strip).
    'wmctl shot $TSID /root/bar0.ppm && echo bar0-ok',
    // Marker + flood (the session-S probe): history forms, the bar appears
    // with the thumb flush at the live bottom.
    keys("printf '\\033[2J\\033[H'; printf '" + HASH + "\\n'; seq 300\r"),
    'sleep 3',                                     // timing subject: 300 lines echo + scroll (multi-frame)
    'wmctl shot $TSID /root/bar1.ppm && echo bar1-ok',
    // Thumb drag to the top: press inside the bottom-anchored thumb
    // (window 640x486; the thumb ends at y=486 and is >=12 tall, so
    // y=476 is always inside it), drag to the grid-band top (y=32; the
    // bar strip owns y<30), release. The drag clamps at the oldest
    // line = the marker row becomes visible.
    'wmctl down $TSID 636 476',
    'wmctl hover $TSID 636 32',
    'wmctl up $TSID 636 32',
    'sleep 1',                                     // timing subject: scrolled-view repaint (multi-frame)
    'wmctl shot $TSID /root/bar2.ppm && echo bar2-ok',
    // Track click below the (now top-parked) thumb: pages DOWN one
    // viewport toward the click — the marker leaves row 0.
    'wmctl click $TSID 636 450',
    'sleep 1',                                     // timing subject: paged-view repaint (multi-frame)
    'wmctl shot $TSID /root/bar3.ppm && echo bar3-ok',
    keys('exit\r'),
    'wmctl wait nowin term',                       // hush exits -> term reaps -> window gone (0155)
    '',
  ].join('\n');
  const s = driveBoot(script, { image, timeout: 420000 });
  const out = s.stdout;
  check('scrollbar: all four shots written',
    out.includes('bar0-ok') && out.includes('bar1-ok') &&
    out.includes('bar2-ok') && out.includes('bar3-ok'), out.slice(-300));

  const b = driveBoot('cat /root/bar0.ppm /root/bar1.ppm /root/bar2.ppm /root/bar3.ppm\n',
    { image, timeout: 120000, maxBuffer: 32 * 1024 * 1024, encoding: null });
  function parsePPM(buf, off) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w = +m[1], h = +m[2], data = off + m[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }
  // Right-edge 8px strip, rows y0..y1: ink = any nonzero pixel (track OR
  // thumb), bright = any channel > 100 (thumb only — the 25% track blend
  // over the blank black right column is 32).
  function strip(buf, ppm, y0, y1, minCh) {
    let n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = ppm.w - 8; x < ppm.w; x++) {
        const i = ppm.data + (y * ppm.w + x) * 3;
        if (buf[i] > minCh || buf[i + 1] > minCh || buf[i + 2] > minCh) n++;
      }
    return n;
  }
  // Ink of the TOP cell row (below the bar band) — the session-S probe.
  function row0Ink(buf, ppm) {
    let n = 0;
    for (let y = GRID_Y; y < GRID_Y + 19; y++)
      for (let x = 0; x < ppm.w; x++) {
        const i = ppm.data + (y * ppm.w + x) * 3;
        if (buf[i] | buf[i + 1] | buf[i + 2]) n++;
      }
    return n;
  }
  let off = 0;
  const shots = {};
  for (const nm of ['bar0', 'bar1', 'bar2', 'bar3']) {
    const p = parsePPM(b.stdout, off);
    if (!p) { check('scrollbar: ' + nm + ' shot parses', false); return; }
    shots[nm] = { p };
    off = p.end;
  }
  const S = (nm, y0, y1, minCh) => strip(b.stdout, shots[nm].p, y0, y1, minCh);
  const h = shots.bar0.p.h;
  check('scrollbar: hidden with no history (right strip is pure background)',
    S('bar0', 0, h, 0) === 0, String(S('bar0', 0, h, 0)));
  check('scrollbar: appears once history exists (right strip has ink)',
    S('bar1', 0, h, 0) > 500, String(S('bar1', 0, h, 0)));
  check('scrollbar: live view parks the bright thumb at the bottom',
    S('bar1', h - 40, h, 100) > 50, String(S('bar1', h - 40, h, 100)));
  check('scrollbar: no thumb at the top while live (track only)',
    S('bar1', GRID_Y, GRID_Y + 40, 100) === 0, String(S('bar1', GRID_Y, GRID_Y + 40, 100)));
  check('scrollbar: thumb drag scrolled the view to the top (marker row visible)',
    row0Ink(b.stdout, shots.bar2.p) > 1000, String(row0Ink(b.stdout, shots.bar2.p)));
  check('scrollbar: the thumb followed the drag to the top of the track',
    S('bar2', GRID_Y, GRID_Y + 40, 100) > 50, String(S('bar2', GRID_Y, GRID_Y + 40, 100)));
  check('scrollbar: track click below the thumb pages down (marker leaves row 0)',
    row0Ink(b.stdout, shots.bar3.p) < 500, String(row0Ink(b.stdout, shots.bar3.p)));
}

/* ---- session M: menu bar (todos/0273c) ----
 * The bar is a "menubar" strip child (the 0256 kernel anchored-child
 * primitive); dropdowns are menucore-ENGINE levels — real POPUP_MENU
 * anchored children titled "#32768" (the Win32 menu window class) holding
 * the kernel grab. Everything drives the REAL path: pointer injection on
 * the bar child opens Shell, an item click on the popup child fires
 * New Window (an independent second term appears), a SCREEN press on the
 * grid exercises the kernel grab's outside-press dismissal
 * (CLOSE_REQUESTED, press consumed), Esc drives the engine's modal
 * keyboard (never the pty), and a metrics-independent hover sweep
 * switches titles to View whose "Scroll to Top" moves the (a) scrollback
 * view — the marker row appears at the grid top. RED without the bar: no
 * "menubar"/"#32768" windows exist and the driveBoot wait-timeout guard
 * fails the session. */
function sessionMenubar() {
  const HASH = '#'.repeat(40);
  const DOWN = 1073741905, ENTER = 13, ESC = 27;   // SDLK_DOWN/RETURN/ESCAPE
  const script = [
    'term &',
    'wmctl wait win term',                         // window spawn (0155)
    'sleep 2',                                     // timing subject: hush banner + prompt render (multi-frame)
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    'BSID=$(wmctl list | grep "\tmenubar$" | sed "s/[^0-9].*//")',
    'wmctl move $TSID 80 10',                      // pin screen coords for the sdown leg
    'wmctl wait seq $BSID 1 8000',                 // the strip PRESENTED its labels
    'wmctl shot $BSID /root/mb_bar.ppm && echo mb-bar-ok',
    // History for the View leg (the 0273a marker probe).
    keys("printf '\\033[2J\\033[H'; printf '" + HASH + "\\n'; seq 300\r"),
    'sleep 3',                                     // timing subject: 300 lines echo + scroll (multi-frame)
    // --- a bar click opens Shell: the dropdown is a REAL anchored child ---
    'wmctl click $BSID 20 15',
    'wmctl wait win "#32768" 8000',
    'PSID=$(wmctl list | grep "#32768" | sed "s/[^0-9].*//")',
    'wmctl wait seq $PSID 1 8000',                 // the engine painted the level
    'wmctl shot $PSID /root/mb_pop.ppm && echo mb-pop-ok',
    // --- item click: New Window (row 0) -> an independent sibling term ---
    'wmctl click $PSID 60 15',
    'wmctl wait nowin "#32768"',                   // the fire closed the chain
    'for i in $(seq 1 200); do [ $(wmctl list | grep -c "\tterm$") -ge 2 ] && break; sleep 0.05; done',  // sibling window up (bounded poll, 0155)
    'echo ==mterms',
    'wmctl list | grep -c "\tterm$"',
    // --- outside-press dismissal: the kernel grab over the full pointer path ---
    'wmctl click $BSID 20 15',
    'wmctl wait win "#32768" 8000',
    'wmctl sdown 460 320',                         // the grid at screen (80+380, 10+310): outside the popup tree
    'wmctl sup 460 320',
    'wmctl wait nowin "#32768"',                   // CLOSE_REQUESTED: chain closed, press consumed kernel-side
    // --- Esc dismissal: modal keys route to the engine, never the pty ---
    'wmctl click $BSID 20 15',
    'wmctl wait win "#32768" 8000',
    'wmctl key $TSID 0 ' + DOWN,                   // hot-row walk (engine-swallowed)
    'wmctl key $TSID 0 ' + ESC,
    'wmctl wait nowin "#32768"',
    // --- hover-switch to View (metrics-independent sweep), fire Scroll to Top ---
    'wmctl click $BSID 20 15',                     // Shell open again
    'wmctl wait win "#32768" 8000',
    ...Array.from({ length: 11 }, (_, i) => 'wmctl hover $BSID ' + (40 + i * 20) + ' 15'),
    'sleep 1',                                     // timing subject: hover-switch reopen settles (multi-frame)
    'wmctl key $TSID 0 ' + DOWN,                   // first enabled View row = Scroll to Top
    'wmctl key $TSID 0 ' + ENTER,
    'wmctl wait nowin "#32768"',
    'sleep 1',                                     // timing subject: scrolled-view repaint (multi-frame)
    'wmctl shot $TSID /root/mb_top.ppm && echo mb-top-ok',
    // Teardown: end session 1, then the New Window sibling.
    keys('exit\r'),
    'sleep 1',                                     // timing subject: term1 teardown settles before the pkill
    'pkill term',
    'wmctl wait nowin term',
    '',
  ].join('\n');
  const m = driveBoot(script, { image, timeout: 420000 });
  const out = m.stdout;
  check('menubar: bar/popup/top shots written',
    out.includes('mb-bar-ok') && out.includes('mb-pop-ok') &&
    out.includes('mb-top-ok'), out.slice(-300));
  const nterms = ((out.split('==mterms\n')[1] || '').split('\n')[0] || '').trim();
  check('menubar: New Window item spawned an independent sibling term',
    parseInt(nterms, 10) >= 2, JSON.stringify(nterms));

  const b = driveBoot('cat /root/mb_bar.ppm /root/mb_pop.ppm /root/mb_top.ppm\n',
    { image, timeout: 120000, maxBuffer: 32 * 1024 * 1024, encoding: null });
  function parsePPM(buf, off) {
    const head = buf.toString('latin1', off, off + 32);
    const m2 = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m2) return null;
    const w = +m2[1], h = +m2[2], data = off + m2[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }
  // Dark ink = all channels < 100 (label text is BTNTEXT black on the
  // BTNFACE/MENU 192-gray ground; GRAYTEXT 128 stays excluded).
  function darkInk(buf, ppm) {
    let n = 0;
    for (let y = 0; y < ppm.h; y++)
      for (let x = 0; x < ppm.w; x++) {
        const i = ppm.data + (y * ppm.w + x) * 3;
        if (buf[i] < 100 && buf[i + 1] < 100 && buf[i + 2] < 100) n++;
      }
    return n;
  }
  function row0Ink(buf, ppm) {
    let n = 0;
    for (let y = GRID_Y; y < GRID_Y + 19; y++)
      for (let x = 0; x < ppm.w; x++) {
        const i = ppm.data + (y * ppm.w + x) * 3;
        if (buf[i] | buf[i + 1] | buf[i + 2]) n++;
      }
    return n;
  }
  const pb = parsePPM(b.stdout, 0);
  check('menubar: bar strip shot parses at 640x30 (the full-width GRID_Y band)',
    pb && pb.w === 640 && pb.h === GRID_Y, pb && `${pb.w}x${pb.h}`);
  if (!pb) return;
  check('menubar: Shell/Edit/View labels rendered on the strip (dark ink)',
    darkInk(b.stdout, pb) > 80, String(darkInk(b.stdout, pb)));
  const pp = parsePPM(b.stdout, pb.end);
  check('menubar: dropdown shot parses (3 x MENU_ITEM_H rows + separator)',
    pp && pp.h >= 95 && pp.h <= 115 && pp.w >= 100 && pp.w <= 320,
    pp && `${pp.w}x${pp.h}`);
  if (!pp) return;
  check('menubar: engine-drawn item labels on the dropdown (dark ink)',
    darkInk(b.stdout, pp) > 100, String(darkInk(b.stdout, pp)));
  const pt = parsePPM(b.stdout, pp.end);
  check('menubar: Scroll-to-Top shot parses', !!pt);
  if (!pt) return;
  check('menubar: View > Scroll to Top moved the view — the marker row is at the grid top',
    row0Ink(b.stdout, pt) > 1000, String(row0Ink(b.stdout, pt)));
}

/* ---- session P: settings window + cfgstore persistence (todos/0273d) ----
 * Shell > Settings... (fired by the engine's modal keyboard — Down Down
 * Enter, metrics-independent) opens the hand-drawn "Term Settings" pane;
 * each button click applies LIVE and delta-writes ONE key to
 * /root/.config/term (cfgstore CS3). Legs: theme > flips a SECOND term's
 * band to light via the ~/.config FS_WATCH reload (cross-process live
 * apply); fontsize + re-sizes the live window off 640x486; scrollback -,
 * cursor >, bell > land in the user file; Esc closes the pane; a
 * relaunched term comes up at the SAME re-sized geometry with the light
 * band — the acceptance round-trip (change -> live -> persists). */
function sessionSettings() {
  const DOWN = 1073741905, ENTER = 13, ESC = 27;   // SDLK_DOWN/RETURN/ESCAPE
  const script = [
    'term &',
    'wmctl wait win term',                         // window spawn (0155)
    'sleep 2',                                     // timing subject: hush banner + prompt render (multi-frame)
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    'BSID=$(wmctl list | grep "\tmenubar$" | sed "s/[^0-9].*//")',
    'wmctl wait seq $BSID 1 8000',                 // the strip presented
    // --- Shell > Settings... via the engine's modal keyboard ---
    'wmctl click $BSID 20 15',
    'wmctl wait win "#32768" 8000',
    'wmctl key $TSID 0 ' + DOWN,                   // New Window
    'wmctl key $TSID 0 ' + DOWN,                   // Settings... (ungrayed, 0273d)
    'wmctl key $TSID 0 ' + ENTER,
    'wmctl wait nowin "#32768"',
    'wmctl wait win "Term Settings" 8000',
    'SSID=$(wmctl list | grep "\tTerm Settings$" | sed "s/[^0-9].*//")',
    'wmctl wait seq $SSID 1 8000',                 // the pane painted
    'echo ==setlist',
    'wmctl list | grep "\tTerm Settings$"',
    'wmctl shot $SSID /root/sset.ppm && echo sset-ok',
    // --- a second term BEFORE any change: baked defaults, watching ~/.config ---
    'term &',
    'for i in $(seq 1 200); do [ $(wmctl list | grep -c "\tterm$") -ge 2 ] && break; sleep 0.05; done',  // sibling up (bounded poll, 0155)
    'T2SID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//" | grep -v "^$TSID\\$" | head -1)',
    'sleep 2',                                     // timing subject: term2 banner render + its config watch armed
    // --- Theme > (dark -> light): pane term applies direct, term2 via FS_WATCH ---
    'wmctl click $SSID 281 56',                    // row 1 cycler > (244/270 x 22-tall boxes)
    'sleep 2',                                     // timing subject: cross-process watch reload + repaint (multi-frame)
    'wmctl shot $T2SID /root/st2.ppm && echo st2-ok',
    // --- Font Size + (14 -> 15): window re-sizes, SAME 80x24 grid ---
    'wmctl click $SSID 281 22',                    // row 0 stepper +
    'for i in $(seq 1 100); do wmctl list | grep "^$TSID\t" | grep -q 640x486 || break; sleep 0.1; done',  // re-size ack (bounded poll, 0155)
    'echo ==t1row',
    'wmctl list | grep "^$TSID\t"',
    // --- Scrollback - (2000 -> 1500), Cursor > (block -> under), Bell > (sound -> visual) ---
    'wmctl click $SSID 255 90',                    // row 2 stepper -
    'wmctl click $SSID 281 124',                   // row 3 cycler >
    'wmctl click $SSID 281 158',                   // row 4 cycler >
    'sleep 1',                                     // timing subject: the last delta-write's tmp+rename settles
    'echo ==cfg',
    'cat /root/.config/term',
    // --- Esc on the pane's windowID closes it (never reaches the pty) ---
    'wmctl key $SSID 0 ' + ESC,
    'wmctl wait nowin "Term Settings"',
    // --- relaunch: startup loads ~/.config/term (the persistence round-trip) ---
    'pkill term',
    'wmctl wait nowin term',
    'term &',
    'wmctl wait win term',
    'sleep 2',                                     // timing subject: banner render at the persisted config (multi-frame)
    'T3SID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    'echo ==t3row',
    'wmctl list | grep "^$T3SID\t"',
    'wmctl shot $T3SID /root/st3.ppm && echo st3-ok',
    'pkill term',
    'wmctl wait nowin term',
    '',
  ].join('\n');
  const s = driveBoot(script, { image, timeout: 420000 });
  const out = s.stdout;

  const setrow = ((out.split('==setlist\n')[1] || '').split('\n')[0] || '');
  check('settings: "Term Settings" opened at 300x192 via Shell > Settings...',
    setrow.includes('300x192'), setrow);
  check('settings: pane/term2/relaunch shots written',
    out.includes('sset-ok') && out.includes('st2-ok') &&
    out.includes('st3-ok'), out.slice(-300));
  const t1row = ((out.split('==t1row\n')[1] || '').split('\n')[0] || '');
  const t1dims = (t1row.match(/\d+x\d+/) || [''])[0];
  check('settings: Font Size + re-sized the live window off 640x486',
    t1dims !== '' && t1dims !== '640x486', t1row);
  const cfgTxt = (out.split('==cfg\n')[1] || '').split('==')[0];
  for (const [k, v] of [['fontsize', '15'], ['theme', 'light'],
                        ['scrollback', '1500'], ['cursor', 'under'],
                        ['bell', 'visual']])
    check('settings: user layer persisted ' + k + ' ' + v,
      new RegExp('^' + k + '\\s+' + v + '$', 'm').test(cfgTxt),
      JSON.stringify(cfgTxt.slice(0, 200)));
  const t3row = ((out.split('==t3row\n')[1] || '').split('\n')[0] || '');
  const t3dims = (t3row.match(/\d+x\d+/) || [''])[0];
  check('settings: relaunch equals the live-applied geometry (fontsize persisted)',
    t3dims === t1dims && t3dims !== '640x486', t1dims + ' vs ' + t3row);

  // Pixel pass: pane labels inked; the LIGHT band on term2 (cross-process
  // live reload) and on the relaunched term (startup load).
  const b = driveBoot('cat /root/sset.ppm /root/st2.ppm /root/st3.ppm\n',
    { image, timeout: 120000, maxBuffer: 32 * 1024 * 1024, encoding: null });
  function parsePPM(buf, off) {
    const head = buf.toString('latin1', off, off + 32);
    const m2 = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m2) return null;
    const w = +m2[1], h = +m2[2], data = off + m2[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }
  function darkInk(buf, ppm) {
    let n = 0;
    for (let y = 0; y < ppm.h; y++)
      for (let x = 0; x < ppm.w; x++) {
        const i = ppm.data + (y * ppm.w + x) * 3;
        if (buf[i] < 100 && buf[i + 1] < 100 && buf[i + 2] < 100) n++;
      }
    return n;
  }
  // Light-theme pixels (all channels >= 200) in the grid band below GRID_Y.
  function lightBand(buf, ppm) {
    let n = 0;
    for (let y = GRID_Y; y < ppm.h; y++)
      for (let x = 0; x < ppm.w; x++) {
        const i = ppm.data + (y * ppm.w + x) * 3;
        if (buf[i] >= 200 && buf[i + 1] >= 200 && buf[i + 2] >= 200) n++;
      }
    return n;
  }
  const ps = parsePPM(b.stdout, 0);
  check('settings: pane shot parses at 300x192', ps && ps.w === 300 && ps.h === 192,
    ps && `${ps.w}x${ps.h}`);
  if (!ps) return;
  check('settings: pane labels rendered (dark ink on BTNFACE)',
    darkInk(b.stdout, ps) > 150, String(darkInk(b.stdout, ps)));
  const p2 = parsePPM(b.stdout, ps.end);
  check('settings: term2 shot parses', !!p2);
  if (!p2) return;
  const band2 = p2.w * (p2.h - GRID_Y);
  check('settings: term2 band went LIGHT via the FS_WATCH cross-process reload',
    lightBand(b.stdout, p2) > band2 * 0.6,
    lightBand(b.stdout, p2) + '/' + band2);
  const p3 = parsePPM(b.stdout, p2.end);
  check('settings: relaunch shot parses', !!p3);
  if (!p3) return;
  const band3 = p3.w * (p3.h - GRID_Y);
  check('settings: relaunched term band is LIGHT (theme persisted to startup)',
    lightBand(b.stdout, p3) > band3 * 0.6,
    lightBand(b.stdout, p3) + '/' + band3);
}

(async () => {
  // Sessions run in order; an optional argv list of name substrings selects a
  // subset (e.g. `node test_term_e2e.js scrollback frames`). No args = all —
  // the kernel runner invokes with none, so full-estate behaviour is unchanged.
  const ALL = {
    term: sessionTerm, frames: sessionFrames, nested: sessionNested,
    less: sessionLess, dim: sessionDim, unicode: sessionUnicode, wide: sessionWide,
    scrollback: sessionScrollback, autoscroll: sessionAutoscroll,
    selscroll: sessionSelScroll, scrollbar: sessionScrollbar,
    menubar: sessionMenubar, settings: sessionSettings,
  };
  const want = process.argv.slice(2);
  for (const [name, fn] of Object.entries(ALL))
    if (!want.length || want.some((w) => name.includes(w))) fn();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\nterm e2e: ${failures} FAILED` : '\nterm e2e: PASS');
  process.exit(failures ? 1 : 0);
})();
