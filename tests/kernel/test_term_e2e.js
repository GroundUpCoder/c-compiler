#!/usr/bin/env node
// 0020 acceptance, headless: the wasm terminal (/bin/term — SDL surface +
// kernel pty + freetype, seeded from os/term/bin.json) runs hush on a pty
// inside a WM window, driven through os/boot.js:
//   - `term &` opens a 640x456 window (80x24 at the mono font's 8x19 cell)
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
  check('term window is 640x456 (80x24 at the 8x19 mono cell)',
    termRow.includes('640x456'), termRow);
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
  check('shot1 parses at 640x456', t1 && t1.w === 640 && t1.h === 456,
    t1 && `${t1.w}x${t1.h}`);
  if (!t1) return;
  const t1fg = fgPixels(b.stdout, t1);
  check('shot1 shows rendered text (hush banner + prompt)', t1fg > 1500, String(t1fg));

  const t2 = parsePPM(b.stdout, t1.end);
  check('shot2 parses at 640x456', t2 && t2.w === 640 && t2.h === 456);
  if (!t2) return;
  const t2fg = fgPixels(b.stdout, t2);
  check('ls /bin rendered more text (echo + output over the pty)',
    t2fg > t1fg + 1000, `${t1fg} -> ${t2fg}`);

  const tvi = parsePPM(b.stdout, t2.end);
  check('vi shot parses at 640x456', tvi && tvi.w === 640 && tvi.h === 456);
  if (!tvi) return;
  // The alternate screen replaced the shell: mostly empty rows of tildes +
  // the status line in the bottom cell row (cell height 18).
  const statusFg = fgPixels(b.stdout, tvi, tvi.h - 18, tvi.h);
  check('vi status line rendered in the bottom row', statusFg > 100, String(statusFg));
  const middleFg = fgPixels(b.stdout, tvi, 5 * 18, 6 * 18);
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
  check('less shot parses at 640x456', !!m && +m[1] === 640 && +m[2] === 456,
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
    'wmctl down $TSID 2 9',
    'wmctl hover $TSID 38 9',
    'wmctl up $TSID 38 9',
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
  check('unicode: baseline shot parses at 640x456', p0 && p0.w === 640 && p0.h === 456);
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
  // Ink pixels of one 8x19 cell at (col, row 0).
  function cellInk(buf, ppm, col) {
    let n = 0;
    for (let y = 0; y < 19; y++) {
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

(async () => {
  sessionTerm();
  sessionFrames();
  sessionNested();
  sessionLess();
  sessionUnicode();
  sessionWide();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\nterm e2e: ${failures} FAILED` : '\nterm e2e: PASS');
  process.exit(failures ? 1 : 0);
})();
