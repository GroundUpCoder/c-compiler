// Focused repro for the os-aero peek flake (0168 gate debugging; delete or
// keep as a scratch driver). Boots, launches alphabox, hovers the taskbar
// button, waits 6s, reports the popup pixel + wm's [peekdbg] stderr lines
// (wm stderr -> kernel tty -> window.__osOut).
import { openOsSession } from '../tests/browser/lib/os-harness.mjs';

const s = await openOsSession({ port: 3248, serverTries: 1200 });
const { page, setVt, waitScreen, waitPixel, sample, close } = s;
try {
  await setVt(1);
  await page.keyboard.type('winbox alpha &\r');
  await setVt(2);
  await waitScreen();
  const rect = await page.evaluate(() => {
    const r = document.getElementById('screen').getBoundingClientRect();
    return { x: r.x, y: r.y };
  });
  const { h: SH } = await page.evaluate(() => window.__osScreen);
  await waitPixel(12 + 120, 36 + 80, [96, 96, 224], 60000);   // alphabox blend up
  const BARY = SH - 14;
  await page.mouse.move(rect.x + 100, rect.y + BARY);
  // Poll like the real test: a healthy popup is only up until the 2.5s
  // idle-dismiss (the pointer sits still), so a late one-shot sample
  // cannot distinguish healthy from broken.
  let px = [0, 0, 0], deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    px = await sample(108, SH - 28 - 4 - 60);
    if (px[2] > 200 && px[0] < 60) break;
    await new Promise(r => setTimeout(r, 150));
  }
  await setVt(1);
  await page.keyboard.type('wmctl list\r');
  await new Promise(r => setTimeout(r, 1500));
  const outTail = await page.evaluate(() => window.__osOut.split('\n')
    .filter(l => l.includes('peekdbg') || /^\s*\d+\s+\d+/.test(l)).join('\n'));
  console.log('popup center pixel:', px, px[2] > 200 ? '(BLUE = popup up)' : '(no popup)');
  console.log('wm debug:\n' + (outTail || '  (no peekdbg lines — bar_motion never ran)'));
} finally {
  await close();
}
