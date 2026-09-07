import fs from 'node:fs';
import cp from 'node:child_process';
import {openOsSession} from './lib/os-harness.mjs';
const script = fs.readFileSync(new URL('../fixtures/hush-errexit.sh', import.meta.url), 'utf8');
const expected = cp.execFileSync('/bin/sh', ['-c', script], {encoding:'utf8'});
const s = await openOsSession({port:3382});
try {
  await s.setVt(1);
  await s.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await s.page.evaluate(src => navigator.clipboard.writeText(src), script);
  await s.page.keyboard.type('pbpaste > /root/errexit.sh; sh /root/errexit.sh; echo E""RREXIT-END\r');
  await s.page.waitForFunction(() => (window.__osOut || '').includes('ERREXIT-END'), null, {timeout:60000});
  const out = await s.page.evaluate(() => window.__osOut || '');
  s.check('errexit results match native sh', out.replace(/\r/g,'').includes(expected), out);
} catch(e) {s.fail(e);}
finally {await s.close();}
s.finish('hush errexit');
