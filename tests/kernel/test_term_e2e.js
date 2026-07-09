#!/usr/bin/env node
// 0020 acceptance, headless: the wasm terminal (/bin/term — SDL surface +
// kernel pty + freetype, seeded from os/term/bin.json) runs hush on a pty
// inside a WM window, driven through os/boot.js:
//   - `term &` opens a 640x432 window (80x24 at the mono font's 8x18 cell)
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

const ROOT = path.resolve(__dirname, '../..');
const BOOT = path.join(ROOT, 'os/boot.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-term-'));
const image = path.join(tmp, 'os.img');

// Inject a string as SDL key events (down+up per char). SDL3 keysyms are
// modifier-applied characters, so term maps them straight to pty bytes;
// scancode 0 is fine (term reads only key/mod).
const keys = (s) => [...s].map((ch) => 'wmctl key $TSID 0 ' + ch.charCodeAt(0)).join('\n');

/* ---- session A: seed, launch term, type, vi, resize, exit ---- */
function sessionTerm() {
  const script = [
    'term &',
    'sleep 5',                                     // wasm + freetype + hush spawn
    'echo ==list1',
    'wmctl list',
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    'wmctl shot $TSID /root/t1.ppm && echo shot1-ok',
    keys('ls /bin\r'),
    'sleep 2',
    'wmctl shot $TSID /root/t2.ppm && echo shot2-ok',
    // vi inside the terminal. ESC is sent alone with air on both sides:
    // vi's read_key resolves a lone ESC by timeout.
    keys('vi /tmp/t.txt\r'),
    'sleep 2.5',
    'wmctl shot $TSID /root/tvi.ppm && echo shotvi-ok',
    keys('ihey from term'),
    'sleep 1.5',
    keys('\x1b'),
    'sleep 1.5',
    keys(':wq\r'),
    'sleep 2.5',
    // Drag-resize equivalent over the agent channel (the kernel path is
    // identical past the drag): reflow + TIOCSWINSZ + re-render.
    'wmctl resize $TSID 500 260',
    'sleep 2.5',
    'echo ==list2',
    'wmctl list',
    'wmctl shot $TSID /root/trs.ppm && echo shotrs-ok',
    // Session teardown: hush exits -> term reaps it -> window gone.
    keys('exit\r'),
    'sleep 2.5',
    'echo ==list3',
    'wmctl list',
    'echo ==cat',
    'cat /tmp/t.txt',
    '',
  ].join('\n');

  const a = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: script, encoding: 'utf8', timeout: 420000 });
  if (a.error) throw a.error;
  const out = a.stdout;

  const list1 = (out.split('==list1\n')[1] || '').split('==')[0];
  const termRow = list1.split('\n').find((l) => l.endsWith('\tterm')) || '';
  check('term opens a WM window titled "term"', termRow !== '', JSON.stringify(list1));
  check('term window is 640x432 (80x24 at the 8x18 mono cell)',
    termRow.includes('640x432'), termRow);
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
  const b = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: 'cat /root/t1.ppm /root/t2.ppm /root/tvi.ppm /root/trs.ppm\n',
      timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (b.error) throw b.error;

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
  check('shot1 parses at 640x432', t1 && t1.w === 640 && t1.h === 432,
    t1 && `${t1.w}x${t1.h}`);
  if (!t1) return;
  const t1fg = fgPixels(b.stdout, t1);
  check('shot1 shows rendered text (hush banner + prompt)', t1fg > 1500, String(t1fg));

  const t2 = parsePPM(b.stdout, t1.end);
  check('shot2 parses at 640x432', t2 && t2.w === 640 && t2.h === 432);
  if (!t2) return;
  const t2fg = fgPixels(b.stdout, t2);
  check('ls /bin rendered more text (echo + output over the pty)',
    t2fg > t1fg + 1000, `${t1fg} -> ${t2fg}`);

  const tvi = parsePPM(b.stdout, t2.end);
  check('vi shot parses at 640x432', tvi && tvi.w === 640 && tvi.h === 432);
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
    'sleep 5',
    `T1=$(${TROW} | head -n 1 | cut -f1)`,
    `P1=$(${TROW} | head -n 1 | cut -f2)`,
    keysT('T1', 'term &\r'),
    'sleep 6',
    `T2=$(${TROW} | tail -n 1 | cut -f1)`,
    `P2=$(${TROW} | tail -n 1 | cut -f2)`,
    'echo ==nest1',
    'wmctl list',
    'kill -9 $P1',
    'sleep 2.5',
    'echo ==nest2',
    'wmctl list',
    'kill -0 $P2 || echo nested-child-died-with-parent',
    // B: exit the parent shell -> the bg child survives, works, closes
    'term &',
    'sleep 5',
    `T1=$(${TROW} | head -n 1 | cut -f1)`,
    keysT('T1', 'term &\r'),
    'sleep 6',
    `T2=$(${TROW} | tail -n 1 | cut -f1)`,
    `P2=$(${TROW} | tail -n 1 | cut -f2)`,
    keysT('T1', 'exit\r'),
    'sleep 3',
    'echo ==nest3',
    'wmctl list',
    'kill -0 $P2 && echo orphan-alive',
    keysT('T2', 'mkdir /qnest\r'),
    'sleep 3',
    'test -d /qnest && echo orphan-responsive',
    'wmctl close $T2',
    'sleep 2.5',
    'echo ==nest4',
    'wmctl list',
    '',
  ].join('\n');
  const c = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: script, encoding: 'utf8', timeout: 420000 });
  if (c.error) throw c.error;
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
    'sleep 5',
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    keys('less /tmp/big.txt\r'),
    'sleep 2.5',
    'wmctl shot $TSID /root/tless.ppm && echo shotless-ok',
    keys(' '),                       // space: page down inside less
    'sleep 1.5',
    keys('q'),                       // quit back to hush
    'sleep 1.5',
    keys('echo lessrc=$? > /tmp/lessrc\r'),
    'sleep 1.5',
    keys('exit\r'),
    'sleep 2.5',
    'echo ==rc',
    'cat /tmp/lessrc',
    'echo ==done',
    '',
  ].join('\n');
  const d = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: script, encoding: 'utf8', timeout: 420000 });
  if (d.error) throw d.error;
  const out = d.stdout;
  check('less shot written', out.includes('shotless-ok'), out.slice(-300));
  const rc = (out.split('==rc\n')[1] || '').split('==')[0].trim();
  check('q quits less back to the shell, exit 0 (typed echo ran at hush)',
    rc === 'lessrc=0', JSON.stringify(rc));

  // Pixel pass on the in-less shot (same parser as session B).
  const b = cp.spawnSync('node', [BOOT, '--image=' + image, '--quiet'],
    { input: 'cat /root/tless.ppm\n',
      timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  if (b.error) throw b.error;
  const head = b.stdout.toString('latin1', 0, 32);
  const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
  check('less shot parses at 640x432', !!m && +m[1] === 640 && +m[2] === 432,
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

(async () => {
  sessionTerm();
  sessionFrames();
  sessionNested();
  sessionLess();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\nterm e2e: ${failures} FAILED` : '\nterm e2e: PASS');
  process.exit(failures ? 1 : 0);
})();
