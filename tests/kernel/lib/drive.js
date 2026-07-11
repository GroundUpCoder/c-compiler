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

  const args = [BOOT, '--image=' + image, '--quiet', ...(opts.args || [])];
  const r = cp.spawnSync('node', args, spawnOpts);
  if (r.error) throw r.error;
  r.image = image;   // let a follow-up session reuse the same image
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

module.exports = { ROOT, BOOT, freshImage, driveBoot, section };
