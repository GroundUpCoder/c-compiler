// EXPOSE (todos/EXPOSE-MISSION-CONTROL.md) browser acceptance: the window
// overview / Exposé with the REAL WebGPU compositor, a real mouse + keyboard.
// This is the leg the headless e2e (test_overview_e2e.js) CANNOT cover: the
// browser compositor's overview pass drawing LIVE, seq-gated miniatures —
// including a gpu-TRANSPORT app (gpubox), which a snapshot design would render
// black (the whole reason Option B was chosen). Covers: `wmctl overview`
// enters (the window's spot clears, a live miniature appears), a gpu app
// miniatures NON-BLACK, a miniature stays LIVE (winbox's fill flip, injected
// past the overview input-swallow, shows up in its miniature), a click picks +
// exits, Esc dismisses, and the taskbar Task-View button toggles it.
// Geometry from the LIVE canvas (__osScreen), never constants.
//
// Usage: node os-overview.mjs
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';

const PORT = 3242;
const URL = osUrl(PORT);

const server = startServer(PORT);
const browser = await launchBrowser();
const { check, state } = makeCheck();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try {
  await waitForServer(URL);
  const context = await browser.newContext({ viewport: { width: 1100, height: 860 } });
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') process.stderr.write('[page] ' + m.text() + '\n'); });

  await page.goto(URL);
  await page.waitForFunction(() => window.__osState === 'ready', { timeout: 180000, polling: 'raf' });
  check('boots to ready', true);
  await page.waitForFunction(() => /~ #/.test(window.__osOut), { timeout: 30000, polling: 'raf' });

  const { setVt, sample, near, waitPixel, waitScreen } = osHelpers(page);
  const TEAL = [0, 128, 128], ORANGE = [255, 140, 0], GREEN = [0, 200, 80],
        BLACK = [0, 0, 0], GRAY = [192, 192, 192];   // GRAY = win32 client margin

  await setVt(2);
  await waitScreen();
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const { w: SW, h: SH } = await page.evaluate(() => window.__osScreen);
  // wm.c overview metrics (MUST MATCH os/wm.c + os/compositor.js).
  const BAR = 36, TH = 28, START_W = 80, TASKVIEW_W = 26;
  // For N=1 the single miniature is centered in the work area, so the work-area
  // centre IS the miniature centre — a geometry-free sample point.
  const MCX = Math.floor(SW / 2), MCY = Math.floor(TH + (SH - BAR - TH) / 2);

  const clickAt = (x, y) => page.mouse.click(rect.x + x, rect.y + y);
  // Type a command on VT1 and wait for a split-needle echo marker.
  const sh = async (cmd, marker) => {
    await setVt(1);
    await page.keyboard.type(cmd + '\r');
    await page.waitForFunction(m => window.__osOut.includes(m), marker,
      { timeout: 20000, polling: 'raf' });
    await setVt(2);
  };
  // Poll a pixel until pred(sample) holds (the "loop the assertion" rule).
  // The default budget is generous because the flake gate pegs the CPU and
  // the WebGPU compositor (esp. the gpu-transport gpubox) is legitimately slow
  // under that starvation — os-gpubox needs ~125s/run under load. These waits
  // ARE satisfiable (os-gpubox proves gpubox composites under load); the long
  // timeout matches the hardship, it does not paper over an unmet condition.
  const waitSample = async (x, y, pred, ms = 40000) => {
    const t0 = Date.now();
    for (;;) {
      const p = await sample(x, y);
      if (pred(p)) return p;
      if (Date.now() - t0 > ms) return p;   // caller asserts on the last read
      await sleep(200);
    }
  };
  // The overview is a TAKEOVER: compositor.js replaces the normal surface loop
  // with the overview pass, so a window's OWN spot must stop showing its fill
  // when the overview is up. Nothing used to assert that — and the two EXIT
  // legs (Esc, Task-View) discriminate "exited" from "still up" ONLY through
  // that precondition, so if the overview regressed to drawing miniatures
  // WITHOUT taking over the screen, every enter leg would still pass and both
  // exit legs would pass trivially while the feature was visibly broken.
  //
  // `probe` must lie inside the window but OUTSIDE its miniature, or the
  // miniature's (identically-coloured) pixels answer the probe instead. For
  // N=1 the miniature is the window at scale 1 CENTERED on (MCX,MCY) — wm.c
  // never magnifies — so that containment test needs no copy of wm.c's cell
  // arithmetic, just the window's own size. A probe that lands inside says so
  // by name rather than failing as a mystery red.
  const assertTakeover = async (label, probe, win, isFill) => {
    if (Math.abs(probe.x - MCX) < win.w / 2 && Math.abs(probe.y - MCY) < win.h / 2)
      throw new Error(`${label}: probe (${probe.x},${probe.y}) lies inside the N=1 ` +
        `miniature centred at (${MCX},${MCY}) size ${win.w}x${win.h} — it cannot ` +
        `distinguish the window from its own miniature; move the probe`);
    const p = await waitSample(probe.x, probe.y, s => !isFill(s));
    check(label, !isFill(p), p);
  };

  // winbox/gpubox sid + client geometry off `wmctl list` (typed on VT1).
  const winGeom = async (title, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      await setVt(1);
      await page.evaluate(() => { window.__osOut = ''; });
      await page.keyboard.type('wmctl list\r');
      await sleep(400);
      const out = await page.evaluate(() => window.__osOut);
      await setVt(2);
      const row = out.split('\n').filter(
        l => l.split('\t').slice(6).join('\t').trim() === title).pop() || '';
      const m = row.match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
      if (m) return { sid: parseInt(row, 10), w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
      if (Date.now() - t0 > ms) throw new Error(`window "${title}" not in wmctl list`);
      await sleep(300);
    }
  };

  // ============================================================= gpu LIVE leg
  // gpubox is a gpu-TRANSPORT app: its miniature must be composited LIVE from
  // the imported ImageBitmap (NOT a black CPU snapshot). gpubox renders a
  // rotating 3D cube in a CENTERED viewport inside a gray win32 client, so the
  // reliable "gpu content" probe is the client/miniature CENTRE (cube/clear),
  // never a corner (gray margin) nor a fixed interior point (the cube spins).
  await sh('gpubox &', '~ #');
  const gb = await winGeom('gpubox');
  const GC = { x: gb.x + Math.floor(gb.w / 2), y: gb.y + Math.floor(gb.h / 2) };
  const gpuContent = p => !near(p, GRAY, 24) && !near(p, TEAL) && !near(p, BLACK, 28);
  await waitSample(GC.x, GC.y, gpuContent, 120000);   // gpu startup is slow under
                                                      // the flake gate's CPU load
  check('gpubox composited a GPU frame at its spot', gpuContent(await sample(GC.x, GC.y)),
    await sample(GC.x, GC.y));

  await sh('wmctl overview && echo OV-E""NTER', 'OV-ENTER');
  await assertTakeover('ENTER: the overview TOOK OVER (gpubox gone from its own spot)',
    GC, gb, gpuContent);
  // For N=1 the single miniature is centred in the work area (= MCX,MCY): it
  // must show gpubox's LIVE gpu content (cube/clear) — a snapshot design would
  // render a gpu app BLACK, so non-black here is the Option-B proof.
  const mini = await waitSample(MCX, MCY, gpuContent);
  check('ENTER: the gpu miniature is LIVE, not a black snapshot (Option B)',
    gpuContent(mini), mini);

  // Pick the miniature -> focus+raise+exit; gpubox returns and re-renders.
  await clickAt(MCX, MCY);
  await waitSample(GC.x, GC.y, gpuContent, 40000);
  check('PICK: clicking the gpu miniature restores gpubox and exits',
    gpuContent(await sample(GC.x, GC.y)), await sample(GC.x, GC.y));
  await sh('SID=$(wmctl list | grep "gpubox$" | sed "s/[^0-9].*//"); wmctl close $SID && echo GB-CLO""SE', 'GB-CLOSE');
  await waitSample(GC.x, GC.y, p => !gpuContent(p));   // gpubox gone from its spot

  // ========================================================== live-flip leg +
  // Esc + taskbar button, on the resizable winbox (orange, flips green on any
  // keydown).
  await sh('winbox &', '~ #');
  const wb = await winGeom('winbox');
  const WP = { x: wb.x + 30, y: wb.y + 30 };
  await waitPixel(WP.x, WP.y, ORANGE, 40000);
  check('winbox composited at its spot (orange)', true);

  const wbFill = p => near(p, ORANGE) || near(p, GREEN);
  await sh('wmctl overview && echo OV-E""NTER2', 'OV-ENTER2');
  await assertTakeover('ENTER: the overview TOOK OVER (winbox gone from its own spot)',
    WP, wb, wbFill);
  await waitSample(MCX, MCY, p => near(p, ORANGE));
  check('ENTER: winbox miniature shows its orange fill', near(await sample(MCX, MCY), ORANGE),
    await sample(MCX, MCY));
  // Poke winbox with a key INJECTED past the overview swallow (INJECT_KEY is
  // post-hit-test) — it flips its fill green and REDRAWS; the live miniature
  // must follow (a static snapshot would not).
  await sh(`wmctl key ${wb.sid} 4 && echo FLI""P`, 'FLIP');   // scancode 4 = 'a'
  const flipped = await waitSample(MCX, MCY, p => near(p, GREEN));
  check('LIVE: injecting a key flips winbox\'s fill and the miniature follows',
    near(flipped, GREEN), flipped);

  // Esc dismisses (the wmKey path — real keyboard); winbox restored, and the
  // flip means its spot is now GREEN.
  await page.keyboard.press('Escape');
  await waitSample(WP.x, WP.y, p => near(p, GREEN) || near(p, ORANGE));
  check('Esc dismisses the overview (winbox restored to its spot)',
    near(await sample(WP.x, WP.y), GREEN) || near(await sample(WP.x, WP.y), ORANGE),
    await sample(WP.x, WP.y));

  // The taskbar Task-View button (right of Start): a click toggles the overview.
  const TVX = START_W + Math.floor(TASKVIEW_W / 2), TVY = SH - Math.floor(BAR / 2);
  await clickAt(TVX, TVY);
  const tvIn = await waitSample(MCX, MCY, p => near(p, GREEN));   // winbox miniature
  check('Task-View button ENTERS the overview', near(tvIn, GREEN), tvIn);
  await assertTakeover('Task-View ENTER also TOOK OVER (winbox gone from its own spot)',
    WP, wb, wbFill);
  await clickAt(TVX, TVY);
  await waitSample(WP.x, WP.y, p => near(p, GREEN));
  check('Task-View button again EXITS the overview',
    near(await sample(WP.x, WP.y), GREEN), await sample(WP.x, WP.y));

} catch (e) {
  check('overview sweep threw: ' + e.message, false);
} finally {
  await browser.close();
  server.kill();
}

process.exit(state.failures ? 1 : 0);
