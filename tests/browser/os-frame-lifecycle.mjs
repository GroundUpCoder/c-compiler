// #764: browser worker faults must settle, reap, and remove their surfaces.
import fs from 'node:fs';
import { openOsSession } from './lib/os-harness.mjs';
const source = fs.readFileSync(new URL('../fixtures/frame-lifecycle.c', import.meta.url), 'utf8');
const s = await openOsSession({port: 3379, readyLabel: 'boots to ready'});
const {page, check, setVt} = s;
try {
  await setVt(1);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(src => navigator.clipboard.writeText(src), source);
  await page.keyboard.type('pbpaste > /root/frame.c && cc -g /root/frame.c -o /root/frame.out && cc -g -DFRAME_EXIT /root/frame.c -o /root/exit.out; echo BUILT-RC=$?\r');
  await page.waitForFunction(() => /BUILT-RC=\d+/.test(window.__osOut || ''), null, {timeout: 180000});
  check('both fixtures compile', /BUILT-RC=0/.test(await page.evaluate(() => window.__osOut || '')));
  for (const [binary, code] of [['frame', 139], ['exit', 23]]) {
    const start = await page.evaluate(() => (window.__osOut || '').length);
    await page.keyboard.type('rm -f /tmp/frame-go; /root/' + binary + '.out 2>/tmp/frame.err &\r');
    await page.keyboard.type('PID=$!; wmctl wait win frame-lifecycle 10000; touch /tmp/frame-go; wait $PID; echo RESULT-' + binary + '=$?; wmctl wait nowin frame-lifecycle 10000; echo GONE-' + binary + '=$?; cat /tmp/frame.err; echo E""ND-' + binary + '\r');
    await page.waitForFunction(({start, binary}) => (window.__osOut || '').slice(start).includes('END-' + binary), {start, binary}, {timeout: 30000});
    const out = await page.evaluate(start => (window.__osOut || '').slice(start), start);
    check(binary + ' status is ' + code, out.includes('RESULT-' + binary + '=' + code), out.slice(-1500));
    check(binary + ' window removed', out.includes('GONE-' + binary + '=0'), out.slice(-1000));
    check(binary + ' backtrace only on trap', /backtrace/.test(out) === (binary === 'frame'), out.slice(-1500));
  }
} catch (e) { s.fail(e); }
finally { await s.close(); }
s.finish('frame lifecycle (browser)');
