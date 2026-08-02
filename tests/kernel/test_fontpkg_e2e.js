#!/usr/bin/env node
// gucOS Unicode Phase D acceptance: font packages + the fallback chain
// (kills W7). On the MINIMAL image the ONE baked face is Noto Sans Mono —
// CJK renders as the honest 2-cell tofu box. `gucman install font-unifont`
// plants /opt/font-unifont/unifont.ttf + a /etc/fonts/fallback line
// (fontchain.h's /etc layer); a FRESH app's glyph cache then probes the
// chain and CJK renders real glyphs — in BOTH consumers:
//   - term (cp_glyph): pixel proof — the three 日/本/語 cell-pairs are
//     byte-identical while tofu (one box, three times) and pairwise
//     DISTINCT once real glyphs render;
//   - gdi32 (font_glyph, via notepad on a CJK file): stderr proof — the
//     "win32: unsupported font glyph" tofu report appears pre-install and
//     is GONE post-install.
// `gucman remove` replays the plant: the fallback line (and the then-empty
// file) go away and a fresh term is back to tofu. A second package
// (font-noto-cjk-mono) proves multi-line add/remove keeps the OTHER line.
//
// Run: node tests/kernel/test_fontpkg_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');
const K = require(path.join(ROOT, 'kernel.js'));
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const OS_KSVC = require(path.join(ROOT, 'os', 'ksvc.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// 日本語 as explicit UTF-8 byte escapes for busybox printf.
const CJK = '\\xe6\\x97\\xa5\\xe6\\x9c\\xac\\xe8\\xaa\\x9e';

// One "term renders the CJK sample at row 0" episode; shots to `ppm`.
function termShot(ppm) {
  return [
    `term sh -c "cat /root/cjk.txt; sleep 300" &`,
    'wmctl wait win term',
    'sleep 2',                       // timing subject: freetype render (multi-frame, no signal)
    'TSID=$(wmctl list | grep "\tterm$" | sed "s/[^0-9].*//")',
    `wmctl shot $TSID ${ppm} && echo shot-${path.basename(ppm, '.ppm')}-ok`,
    'pkill term',
    'wmctl wait nowin term',
  ];
}

async function main() {
  const repo = ensurePackages(['font-unifont', 'font-noto-cjk-mono']);
  const idx = repo.index;
  const MIN = ensureMinimalImage();
  const { dir: tmp, image } = freshImage('os-fontpkg-');
  fs.copyFileSync(MIN, image);
  const port = await startServer(repo.dir);
  console.log(`[fontpkg] repo :${port}`);
  const BOOT_ARGS = { image, args: ['--packages=none'], timeout: 600000 };

  const scriptA = [
    'echo ==pre',
    'test ! -e /etc/fonts/fallback && echo NO-FALLBACK-FILE',
    `printf '${CJK}\\n' > /root/cjk.txt`,
    ...termShot('/root/pre.ppm'),
    // gdi32 pre-install: notepad's EDIT draws the CJK bytes -> tofu report
    'echo ==preg-begin',
    'notepad /root/cjk.txt &',
    'wmctl wait win "cjk.txt - Notepad"',
    'sleep 2',                       // timing subject: EDIT paint (multi-frame, no signal)
    'pkill notepad',
    'wmctl wait nowin "cjk.txt - Notepad"',
    'echo ==preg-end',
    'echo ==install',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    'gucman install font-unifont; echo RC=$?',
    'echo ==fallback',
    'cat /etc/fonts/fallback',
    'test -f /opt/font-unifont/unifont.ttf && echo OPT-TTF-OK',
    'echo ==db',
    'cat /var/lib/gucman/font-unifont.json',
    'echo ==postbegin',
    ...termShot('/root/post.ppm'),
    // gdi32 post-install: fresh notepad, no tofu report expected
    'notepad /root/cjk.txt &',
    'wmctl wait win "cjk.txt - Notepad"',
    'sleep 2',                       // timing subject: EDIT paint (multi-frame, no signal)
    'pkill notepad',
    'wmctl wait nowin "cjk.txt - Notepad"',
    'echo ==second',
    'gucman install font-noto-cjk-mono; echo RC2=$?',
    'cat /etc/fonts/fallback',
    'echo ==removeuni',
    'gucman remove font-unifont; echo RRC=$?',
    'cat /etc/fonts/fallback',
    'test ! -e /opt/font-unifont && echo UNI-OPT-GONE',
    'echo ==removecjk',
    'gucman remove font-noto-cjk-mono; echo RRC2=$?',
    'test ! -e /etc/fonts/fallback && echo FALLBACK-GONE',
    'test ! -e /opt/font-noto-cjk-mono && echo CJK-OPT-GONE',
    ...termShot('/root/post2.ppm'),
    'echo ==done',
  ];
  const a = driveBoot(scriptA, BOOT_ARGS);
  const aout = String(a.stdout || '');
  const aall = aout + '\n' + String(a.stderr || '');

  const pre = section(aout, 'pre');
  check('minimal image carries no fallback config', pre.includes('NO-FALLBACK-FILE'), pre.slice(0, 200));
  check('pre/post/post2 term shots written',
    aout.includes('shot-pre-ok') && aout.includes('shot-post-ok') && aout.includes('shot-post2-ok'));

  // gdi32 chain, by stderr (the report has no stdout marker window, so
  // COUNT it): WIN32_UNSUPPORTED is once-per-call-site per PROCESS, so
  // the pre-install notepad prints exactly ONE tofu report (for the
  // first CJK cp it draws) and the post-install notepad — a fresh
  // process whose chain resolves the glyphs — prints NONE. A broken
  // chain would make it 2.
  const tofuReports = (aall.match(/unsupported font glyph/g) || []).length;
  check('gdi32 tofu report: pre-install notepad only (1 total, U+65E5)',
    tofuReports === 1 && /unsupported font glyph U\+65E5/.test(aall),
    String(tofuReports));

  const inst = section(aout, 'install');
  check('font-unifont installs (exit 0)', inst.includes('RC=0'), inst);
  const fb = section(aout, 'fallback');
  check('/etc/fonts/fallback lists the packaged face',
    fb.includes('/opt/font-unifont/unifont.ttf'), fb);
  check('the packaged ttf landed under /opt', fb.includes('OPT-TTF-OK'));
  const db = section(aout, 'db');
  check('DB records the planted font face line',
    /"font_faces"/.test(db) && db.includes('/opt/font-unifont/unifont.ttf'), db.slice(0, 400));

  const second = section(aout, 'second');
  check('second font package installs (exit 0)', second.includes('RC2=0'), second);
  check('fallback chain holds BOTH faces in install order',
    second.indexOf('/opt/font-unifont/unifont.ttf') >= 0 &&
    second.indexOf('/opt/font-noto-cjk-mono/NotoSansMonoCJKjp-VF.ttf') >
      second.indexOf('/opt/font-unifont/unifont.ttf'), second);

  const runi = section(aout, 'removeuni');
  check('removing font-unifont keeps the other face line',
    runi.includes('RRC=0') && !runi.includes('unifont.ttf') &&
    runi.includes('/opt/font-noto-cjk-mono/NotoSansMonoCJKjp-VF.ttf'), runi);
  check('removing font-unifont reclaims its /opt tree', runi.includes('UNI-OPT-GONE'));
  const rcjk = section(aout, 'removecjk');
  check('removing the last font package unlinks the fallback file',
    rcjk.includes('RRC2=0') && rcjk.includes('FALLBACK-GONE'), rcjk);
  check('second /opt tree reclaimed', rcjk.includes('CJK-OPT-GONE'));

  // ---- pixel proof: tofu = one box three times; real glyphs differ ----
  const b = driveBoot('cat /root/pre.ppm /root/post.ppm /root/post2.ppm\n',
    { image, args: ['--packages=none'], timeout: 120000, maxBuffer: 16 * 1024 * 1024, encoding: null });
  function parsePPM(buf, off) {
    const head = buf.toString('latin1', off, off + 32);
    const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
    if (!m) return null;
    const w = +m[1], h = +m[2], data = off + m[0].length;
    return { w, h, data, end: data + w * h * 3 };
  }
  // One 16x19 cell-PAIR bitmap at row 0 (pair i = cells 2i,2i+1) as a
  // Buffer slice for exact comparison. Row 0 sits below the 30px menu bar
  // band (todos/0273c — the grid renders at y offset 30).
  const GRID_Y = 30;
  function pairBits(buf, ppm, i) {
    const out = Buffer.alloc(16 * 19 * 3);
    for (let y = 0; y < 19; y++) {
      for (let x = 0; x < 16; x++) {
        const s = ppm.data + ((GRID_Y + y) * ppm.w + (i * 16 + x)) * 3;
        buf.copy(out, (y * 16 + x) * 3, s, s + 3);
      }
    }
    return out;
  }
  const ink = (bits) => { let n = 0; for (const v of bits) if (v) n++; return n; };
  const p0 = parsePPM(b.stdout, 0);
  check('pre shot parses', !!p0);
  if (!p0) return finish(tmp);
  const p1 = parsePPM(b.stdout, p0.end);
  const p2 = p1 && parsePPM(b.stdout, p1.end);
  check('post + post2 shots parse', !!p1 && !!p2);
  if (!p1 || !p2) return finish(tmp);
  const t = [0, 1, 2].map((i) => pairBits(b.stdout, p0, i));
  check('tofu: the three CJK cell-pairs render ink', t.every((x) => ink(x) > 0),
    t.map(ink).join(','));
  check('tofu: one box, three times (pairs byte-identical)',
    t[0].equals(t[1]) && t[1].equals(t[2]));
  const g = [0, 1, 2].map((i) => pairBits(b.stdout, p1, i));
  check('installed: real glyphs render ink', g.every((x) => ink(x) > 0), g.map(ink).join(','));
  check('installed: 日/本/語 are DISTINCT glyphs (pairs differ)',
    !g[0].equals(g[1]) && !g[1].equals(g[2]) && !g[0].equals(g[2]));
  check('installed: glyphs are not the tofu box', !g[0].equals(t[0]));
  const t2 = [0, 1, 2].map((i) => pairBits(b.stdout, p2, i));
  check('removed: back to the identical tofu box', t2[0].equals(t[0]) &&
    t2[0].equals(t2[1]) && t2[1].equals(t2[2]));

  // ---- 0275 ksvc title leg: the chain reaches window CHROME ----
  // Reinstall the CJK face (the removes above emptied the chain), then a
  // FRESH boot (ksvc reads the chain once, at ksvc_init) renders a CJK
  // winbox TITLE with real glyphs — bit-compared against os/ksvc.js over
  // the SAME image pair (the test_ksvc_e2e same-bytes assertion, now with
  // the package chain resolving through /opt on the root volume).
  const CJK_TXT = '日本語';
  // winbox rides the demos package since #418 — install it alongside the
  // face (the minimal image no longer bakes any demo app).
  const c = driveBoot(['gucman install font-noto-cjk-mono; echo RC4=$?',
                       'gucman install demos; echo RC5=$?'], BOOT_ARGS);
  check('title leg: reinstall font-noto-cjk-mono (exit 0)',
    String(c.stdout || '').includes('RC4=0'));
  check('title leg: install demos for winbox (exit 0)',
    String(c.stdout || '').includes('RC5=0'));

  const d = driveBoot([
    `winbox title "${CJK_TXT}" &`,
    `wmctl wait win "${CJK_TXT}"`,
    'sleep 1',   // genuine no-marker settle: wm.c EV_CREATED MOVE (map ack)
    'echo ==tlist',
    'wmctl list',
    'wmctl shot screen /root/title.ppm && echo title-shot-ok',
    'pkill winbox',
  ], BOOT_ARGS);
  const dout = String(d.stdout || '');
  check('title leg: CJK-title shot written', dout.includes('title-shot-ok'));

  const e = driveBoot('cat /root/title.ppm\n', { image, args: ['--packages=none'],
    timeout: 120000, maxBuffer: 16 * 1024 * 1024, encoding: null });
  const tp = parsePPM(e.stdout, 0);
  check('title leg: shot parses', !!tp);
  let wg = null;
  for (const line of section(dout, 'tlist').split('\n')) {
    const f = line.split('\t');
    if (f.length >= 7 && f[6] === CJK_TXT) {
      const m = f[2].match(/^(\d+)x(\d+)\+(-?\d+)\+(-?\d+)$/);
      if (m) wg = { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
    }
  }
  check('title leg: window listed with geometry', !!wg);
  if (tp && wg) {
    // Oracle: os/ksvc.js over the SAME system+root pair — the chain resolves
    // the /opt face exactly like the booted kernel's ksvc did.
    const sysStore = new COMMON.NodeFileStore(fs, image, false);
    const rootStore = new COMMON.NodeFileStore(fs,
      image.slice(0, -4) + '-root.img', false);
    const kfs = new BLOCK_FS.MountFS({
      '/': BLOCK_FS.createV4(rootStore), '/usr': BLOCK_FS.createV4(sysStore, { readonly: true }),
    });
    const svc = OS_KSVC.load(kfs, {});
    const maxW = Math.max(8, wg.w - 3 * (K.WM_CLOSE_W + K.WM_BOX_GAP) - 16);
    const lab = svc.render(CJK_TXT, K.WM_LABEL_PX, maxW, 0xFFFFFFFF, 1);
    const NAVY = K.WM_COLORS.titleFocused;
    const so = (s, a2, dd) => (s * a2 + dd * (255 - a2) + 127) / 255 | 0;
    const x0 = wg.x + 6, y0 = Math.round((wg.y - K.WM_TITLE_H / 2) - lab.h / 2);
    let mm = null;
    for (let gy = 0; gy < lab.h && !mm; gy++)
      for (let gx = 0; gx < lab.w && !mm; gx++) {
        const si = (gy * lab.w + gx) * 4, al = lab.bytes[si + 3];
        const di = tp.data + ((y0 + gy) * tp.w + (x0 + gx)) * 3;
        for (let ch = 0; ch < 3; ch++)
          if (e.stdout[di + ch] !== so(lab.bytes[si + ch], al, NAVY[ch])) {
            mm = { x: x0 + gx, y: y0 + gy, ch }; break;
          }
      }
    check('title leg: CJK title strip is bit-exact ksvc bytes (real glyphs)',
      !mm, mm && JSON.stringify(mm));
    // Real glyphs, not tofu: 日/本/語 advance-bands pairwise DISTINCT (the
    // tofu box repeats identically). Bands compare from the ORACLE bytes,
    // which the strip was just proven byte-identical to.
    const adv = Math.floor(lab.w / 3);
    const band = (i) => {
      const out = Buffer.alloc(adv * lab.h);
      for (let y = 0; y < lab.h; y++)
        for (let x = 0; x < adv; x++)
          out[y * adv + x] = lab.bytes[(y * lab.w + i * adv + x) * 4 + 3];
      return out;
    };
    const bands = [0, 1, 2].map(band);
    check('title leg: the three CJK title glyphs are DISTINCT (not tofu)',
      !bands[0].equals(bands[1]) && !bands[1].equals(bands[2]) &&
      !bands[0].equals(bands[2]));
    sysStore.close(); rootStore.close();
  }

  finish(tmp);
}

function finish(tmp) {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\nfontpkg e2e: ${failures} FAILED` : '\nfontpkg e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
