// KEYBINDING-OVERRIDE-SYSTEM §4 (CHUNK 3) browser acceptance: wm.c computes
// the kernel key-grab table from the keys.h registry (scheme + user bind.*
// overrides) and pushes it via WMP_GRAB_SET; the kernel routes matches to
// EV_HOTKEY which wm.c dispatches to snap/cycle/menu/sysmenu/overview. This is
// the ONE path that truly exercises the grab table end to end — real
// page.keyboard events enter the kernel's wmKey (the headless `wmctl key`,
// WMP_INJECT_KEY, delivers straight to the app and bypasses wmKey by design,
// so it cannot test a grab). The WINDOWS-scheme identity is proven by
// os-snap.mjs / os-wm.mjs staying green with wm.c now DRIVING the table
// (Meta+arrow / Ctrl+Alt+Tab / Alt+Space still snap / cycle / sysmenu, only now
// via EV_HOTKEY). This file proves the MACOS scheme's three new behaviours on
// the seeded resizable winbox, via the agent view (wmctl list geometry):
//   1. tiling RELOCATES to Ctrl+Alt+arrow — Ctrl+Alt+Left tiles winbox left.
//   2. GUI+arrow is RELEASED to the focused app — winbox toggles its fill on
//      EVERY keydown, so a released GUI+Left delivers BOTH the Meta and the
//      Left keydown (net 2 toggles -> fill unchanged) and does NOT snap; a
//      grabbed chord (windows) would swallow the Left (1 toggle) and tile it.
//      Fill-unchanged is the "GUI+arrow reached the app" proof (the enabler
//      for the macos ⌘Left/⌘Right line-nav rows, whose app-side resolution is
//      covered by test_keymap_e2e / test_keybind_registry).
//   3. a bind.<action> override MOVES a chord live — rebinding wm.snap-left to
//      Ctrl+Alt+J makes that chord tile left and Ctrl+Alt+Left inert, within
//      the config poll, no restart.
// Plus the Ctrl+Alt+E overview grab is installed in both schemes (swallowed,
// not seen by the app) and toggles the Exposé window overview (todos/EXPOSE).
//
// Config propagation to wm.c's grab table is a two-timer (~1 Hz) settle with NO
// completion marker, so instead of a fixed sleep the positive checks POLL the
// real behaviour (retry the tile chord until it tiles) — the test-sync rule's
// "loop the assertion under the wait budget". A chord that is not YET grabbed
// leaves the floating window untouched, so retries are non-destructive; only a
// window that actually tiled is restored (snap-down un-snaps a snapped window,
// but would MINIMISE a floating one — the flake this design avoids).
//
// MEASURED latency: the write lands, then wm's next 1 Hz grab poll re-reads the
// config and pushes the rebuilt table, and the NEXT chord hits it — one poll
// cycle, ~2 s wall (deterministic: 6/6 propagations under 10x CPU load tiled on
// the second retry, ~2.0 s after the write, never a slow-boundary outlier). The
// budget below is therefore a ~10x-margin CEILING that FAILS LOUD, not a settle
// estimate: an oversized nap-budget here (the original 75 s) turns a real
// propagation regression into a silent 75-80 s clock-burn before the check
// fails — exactly the "a wait that can't be satisfied must fail loud, never nap
// out its clock" anti-pattern (CLAUDE.md test-sync discipline). Kept generous
// enough that true ~2 s propagation under load never trips it.
//
// Usage: node os-keybind.mjs
import { openOsSession } from './lib/os-harness.mjs';

// serverTries generous: serve.js re-bakes the image before listening when a
// bake input (wm.c here) changed, which outruns the default 5s server wait.
const s = await openOsSession({
  port: 3231, readyLabel: 'boots to ready', serverTries: 400, serverInterval: 500 });
const { page, check, setVt, sample, near, waitOut } = s;

const ORANGE = [255, 140, 0];

// A held-modifier chord through the REAL keyboard (0090 pacing: explicit
// down / gap / press / gap / up so the kernel sees the modifier on the key).
const chord = async (mods, key) => {
  for (const m of mods) await page.keyboard.down(m);
  await new Promise(r => setTimeout(r, 60));
  await page.keyboard.press(key, { delay: 50 });
  await new Promise(r => setTimeout(r, 60));
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
};

// Run a shell line on VT1, optionally wait for a split-needle echo. -> VT2.
const sh = async (line, marker, ms = 15000) => {
  await setVt(1);
  await page.keyboard.type(line + `\r`);
  if (marker) await waitOut(marker, ms);
  await setVt(2);
};

