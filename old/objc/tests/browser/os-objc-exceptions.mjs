import '../objc/exceptions-browser.mjs';
import {createRequire} from 'node:module';
import fixture from '../objc/exceptions-os.js';
import {openOsSession,waitFor} from './lib/os-harness.mjs';
const require=createRequire(import.meta.url);
const evidence=require('../objc/exceptions-evidence.js')('os-browser');
let s;
try {
  s=await openOsSession({port:3375,readyLabel:'Objective-C exceptions OS ready'});
  const {page,check,setVt}=s;
  await setVt(1);
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);
  await page.evaluate(src=>navigator.clipboard.writeText(src),fixture.source);
  await page.keyboard.type('pbpaste > /root/objc-exceptions.sh && sh /root/objc-exceptions.sh; echo OBJC-EH-RESULT=$?\r');
  await waitFor(page,()=>/OBJC-EH-RESULT=\d+/.test(window.__osOut||''),{timeout:300000,polling:'raf'});
  const out=await page.evaluate(()=>window.__osOut||'');
  const passed=/OBJC-EH-RESULT=0/.test(out)&&out.includes('OBJC-EH-COUNT='+fixture.count);
  evidence.record({name:'actual-bin-cc',status:passed?'pass':'fail',stdout:out});
  check('Objective-C exceptions /bin/cc + browser process-worker',passed,out.slice(-2000));
  evidence.finish(passed?null:new Error('OS exception corpus failed'));
} catch(error) {evidence.finish(error);if(s)s.fail(error);else throw error;}
finally {if(s)await s.close();}
s.finish('Objective-C language/runtime exceptions');
