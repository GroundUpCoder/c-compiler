// NetSurf charset/mojibake probe — investigation harness for jku's report
// that google/facebook render as "EspaÃ±ol" / "Tiáº¿ng Viá»‡t" in gucOS NetSurf.
//
// Boots gucOS in headless Chromium (prod edge by default — that is what jku is
// running, and it has real network egress), then opens a ladder of pages whose
// ONLY difference is HOW the document declares its encoding:
//
//   metautf8  file://  <meta charset="utf-8">        + raw UTF-8 bytes
//   bare      file://  no declaration at all         + raw UTF-8 bytes
//   dataurl   data:text/html;charset=utf-8,...       + %-encoded UTF-8 bytes
//   datanone  data:text/html,<meta charset=utf-8>... + %-encoded UTF-8 bytes
//   google    real https, charset in the HTTP header AND a meta
//   facebook  real https, ditto (jku's original screenshot)
//
// Each window's surface is written to NS_MEDIA as <case>-<tag>.png.
//
// Usage:
//   node ns-charset-probe.mjs                       # prod edge
//   NS_URL=http://localhost:3217/os/os.html NS_TAG=local node ns-charset-probe.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { launchBrowser, osHelpers, startServer, waitForServer, osUrl } from './lib/os-harness.mjs';
import { joinHeavyLock } from '../lib/heavy-lock.js';

// The RAM-heavy jobs run one at a time. Another lane's suite may hold the
// lock; WAIT for it (up to 40 min) instead of failing fast, then publish the
// re-entrancy marker so the harness's own latch joins rather than contends.
joinHeavyLock({ name: 'browser os test (ns-charset-probe.mjs)', waitMs: 40 * 60 * 1000 });
process.env.CC_HEAVY_LOCK_PID = String(process.pid);

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const { encodePng } = require(path.join(ROOT, 'tests/lib/png.js'));

const PORT = 3217;
const REMOTE = process.env.NS_URL !== undefined ? !!process.env.NS_URL : true;
const URL = process.env.NS_URL || 'https://groundupcoder.com/os/os.html?hostkeys=off';
const TAG = process.env.NS_TAG || (REMOTE ? 'prod' : 'local');
const MEDIA = process.env.NS_MEDIA || '/Users/jku/git/meta/meta/media/netsurf-charset';
const ONLY = process.env.NS_ONLY ? process.env.NS_ONLY.split(',') : null;

// The sample text, as octal escapes so the line we TYPE into the OS shell is
// pure ASCII (the keyboard path is a tty, not a UTF-8 pipe). These are the
// exact UTF-8 byte sequences:
//   Espa\303\261ol           -> Español      (U+00F1, 2 bytes)
//   Ti\341\272\277ng         -> Tiếng        (U+1EBF, 3 bytes)
//   Vi\341\273\207t          -> Việt         (U+1EC7, 3 bytes)
//   \353\241\234...          -> 로그인        (Korean, 3 bytes each)
//   \346\227\245...          -> 日本語        (CJK, 3 bytes each)
const OCTAL = '<p>Espa\\303\\261ol</p><p>Ti\\341\\272\\277ng Vi\\341\\273\\207t</p>' +
              '<p>\\353\\241\\234\\352\\267\\270\\354\\235\\270</p>' +
              '<p>\\346\\227\\245\\346\\234\\254\\350\\252\\236</p>';
// Same bytes, %-encoded, for the data: URLs.
const PCT = '%3Cp%3EEspa%C3%B1ol%3C/p%3E%3Cp%3ETi%E1%BA%BFng%20Vi%E1%BB%87t%3C/p%3E' +
            '%3Cp%3E%EC%9D%B4%EA%B8%80%3C/p%3E';

const BODY = 'body style=\\"font-size:30px;font-family:sans-serif\\"';

const CASES = [
  { name: 'metautf8', title: 'meta-utf8',
    setup: `printf '<!DOCTYPE html><title>meta-utf8</title><meta charset=\\"utf-8\\"><${BODY}>${OCTAL}' > /tmp/metautf8.html`,
    url: 'file:///tmp/metautf8.html' },
  { name: 'bare', title: 'bare',
    setup: `printf '<!DOCTYPE html><title>bare</title><${BODY}>${OCTAL}' > /tmp/bare.html`,
    url: 'file:///tmp/bare.html' },
  { name: 'dataurl', title: 'data-charset',
    url: `data:text/html;charset=utf-8,%3Ctitle%3Edata-charset%3C/title%3E${PCT}` },
  { name: 'datameta', title: 'data-meta',
    url: `data:text/html,%3Ctitle%3Edata-meta%3C/title%3E%3Cmeta%20charset=utf-8%3E${PCT}` },
  { name: 'google', title: null, url: 'https://www.google.com/search?q=espa%C3%B1ol' },
  { name: 'facebook', title: null, url: 'https://www.facebook.com' },
];