// wmctl list -> the LAST row whose trailing title == `title`, parsed to
// { sid, w, h, x, y }. The agent view: no pixels.
const winGeom = async (title, ms = 20000) => {
  const t0 = Date.now();
  for (;;) {
    await setVt(1);
    await page.evaluate(() => { window.__osOut = ''; });
    await page.keyboard.type('wmctl list\r');
    await new Promise(r => setTimeout(r, 400));
    const out = await page.evaluate(() => window.__osOut);
    await setVt(2);
    const rows = out.split('\n').filter(
      l => l.split('\t').slice(6).join('\t').trim() === title);
    const row = rows[rows.length - 1] || '';
    const m = row.match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
    if (m) return { sid: parseInt(row, 10), w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
    if (Date.now() - t0 > ms) throw new Error(`window "${title}" not in wmctl list`);
    await new Promise(r => setTimeout(r, 300));
  }
};

// Write the user keys layer (/root/.config/keys — the env-less wm service's
// cfg_home() falls back to /root, the shell's ~). Propagation is polled below.
const setKeys = (content) =>
  sh(`printf '${content}' > /root/.config/keys && echo KEYS-SE""T`, 'KEYS-SET');

try {
  const { w: SW } = await page.evaluate(() => window.__osScreen);
  const HALFW = Math.floor(SW / 2);
  const isHalf = (g) => Math.abs(g.w - HALFW) <= 4 && g.x === 0;
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });

  await sh('mkdir -p /root/.config', undefined);

  await sh('winbox &');
  let g = await winGeom('winbox', 60000);
  check('winbox composited (floating 240x160)', g.w === 240 && g.h === 160, g);
  const WSID = g.sid;
  const focus = () => sh(`wmctl focus ${WSID}`);
  const unsnap = () => sh(`wmctl focus ${WSID} && wmctl snap down`);   // snapped -> floating
  // DOM focus for page.keyboard (leaves winbox's 8x8 mark at buffer (120,80),
  // so probe the fill at buffer (190,40), well clear of it).
  await page.mouse.click(rect.x + g.x + 120, rect.y + g.y + 80);
  await focus();

  // Poll a tile chord until the window actually tiles left (the target config
  // has propagated to wm.c's grab table). Non-destructive: a not-yet-grabbed
  // chord leaves the floating window untouched. Returns the tiled geometry.
  // ms = a loud ceiling ~10x the measured ~2 s propagation, NOT a settle
  // estimate (see the header): true propagation tiles on the 2nd retry, so a run
  // that reaches this bound means the chord never grabbed — a real regression,
  // surfaced within ~20 s with a named diagnostic rather than napping a 75 s
  // clock. On the bound it prints WHY it gave up (test-sync: fix the diagnostic
  // too), then returns the last read so the outer check() fails loud.
  const waitTilesLeft = async (mods, key, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      await focus();
      await chord(mods, key);
      await new Promise(r => setTimeout(r, 700));
      g = await winGeom('winbox');
      if (isHalf(g)) return g;
      if (Date.now() - t0 > ms) {
        process.stderr.write(`os-keybind: ${mods.join('+')}+${key} never tiled ` +
          `in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
          `(last geom ${g.w}x${g.h}+${g.x}+${g.y}) — grab table did not ` +
          `propagate; NOT a slow settle (measured ~2s)\n`);
        return g;                              // last read -> the check fails loud
      }
      await new Promise(r => setTimeout(r, 700));
    }
  };

  // ---- switch to the macos scheme (the whole feature is scheme-gated) ----
  await setKeys('scheme macos\\n');
  check('macos scheme written to /root/.config/keys', true);

  // === 1. tiling RELOCATED to Ctrl+Alt+arrow (also the macos-live gate). ===
  g = await waitTilesLeft(['Control', 'Alt'], 'ArrowLeft');
  check('macos: Ctrl+Alt+Left tiles winbox to the left half', isHalf(g), g);
  await unsnap();                                  // -> floating (it WAS snapped)
  await new Promise(r => setTimeout(r, 500));

  // === 2. GUI+arrow RELEASED: not a grab in macos, so both keydowns reach
  //        winbox (net 2 toggles -> fill unchanged) and it does NOT snap. ===
  await focus();
  g = await winGeom('winbox');
  const px = g.x + 190, py = g.y + 40;
  const before = await sample(px, py);
  await chord(['Meta'], 'ArrowLeft');
  await new Promise(r => setTimeout(r, 600));
  const after = await sample(px, py);
  check('macos: GUI+Left reached the app (fill returned -> the Left was delivered)',
    near(after, before), { before, after });
  g = await winGeom('winbox');
  check('macos: GUI+Left did NOT snap (released, not grabbed)', g.w === 240, g);

  // === Ctrl+Alt+E: the window overview / Exposé chord (todos/EXPOSE),
  //     installed in BOTH schemes and scheme-independent. Pressing it is
  //     GRABBED (winbox never sees 'e') and toggles the overview — the
  //     compositor takes over the screen, so winbox's normal client pixel
  //     changes; pressing again restores it. (The dedicated overview visuals
  //     live in os-overview.mjs; here we only prove the chord is wired.) ===
  await focus();
  const preE = await sample(px, py);
  await chord(['Control', 'Alt'], 'KeyE');
  await new Promise(r => setTimeout(r, 700));
  const inOv = await sample(px, py);
  check('Ctrl+Alt+E entered the overview (compositor took over winbox\'s spot)',
    !near(inOv, preE), { preE, inOv });
  await chord(['Control', 'Alt'], 'KeyE');
  await new Promise(r => setTimeout(r, 700));
  check('Ctrl+Alt+E again exited the overview (winbox restored)',
    near(await sample(px, py), preE), { preE, got: await sample(px, py) });

  // === 3. a bind.<action> override MOVES the chord live (no restart). ===
  await setKeys('scheme macos\\nbind.wm.snap-left ctrl+alt+j\\n');
  g = await waitTilesLeft(['Control', 'Alt'], 'KeyJ');   // the NEW chord tiles left
  check('override live: Ctrl+Alt+J now tiles left (the rebind)', isHalf(g), g);
  await unsnap();
  await new Promise(r => setTimeout(r, 500));

  await focus();
  await chord(['Control', 'Alt'], 'ArrowLeft');           // the OLD chord is inert now
  await new Promise(r => setTimeout(r, 700));
  g = await winGeom('winbox');
  check('override live: Ctrl+Alt+Left no longer snaps (chord moved away)', g.w === 240, g);

  await sh(`echo KEYBIND-SHELL-O""K`, 'KEYBIND-SHELL-OK');
  check('shell alive after the keybind run', true);
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os keybind (browser)');
