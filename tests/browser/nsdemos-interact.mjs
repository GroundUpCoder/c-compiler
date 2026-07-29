// NetSurf demos interaction-truth driver (netsurf-bughunt lane) — the
// BROWSER flavor: boots gucOS in headless Chromium (local serve.js by
// default, the deployed edge with NS_URL=), opens every shipped demo, and
// drives each one's declared interaction with REAL Chromium input
// (page.mouse / page.keyboard through os.html's input path). The per-demo
// phases, coordinates and pixel expectations live in ONE place —
// vendor/netsurf/demos/demos.js INTERACTIONS — shared with the kernel e2e's
// wmctl-injection flavor.
//
// Every phase's surface shot is persisted as a viewable PNG (NS_MEDIA dir),
// named <demo>-<phase>-<tag>.png.
//
// Usage:
//   node nsdemos-interact.mjs                  # local serve.js on :3213
//   NS_URL=https://groundupcoder.com/os/os.html?hostkeys=off NS_TAG=prod node nsdemos-interact.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { launchBrowser, osHelpers, makeCheck, startServer, waitForServer, osUrl } from './lib/os-harness.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const NSDEMOS = require(path.join(ROOT, 'vendor/netsurf/demos/demos.js'));
const { encodePng } = require(path.join(ROOT, 'tests/lib/png.js'));

const PORT = 3213;
const REMOTE = !!process.env.NS_URL;
const URL = process.env.NS_URL || osUrl(PORT);
const TAG = process.env.NS_TAG || (REMOTE ? 'remote' : 'local');
const MEDIA = process.env.NS_MEDIA || '/Users/jku/git/meta/meta/media/netsurf-bughunt';
const ONLY = process.env.NS_ONLY ? process.env.NS_ONLY.split(',') : null;
const DEMO_BASE = '/root/Desktop/Presentations/samples/Web Demos';