const server = REMOTE ? null : startServer(PORT);
if (!REMOTE) await waitForServer(URL, { tries: 3000, interval: 200 });
const browser = await launchBrowser();
const results = [];
const hdrDump = [];
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  console.log('booting ' + URL);
  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 300000, polling: 250 });
  await page.waitForFunction(() => /~ #|# $/.test(window.__osOut), { timeout: 90000, polling: 200 });
  console.log('booted to shell');

  const { setVt, waitOut, waitScreen } = osHelpers(page);
  const type = async (cmd) => { await page.keyboard.type(cmd + '\r'); };

  await setVt(2);
  await waitScreen();
  await new Promise(r => setTimeout(r, 1500));
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  await setVt(1);

  const grabSurface = async (wx, wy, w, h) => {
    const b64 = await page.evaluate(([sx, sy, sw, sh]) => {
      const c = document.getElementById('screen');
      const r = c.getBoundingClientRect();
      const t = document.createElement('canvas');
      t.width = Math.round(r.width); t.height = Math.round(r.height);
      t.getContext('2d').drawImage(c, 0, 0);
      const d = t.getContext('2d').getImageData(sx, sy, sw, sh).data;
      let s = '';
      for (let i = 0; i < d.length; i += 0x8000)
        s += String.fromCharCode.apply(null, d.subarray(i, Math.min(i + 0x8000, d.length)));
      return btoa(s);
    }, [wx, wy, w, h]);
    const rgba = Buffer.from(b64, 'base64');
    const rgb = Buffer.alloc(w * h * 3);
    for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
      rgb[o] = rgba[i]; rgb[o + 1] = rgba[i + 1]; rgb[o + 2] = rgba[i + 2];
    }
    return { w, h, rgb };
  };

  fs.mkdirSync(MEDIA, { recursive: true });

  // Before any rendering: what does the TRANSPORT actually hand the OS?
  // NetSurf can only learn the encoding from the Content-Type charset or a
  // <meta>; google/search and facebook ship NO meta, so the header is the
  // only source. Dump it as the OS sees it.
  console.log('\n== transport headers, as the OS sees them');
  for (const u of ['https://www.google.com/search?q=espa%C3%B1ol', 'https://www.facebook.com', 'https://www.google.com']) {
    await type(`echo ==H-''DR; curl -sS -D - -o /dev/null "${u}" 2>&1 | head -25; echo ==E-''ND`);
    try {
      await waitOut('==END', 45000);
    } catch { console.log(`  ${u}: TIMED OUT`); continue; }
    const seg = (await page.evaluate(() => window.__osOut)).split('==H-DR').pop().split('==END')[0];
    const ct = seg.split('\n').map(s => s.trim()).filter(s => /^content-type/i.test(s));
    console.log(`  ${u}\n     -> ${ct.length ? ct.join(' | ') : '(NO content-type header seen)'}`);
    hdrDump.push({ url: u, contentType: ct, raw: seg.trim().slice(0, 900) });
  }

  for (const c of CASES.filter(c => !ONLY || ONLY.includes(c.name))) {
    console.log(`\n== ${c.name}`);
    await setVt(1);
    if (c.setup) {
      await type(c.setup);
      await type(`echo SET-''UP-${c.name}`);
      await waitOut(`SET-UP-${c.name}`, 20000);
    }
    // Launch and wait for SOME new window; we discover its title from wmctl
    // rather than assuming (the real sites title themselves).
    await type(`netsurf "${c.url}" &`);
    await new Promise(r => setTimeout(r, c.url.startsWith('http') ? 15000 : 6000));

    await type(`echo ==G-''${c.name}; wmctl list; echo ==E-''${c.name}`);
    await waitOut(`==E-${c.name}`, 25000);
    const seg = (await page.evaluate(() => window.__osOut)).split(`==G-${c.name}`).pop().split(`==E-${c.name}`)[0];
    const rows = seg.split('\n').map(l => l.trim().split('\t')).filter(r => r.length > 6 && /^\d+x\d+\+/.test(r[2] || ''));
    if (!rows.length) { console.log('  no window for ' + c.name); results.push({ name: c.name, ok: false }); continue; }
    const row = rows[rows.length - 1];
    const [, Ws, Hs, WXs, WYs] = row[2].match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
    const W = +Ws, H = +Hs, WX = +WXs, WY = +WYs;
    const sid = row[0];
    console.log(`  window "${row[6]}" ${W}x${H}+${WX}+${WY}`);

    await setVt(2);
    await new Promise(r => setTimeout(r, 1200));
    const shot = await grabSurface(WX, WY, W, H);
    const out = path.join(MEDIA, `${c.name}-${TAG}.png`);
    fs.writeFileSync(out, encodePng(shot.w, shot.h, shot.rgb));
    console.log('  shot -> ' + out);
    results.push({ name: c.name, ok: true, title: row[6], png: out });

    await setVt(1);
    await type(`wmctl close ${sid}`);
    await new Promise(r => setTimeout(r, 1500));
  }
} catch (e) {
  console.error('FAIL: ' + (e && e.stack));
} finally {
  await browser.close();
  if (server) server.kill();
}
console.log('\n=== header dump ===');
console.log(JSON.stringify(hdrDump, null, 2));
console.log('\n=== shots ===');
console.log(JSON.stringify(results, null, 2));
