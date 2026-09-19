import '../foundation/browser.mjs';
import fixture from '../foundation/os-script.js';
import {openOsSession,waitFor} from './lib/os-harness.mjs';
const s=await openOsSession({port:3373,readyLabel:'Foundation OS boots to ready'});
const {page,check,setVt}=s;
try {
  await setVt(1);
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.evaluate(src=>navigator.clipboard.writeText(src),fixture.source);
  await page.keyboard.type('pbpaste > /root/foundation-test.sh && sh /root/foundation-test.sh; echo FOUNDATION-OS-RESULT=$?\r');
  await waitFor(page,()=>/FOUNDATION-OS-RESULT=\d+/.test(window.__osOut||''),{timeout:180000,polling:'raf'});
  const out=await page.evaluate(()=>window.__osOut||'');
  check('Foundation /bin/cc + browser process-worker exit 0',/FOUNDATION-OS-RESULT=0/.test(out)&&out.includes('FOUNDATION-OS-COUNT='+fixture.count),out.slice(-2000));
} catch(e) {s.fail(e);}
finally {await s.close();}
s.finish('Foundation installed source library');
