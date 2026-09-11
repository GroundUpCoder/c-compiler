import '../foundation/arrays-browser.mjs';
import {createRequire} from 'node:module';
import fixture from '../foundation/arrays-os.js';
import {openOsSession,waitFor} from './lib/os-harness.mjs';
const require=createRequire(import.meta.url),fs=require('fs'),path=require('path');
const evidence=require('../foundation/arrays-evidence.js')('os-browser');
fs.writeFileSync(path.join(evidence.directory,'fixture.sh'),fixture.source);
let s;
try{
 s=await openOsSession({port:3376,readyLabel:'Foundation arrays OS ready'});
 const {page,check,setVt}=s;await setVt(1);
 await page.context().grantPermissions(['clipboard-read','clipboard-write']);await page.evaluate(src=>navigator.clipboard.writeText(src),fixture.source);
 await page.keyboard.type('pbpaste > /root/arrays779.sh && sh /root/arrays779.sh; echo ARRAY779-OS-RESULT=$?\r');
 await waitFor(page,()=>/^ARRAY779-OS-RESULT=\d+\r?$/m.test(window.__osOut||''),{timeout:300000,polling:'raf'});
 const out=await page.evaluate(()=>window.__osOut||'');
 const names=[...out.matchAll(/^ARRAY779-OS-PASS (.+)$/gm)].map(m=>m[1].trim());
 const pass=/^ARRAY779-OS-RESULT=0\r?$/m.test(out)&&out.includes('ARRAY779-OS-COUNT='+fixture.count)&&JSON.stringify(names)===JSON.stringify(fixture.names);
 evidence.record({name:'actual-bin-cc',status:pass?'pass':'fail',stdout:out,names});
 check('Foundation arrays /bin/cc in browser process worker',pass,out.slice(-2000));evidence.finish(pass?null:Error('OS arrays failed'));
}catch(e){evidence.finish(e);if(s)s.fail(e);else throw e;}
finally{if(s)await s.close();}
s.finish('Foundation arrays installed library');
