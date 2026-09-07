// #760: the browser worker delivers abort/assert diagnostics on its own fd2.
import fs from 'node:fs';
import {openOsSession} from './lib/os-harness.mjs';
const source = fs.readFileSync(new URL('../fixtures/abort-backtrace.c', import.meta.url), 'utf8');
const s = await openOsSession({port: 3381, readyLabel: 'boots to ready'});
const {page, setVt, check} = s;
try {
  await setVt(1);
  const helpStart = await page.evaluate(() => window.__osOut.length);
  await page.keyboard.type('cc --help; echo HELP-RC=$?; echo H""ELP-DONE\r');
  await page.waitForFunction(start => window.__osOut.slice(start).includes('HELP-DONE'), helpStart, {timeout: 30000});
  const help = await page.evaluate(start => window.__osOut.slice(start), helpStart);
  check('cc --help succeeds with supported controls', help.includes('HELP-RC=0') && help.includes('usage: cc') && help.includes('-fno-inline') && help.includes('__require_source'), help);
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
  // #762: no per-function noinline attributes; the in-OS flag preserves frames.
  const chain = fs.readFileSync(new URL('../fixtures/debug-flags.c', import.meta.url), 'utf8');
  await page.evaluate(src => navigator.clipboard.writeText(src), chain);
  const start = await page.evaluate(() => window.__osOut.length);
  await page.keyboard.type('pbpaste > /root/chain.c; cc -g2 -fno-inline /root/chain.c -o /root/chain && /root/chain 2>/tmp/chain.err; echo CHAIN-RC=$?; cat /tmp/chain.err; echo D""ONE-chain\r');
  await page.waitForFunction(start => window.__osOut.slice(start).includes('DONE-chain'), start, {timeout: 30000});
  const out = await page.evaluate(start => window.__osOut.slice(start), start);
  check('-g2 -fno-inline runs and traps', out.includes('CHAIN-RC=139'), out);
  check('uninlined caller chain and actual trap line',
    ['depth3','depth2','depth1','main'].every(n => new RegExp('#\\d+\\s+'+n+'\\s+at ').test(out)) && out.includes('/root/chain.c:1'), out);
} catch (e) { s.fail(e); }
finally { await s.close(); }
s.finish('abort backtraces (browser)');
