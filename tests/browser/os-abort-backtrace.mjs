// #760: the browser worker delivers abort/assert diagnostics on its own fd2.
import fs from 'node:fs';
import {openOsSession} from './lib/os-harness.mjs';
const source = fs.readFileSync(new URL('../fixtures/abort-backtrace.c', import.meta.url), 'utf8');
const s = await openOsSession({port: 3381, readyLabel: 'boots to ready'});
const {page, setVt, check} = s;
try {
  await setVt(1);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(src => navigator.clipboard.writeText(src), source);
  await page.keyboard.type('pbpaste > /root/abort.c; cc -g /root/abort.c -o /root/abort.out; echo BUILD-RC=$?\r');
  await page.waitForFunction(() => /BUILD-RC=\d+/.test(window.__osOut), null, {timeout: 90000});
  check('fixture compiled', (await page.evaluate(() => window.__osOut)).includes('BUILD-RC=0'));
  for (const mode of ['abort', 'assert', 'exit', 'handled']) {
    const start = await page.evaluate(() => window.__osOut.length);
    await page.keyboard.type('/root/abort.out ' + mode + ' 2>/tmp/abort.err; echo RC=$?; cat /tmp/abort.err; echo D""ONE-' + mode + '\r');
    await page.waitForFunction(({start, mode}) => window.__osOut.slice(start).includes('DONE-' + mode), {start, mode}, {timeout: 30000});
    const out = await page.evaluate(start => window.__osOut.slice(start), start);
    check(mode + ' status134', out.includes('RC=134'), out);
    check(mode + ' backtrace discriminator', out.includes('wasm backtrace') === (mode !== 'exit'), out);
    if (mode !== 'exit') check(mode + ' full caller chain and source', ['depth3', 'depth2', 'depth1', 'main', '/root/abort.c:'].every(n => out.includes(n)) && !out.includes('wasm trap'), out);
    if (mode === 'assert') check('assert predicate preserved', out.includes('Assertion failed:'), out);
    if (mode === 'handled') check('SIGABRT handler still executes', out.includes('handled 6'), out);
  }
} catch (e) { s.fail(e); }
finally { await s.close(); }
s.finish('abort backtraces (browser)');
