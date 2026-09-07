// #772: portable compiler corpus plus the real browser OS author/build/run path.
import '../objc/browser.mjs';
import fs from 'node:fs';
import { openOsSession } from './lib/os-harness.mjs';
const source = fs.readFileSync(new URL('../objc/core.m', import.meta.url), 'utf8');
const s = await openOsSession({ port: 3372, readyLabel: 'Objective-C OS boots to ready' });
const { page, check, setVt } = s;
try {
  await setVt(1);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(src => navigator.clipboard.writeText(src), source);
  await page.keyboard.type('pbpaste > /root/core.m && cc -g /root/core.m -o /root/core.out && /root/core.out; echo OBJC-RESULT=$?\r');
  await page.waitForFunction(() => /OBJC-RESULT=\d+/.test(window.__osOut || ''), { timeout: 180000, polling: 'raf' });
  const out = await page.evaluate(() => window.__osOut || '');
  check('Objective-C /bin/cc + browser process-worker exit 0', /OBJC-RESULT=0/.test(out), out.slice(-1500));
} catch (e) { s.fail(e); }
finally { await s.close(); }
s.finish('Objective-C compiler experiment');