const server = REMOTE ? null : startServer(PORT);
if (!REMOTE) await waitForServer(URL, { tries: 3000, interval: 200 });
const browser = await launchBrowser();
const { check, state } = makeCheck({ stringify: false });
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 300000, polling: 250 });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 60000, polling: 200 });

  const { setVt, waitOut, waitScreen } = osHelpers(page);
  const type = async (cmd) => { await page.keyboard.type(cmd + '\r'); };

  await setVt(1);
  // Ensure the demo seed (minimal deploys ship it as the gucman package).
  await type(`ls "${DEMO_BASE}/paint" >/dev/null 2>&1 && echo SEED-O''K || echo SEED-MIS''SING`);
  await page.waitForFunction(() => /SEED-OK|SEED-MISSING/.test(window.__osOut), null, { timeout: 20000, polling: 200 });
  if ((await page.evaluate(() => window.__osOut)).includes('SEED-MISSING')) {
    await type(`gucman install netsurf-demos && echo INST-O''K || echo INST-FAI''LED`);
    await page.waitForFunction(() => /INST-OK|INST-FAILED/.test(window.__osOut), null, { timeout: 180000, polling: 300 });
    check('gucman install netsurf-demos', (await page.evaluate(() => window.__osOut)).includes('INST-OK'));
  }

  await setVt(2);
  await waitScreen();
  await new Promise(r => setTimeout(r, 1500));   // late EV_SCREEN settle (os-ctxmenu gotcha)
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });

  // Capture the SURFACE of the window at (wx,wy,w,h) off the composited
  // desktop canvas as { w, h, rgb } — the page-pixel space the INTERACTIONS
  // regions are declared in.
  const grabSurface = async (wx, wy, w, h) => {
    const b64 = await page.evaluate(([sx, sy, sw, sh]) => {
      const c = document.getElementById('screen');
      const r = c.getBoundingClientRect();
      const t = document.createElement('canvas');
      t.width = Math.round(r.width); t.height = Math.round(r.height);
      const ctx = t.getContext('2d');
      ctx.drawImage(c, 0, 0);
      const d = ctx.getImageData(sx, sy, sw, sh).data;
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
  const DEMOS = NSDEMOS.demos().filter(d => !ONLY || ONLY.includes(d.name));
  for (const d of DEMOS) {
    const ia = NSDEMOS.INTERACTIONS[d.name];
    if (!ia) { check(`${d.name}: has an INTERACTIONS entry`, false); continue; }
    console.log(`\n== ${d.name}`);

    await setVt(1);
    await type(`netsurf "${DEMO_BASE}/${d.name}/index.html" &`);
    await type(`wmctl wait win "${d.title}" 60000 && echo UP-''${d.name} || echo NOWIN-''${d.name}`);
    await page.waitForFunction((n) => new RegExp('UP-' + n + '|NOWIN-' + n).test(window.__osOut), d.name,
                               { timeout: 90000, polling: 200 });
    if (!(await page.evaluate(() => window.__osOut)).includes('UP-' + d.name)) {
      check(`${d.name}: window came up`, false); continue;
    }
    // Split needles: the tty echoes the TYPED line into __osOut, so an
    // unsplit marker is satisfied by its own echo (the 0089 trap).
    await type(`echo ==G-''${d.name}; wmctl list; echo ==E-''${d.name}`);
    await waitOut(`==E-${d.name}`, 20000);
    const seg = (await page.evaluate(() => window.__osOut)).split(`==G-${d.name}`).pop().split(`==E-${d.name}`)[0];
    const row = seg.split('\n').map(l => l.trim().split('\t')).find(c => c[6] === d.title);
    const gm = row && row[2].match(/^(\d+)x(\d+)\+(\d+)\+(\d+)$/);
    if (!gm) { check(`${d.name}: window geometry`, false); continue; }
    const [, Ws, Hs, WXs, WYs] = gm;
    const W = +Ws, H = +Hs, WX = +WXs, WY = +WYs;
    const sid = row[0];

    await setVt(2);
    const at = ([x, y]) => [rect.x + WX + x, rect.y + WY + y];
    const shots = {};
    for (const ph of ia.phases) {
      for (const st of ph.do) {
        if (st.click) await page.mouse.click(...at(st.click));
        else if (st.down) { await page.mouse.move(...at(st.down)); await page.mouse.down(); }
        else if (st.move) await page.mouse.move(...at(st.move));
        else if (st.up) { await page.mouse.move(...at(st.up)); await page.mouse.up(); }
        else if (st.type) await page.keyboard.type(st.type);
        else if (st.settle) await new Promise(r => setTimeout(r, st.settle));  // declared timer settle
        else throw new Error('unknown step ' + JSON.stringify(st));
      }
      // One event-loop breath so the injected input's repaint composites.
      await new Promise(r => setTimeout(r, 300));
      const shot = await grabSurface(WX, WY, W, H);
      shots[ph.name] = shot;
      fs.writeFileSync(path.join(MEDIA, `${d.name}-${ph.name}-${TAG}.png`), encodePng(shot.w, shot.h, shot.rgb));
      for (const e of (ph.expect || [])) {
        const fail = NSDEMOS.evalExpect(e, shot, shots);
        check(`${d.name}/${ph.name}: ${JSON.stringify(e)}`, fail === null, fail);
      }
    }

    await setVt(1);
    await type(`wmctl close ${sid} && wmctl wait nowin "${d.title}" 8000 && echo CLOSED-''${d.name}`);
    await waitOut(`CLOSED-${d.name}`, 20000);
    await setVt(2);
  }
} catch (e) {
  console.error('FAIL: ' + (e && e.message));
  state.failures++;
} finally {
  await browser.close();
  if (server) server.kill();
}
console.log(state.failures === 0 ? `\nnsdemos interact (${TAG}): PASS` : `\nnsdemos interact (${TAG}): ${state.failures} FAILED`);
process.exit(state.failures === 0 ? 0 : 1);
