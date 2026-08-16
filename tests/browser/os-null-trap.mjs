// #709 browser-host twin: the real terminal compiles with /bin/cc and the
// shared process-worker/kernel crash path exposes marker + status 139.
import { openOsSession } from './lib/os-harness.mjs';
const PORT = 3369;
const SRC = 'struct S{int x;};\nstatic int f(struct S*p){return p->x;}\nint main(void){struct S*p=0;return f(p);}\n';
const s = await openOsSession({ port: PORT, readyLabel: 'boots to ready' });
const { page, check, setVt, waitOut } = s;
try {
  await setVt(1);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(src => navigator.clipboard.writeText(src), SRC);
  await page.keyboard.type("pbpaste > /root/null.c && cc -g --trap-null-dereference /root/null.c -o /root/null.out && echo CC-OK\r");
  await waitOut('CC-OK', 180000);
  await page.keyboard.type('/root/null.out; echo NULL-RC=$?\r');
  await page.waitForFunction(() => /NULL-RC=\d+/.test(window.__osOut || ''), { timeout: 60000, polling: 'raf' });
  const out = await page.evaluate(() => window.__osOut || '');
  const logs = await page.evaluate(() => (window.__osLogs || []).join('\n'));
  check('browser crash carries generated source marker', /__cc_null_dereference\[\/root\/null\.c:2:member\]/.test(logs), logs.slice(-1200));
  check('browser shell reports 139', /NULL-RC=139/.test(out), out.slice(-500));
} catch (e) { s.fail(e); }
finally { await s.close(); }
s.finish('os null-use trap (browser)');
