'use strict';
// Shared OS boot driver for the headless kernel e2e tests (todos/0146).
//
// Every `*_e2e.js` used to reimplement the same boilerplate inline: an
// mkdtemp image dir + `os.img` path, a `node os/boot.js --image=<img> --quiet`
// spawn with the test script piped on stdin, and the `if (r.error) throw`
// guard. This is that seam — the ONE place the future `wmctl wait` (0083)
// integrates, instead of the driver being copy-pasted per file.
//
//   const { driveBoot, freshImage, section } = require('./lib/drive.js');
//
//   // single session: driveBoot mints a throwaway image for you
//   const r = driveBoot(['winbox &', 'sleep 2', 'echo ==l1', 'wmctl list']);
//   const list = section(r.stdout, 'l1');
//
//   // multi-session (seed then read the PPMs back over the SAME image):
//   const { dir, image } = freshImage('os-apps-');
//   driveBoot(seedScript, { image, timeout: 300000 });
//   const back = driveBoot('cat /root/a.ppm\n', { image, encoding: null,
//                                                 maxBuffer: 32 * 1024 * 1024 });
//   fs.rmSync(dir, { recursive: true, force: true });
//
// driveBoot returns the raw spawnSync result (stdout/stderr/status/signal),
// throwing only on spawn error — callers keep asserting on stdout exactly as
// before. The chosen image path is attached as `r.image` for convenience.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// lib/ sits one level below tests/kernel/, which is two below the repo root.
const ROOT = path.resolve(__dirname, '../../..');
const BOOT = path.join(ROOT, 'os/boot.js');

// A fresh throwaway image: an mkdtemp dir + its `os.img` path. The caller
// owns cleanup (`fs.rmSync(dir, { recursive: true, force: true })`); most
// e2es leak the tmpdir like they always did and let the OS sweep /tmp.
function freshImage(prefix = 'os-e2e-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, image: path.join(dir, 'os.img') };
}

// Pipe `script` to `os/boot.js --image=<image> --quiet [...args]`.
//   script    a string (piped verbatim) or an array of shell lines (joined
//             with '\n'); a trailing newline is guaranteed so the final
//             command always runs even without the classic trailing '' entry.
// opts:
//   image     reuse this image path (default: a fresh throwaway one)
//   prefix    mkdtemp prefix when minting a fresh image (default 'os-e2e-')
//   args      extra boot.js flags, e.g. ['--tty-out']
//   timeout   spawn timeout ms (default 300000)
//   maxBuffer stdout cap (default node's — pass for big PPM cat-backs)
//   encoding  stdout encoding (default 'utf8'; pass null/'buffer' for raw
//             Buffer output, e.g. reading binary PPM frames back)
function driveBoot(script, opts = {}) {
  const image = opts.image || freshImage(opts.prefix).image;
  let input = Array.isArray(script) ? script.join('\n') : String(script);
  if (!input.endsWith('\n')) input += '\n';

  const spawnOpts = { input, timeout: opts.timeout != null ? opts.timeout : 300000 };
  const enc = 'encoding' in opts ? opts.encoding : 'utf8';
  if (enc != null && enc !== 'buffer') spawnOpts.encoding = enc;   // else raw Buffer
  if (opts.maxBuffer) spawnOpts.maxBuffer = opts.maxBuffer;

  // opts.nodeArgs: node/V8 flags BEFORE the script (e.g.
  // `--wasm-max-mem-pages=N` to bound every wasm instance's heap — the
  // deterministic-OOM knob for the comdlg-diag test; worker_threads
  // inherit the process's V8 flags).
  const args = [...(opts.nodeArgs || []), BOOT, '--image=' + image,
                '--quiet', ...(opts.args || [])];
  const r = cp.spawnSync('node', args, spawnOpts);
  if (r.error) throw r.error;
  r.image = image;   // let a follow-up session reuse the same image
  // Loud-symptom gate (todos/0171): a `wmctl wait` that can't be satisfied
  // prints `wmctl: wait X timed out after Nms` and exits 1 — but a script
  // with no `set -e` just burns the full timeout and sails on, so a wait on
  // an unreachable condition passes SLOWLY instead of failing. (That is how
  // the AQ_GETTEXT-can't-see-popup bug hid: fileman_ops was 117s of dead
  // waits.) Any real timeout is a bug — no e2e legitimately expects one
  // (absence checks use nowin/nolabel, which succeed on absence). Surface it
  // as a hard failure naming every timed-out condition. Opt out with
  // opts.allowWaitTimeout for a deliberate negative wait test.
  if (!opts.allowWaitTimeout) {
    const hay = String(r.stdout || '') + '\n' + String(r.stderr || '');
    const hits = hay.match(/wmctl: wait .* timed out after \d+ms/g);
    if (hits) {
      const uniq = Array.from(new Set(hits));
      // Locate the failure: the stdout tail up to (and including) the first
      // timeout line shows which script leg was running — without it the
      // error names the symptom but not the site.
      const so = String(r.stdout || '');
      const at = so.search(/wmctl: wait .* timed out after \d+ms/);
      const tail = (at >= 0 ? so.slice(0, at) : so).split('\n').slice(-12);
      throw new Error('driveBoot: wmctl wait timed out (a wait on an ' +
        'unreachable condition — root-cause it, do not lengthen the timeout):\n  ' +
        uniq.join('\n  ') +
        '\n--- stdout tail before the first timeout ---\n' + tail.join('\n'));
    }
  }
  return r;
}

