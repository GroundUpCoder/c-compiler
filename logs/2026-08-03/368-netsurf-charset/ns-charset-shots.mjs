// NetSurf charset repro, IN THE REAL OS, with screenshots.
//
// Boots gucOS in headless Chromium against the local serve.js and points its
// NetSurf at pages served over REAL HTTP by a side server that sets the exact
// Content-Type shapes google/facebook use. Same-origin problems are avoided
// with permissive CORS, so the gucOS http fetcher (gucos/httpfetch.c) is
// exercised for real.
//
//   http-charset   Content-Type: text/html; charset=utf-8   + NO <meta>
//                    <- google.com/search and facebook.com's exact shape
//   http-meta      Content-Type: text/html (no charset)     + <meta charset>
//                    <- google.com's landing-page shape
//   file-meta      file://, <meta charset="utf-8">
//   file-bare      file://, nothing declared  (fallback is CORRECT here)
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { joinHeavyLock } from '../lib/heavy-lock.js';
import { launchBrowser, osHelpers, startServer, waitForServer, osUrl } from './lib/os-harness.mjs';

// Bounded so the whole run fits ONE foreground tool call — never background
// this: a backgrounded run gets killed with no completion record.
joinHeavyLock({ name: 'browser os test (ns-charset-shots.mjs)', waitMs: 300 * 1000 });
process.env.CC_HEAVY_LOCK_PID = String(process.pid);

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const { encodePng } = require(path.join(ROOT, 'tests/lib/png.js'));

const PORT = 3218;
const HTTPD = 3394;
const URL = osUrl(PORT);
const MEDIA = process.env.NS_MEDIA || '/Users/jku/git/meta/meta/media/netsurf-charset';

const SAMPLE = '<p>Espa\\303\\261ol</p><p>Ti\\341\\272\\277ng Vi\\341\\273\\207t</p><p>\\353\\241\\234\\352\\267\\270\\354\\235\\270</p>';
const STYLE = 'body{font-family:sans-serif;font-size:32px;margin:16px}';
const TEXT = '<p>Español</p><p>Tiếng Việt</p><p>로그인</p>';

const page_ = (title, meta) =>
  `<!DOCTYPE html><html><head>${meta}<title>${title}</title><style>${STYLE}</style></head>` +
  `<body><h2>${title}</h2>${TEXT}</body></html>`;

const ROUTES = {
  // google/search + facebook shape: charset ONLY in the HTTP header.
  '/http-charset': ['text/html; charset=utf-8', page_('http-charset', '')],
  // google landing-page shape: charset in a <meta>, not in the header.
  '/http-meta': ['text/html', page_('http-meta', '<meta charset="utf-8">')],
};
const httpd = http.createServer((req, res) => {
  const r = ROUTES[req.url];
  if (!r) { res.writeHead(404); res.end(); return; }
  const body = Buffer.from(r[1], 'utf8');
  res.writeHead(200, {
    'content-type': r[0],
    'content-length': body.length,
    'access-control-allow-origin': '*',
    // serve.js sets COEP: require-corp (for SharedArrayBuffer), so a
    // cross-origin subresource is blocked unless it opts in explicitly.
    'cross-origin-resource-policy': 'cross-origin',
  });
  res.end(body);
});
await new Promise(ok => httpd.listen(HTTPD, '127.0.0.1', ok));

const CASES = [
  { name: 'http-charset', title: 'http-charset', url: `http://127.0.0.1:${HTTPD}/http-charset` },
  { name: 'http-meta',    title: 'http-meta',    url: `http://127.0.0.1:${HTTPD}/http-meta` },
];

const server = startServer(PORT);
await waitForServer(URL, { tries: 3000, interval: 200 });
const browser = await launchBrowser();
const results = [];
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 820 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  console.log('booting ' + URL);
  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 300000, polling: 250 });
  await page.waitForFunction(() => /# $|~ #/.test(window.__osOut), { timeout: 90000, polling: 200 });
  console.log('booted to shell');

  const { setVt, waitOut, waitScreen } = osHelpers(page);
  const type = async (cmd) => { await page.keyboard.type(cmd + '\r'); };

  await setVt(2); await waitScreen();
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
      const cx = t.getContext('2d');
      cx.drawImage(c, 0, 0);
      const d = cx.getImageData(sx, sy, sw, sh).data;
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

  for (const c of CASES) {
    console.log(`\n== ${c.name}`);
    await setVt(1);
    if (c.setup) {
      await type(c.setup);
      await type(`echo SET-''UP`);
      await waitOut('SET-UP', 20000);
    }
    await type(`netsurf "${c.url}" &`);
    await type(`wmctl wait win "${c.title}" 60000 && echo UP-''${c.name} || echo NOWIN-''${c.name}`);
    await page.waitForFunction((n) => new RegExp('UP-' + n + '|NOWIN-' + n).test(window.__osOut), c.name,
                               { timeout: 90000, polling: 200 });
    if (!(await page.evaluate(() => window.__osOut)).includes('UP-' + c.name)) {
      console.log('   window never appeared'); results.push({ name: c.name, ok: false }); continue;
    }
    await type(`echo ==G-''${c.name}; wmctl list; echo ==E-''${c.name}`);
    await waitOut(`==E-${c.name}`, 25000);
    const seg = (await page.evaluate(() => window.__osOut)).split(`==G-${c.name}`).pop().split(`==E-${c.name}`)[0];
    const row = seg.split('\n').map(l => l.trim().split('\t')).find(cc => cc[6] === c.title);
    if (!row) { console.log('   no wmctl row'); results.push({ name: c.name, ok: false }); continue; }
    const [, Ws, Hs, WXs, WYs] = row[2].match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
    const W = +Ws, H = +Hs, WX = +WXs, WY = +WYs, sid = row[0];
    console.log(`   window "${row[6]}" ${W}x${H}+${WX}+${WY}`);

    await setVt(2);
    await new Promise(r => setTimeout(r, 1500));
    const shot = await grabSurface(WX, WY, W, H);
    const out = path.join(MEDIA, `${c.name}.png`);
    fs.writeFileSync(out, encodePng(shot.w, shot.h, shot.rgb));
    console.log('   shot -> ' + out);
    results.push({ name: c.name, ok: true, png: out });

    await setVt(1);
    await type(`wmctl close ${sid}`);
    await new Promise(r => setTimeout(r, 1200));
  }
} catch (e) {
  console.error('FAIL: ' + (e && e.stack));
} finally {
  await browser.close();
  if (server) server.kill();
  httpd.close();
}
console.log('\n' + JSON.stringify(results, null, 2));
