// #752: browser's real rapid-spawn workload and forced Instance failure.
import fs from 'node:fs';
import {openOsSession} from './lib/os-harness.mjs';
const s = await openOsSession({port:3381});
const {page, check, setVt} = s;
try {
  await setVt(1);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const script = fs.readFileSync(new URL('../fixtures/spawn-build.sh', import.meta.url), 'utf8');
  await page.evaluate(src => navigator.clipboard.writeText(src), script);
  await page.keyboard.type('pbpaste > /root/build.sh; sh /root/build.sh 2>/root/build.err; echo BUILD-RC=$?; cat /root/build.err; echo B""UILD-END\r');
  await page.waitForFunction(() => (window.__osOut || '').includes('BUILD-END'), null, {timeout:180000});
  let out = await page.evaluate(() => window.__osOut || '');
  check('40-module build returns correct answer', out.includes('TOTAL=35100') && out.includes('BUILD-RC=0'), out.slice(-2000));
  check('no spawn failure in burst', !/could not start|SEGV/.test(out), out.slice(-2000));
  // Route only the worker bootstrap, then reload so the warm pool consists
  // of instrumented workers. Product runModule and fd/wait paths are unchanged.
  await s.context.route('**/os/process-worker.js', async route => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({response, body: body + `\n
const originalBoot = self.onmessage;
self.onmessage = function(e) {
  if (e.data.argv && e.data.argv[1] === 'force-start-failure') {
    WebAssembly.Instance = function() { throw new RangeError('WebAssembly.Instance(): Out of memory: browser forced allocation failure'); };
  }
  return originalBoot(e);
};\n`});
  });
  await page.reload();
  await page.waitForFunction(() => window.__osState === 'ready' && /~ #/.test(window.__osOut || ''), null, {timeout:60000});
  await setVt(1);
  const start = await page.evaluate(() => (window.__osOut || '').length);
  await page.keyboard.type('wc force-start-failure 2>/root/start.err; echo START-RC=$?; cat /root/start.err; echo S""TART-END\r');
  await page.waitForFunction(start => (window.__osOut || '').slice(start).includes('START-END'), start, {timeout:30000});
  out = await page.evaluate(start => (window.__osOut || '').slice(start), start);
  check('failed start is exit127', out.includes('START-RC=127') && !out.includes('SEGV'), out);
  check('child stderr carries startup cause', /gucOS: could not start .*wc: RangeError:.*browser forced allocation failure/.test(out), out);
} catch(e) {s.fail(e);}
finally {
  // Warm-pool refill requests can still be inside route.fetch at teardown.
  // Drain those handlers before disposing their APIResponse objects.
  await s.context.unrouteAll({behavior:'wait'});
  await s.close();
}
s.finish('spawn build and startup failure');