// The `==marker\n … ==` marker-grep every e2e reimplements: return the slice
// of `out` between `==<name>\n` and the next `==` (or end of output). Empty
// string when the marker is absent. Matches the inline `section()` helper the
// ctxmenu/recycle/… tests carry.
function section(out, name) {
  const parts = String(out).split('==' + name + '\n');
  return parts.length > 1 ? parts[1].split('==')[0] : '';
}

// ---- the seeded desktop grid model (todos/0184/0185) ----
// The seeded /root/Desktop set is DERIVED from os/image.json's user section
// (the todos/0166 rule: a new seeded icon must not silently shift hardcoded
// rows) — FILES and DIRS, direct children only (the deck links inside
// Presentations/ are not icons), plus wm.c's always-recreated Recycle Bin.
// deskSort replicates wm.c entcmp exactly: Recycle Bin last, dirs first,
// byte-order strcmp. deskCell maps a name to its column-major cell — 0184
// pushed the seeded set past one column at 1024x768 (11 rows/col), so
// column-0 math is no longer safe. Entries are {name, dir}; `extras` folds
// in a test's runtime-created entries (string = plain file) before sorting.
function deskEntries(extras = []) {
  const u = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'os/image.json'), 'utf8')).user;
  const child = (p) => {
    if (!p.startsWith('/root/Desktop/')) return null;
    const n = p.slice('/root/Desktop/'.length);
    return n && !n.includes('/') ? n : null;
  };
  const ents = [];
  for (const p of Object.keys(u.files)) {
    const n = child(p);
    if (n) ents.push({ name: n, dir: false });
  }
  for (const p of u.dirs || []) {
    const n = child(p);
    if (n) ents.push({ name: n, dir: true });
  }
  ents.push({ name: 'Recycle Bin', dir: false });   // wm.c ensure_recycle
  return deskSort(ents.concat(
    extras.map((e) => typeof e === 'string' ? { name: e, dir: false } : e)));
}
function deskSort(ents) {
  return ents.slice().sort((a, b) => {
    const ra = a.name === 'Recycle Bin' ? 1 : 0,
          rb = b.name === 'Recycle Bin' ? 1 : 0;
    if (ra !== rb) return ra - rb;
    const da = a.dir ? 1 : 0, db = b.dir ? 1 : 0;
    if (da !== db) return db - da;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  }).map((e) => e.name);
}
// wm.c geometry (font-20 retune): 16px margin, 116x96 cells, 36px
// taskbar; rows/col = (scrH - 68) / 96 (7 at the e2es' 1024x768). x/y are
// the cell origin; cx/cy the icon-click center (the hit test is
// cell-granular, so mid-cell is safe).
function deskCell(list, name, scrH = 768) {
  const rows = Math.max(1, Math.floor((scrH - 36 - 32) / 96));
  const i = list.indexOf(name);
  if (i < 0) throw new Error('deskCell: "' + name + '" not on the desktop');
  const col = Math.floor(i / rows), row = i % rows;
  return { index: i, col, row, rows,
           x: 16 + col * 116, y: 16 + row * 96,
           cx: 16 + col * 116 + 58, cy: 16 + row * 96 + 48 };
}

module.exports = { ROOT, BOOT, freshImage, driveBoot, section,
                   deskEntries, deskSort, deskCell };
