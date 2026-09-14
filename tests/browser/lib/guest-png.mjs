// Transfer actual gucOS wmctl PNG output without Canvas2D decoding or drawing.
import { parsePng } from '../../lib/png.js';
let captureId=0;
export async function guestPng(s, command) {
 const id=++captureId, {page,setVt}=s;
 await setVt(1);
 const start=await page.evaluate(()=>window.__osOut.length);
 await page.keyboard.type(command+` /tmp/capture.png; echo CAPRC-${id}=$?; echo B""EGIN-${id}; base64 /tmp/capture.png; echo E""ND-${id}\r`);
 await page.waitForFunction(({start,id})=>window.__osOut.slice(start).includes('END-'+id),{start,id},{timeout:30000});
 const out=await page.evaluate(start=>window.__osOut.slice(start),start);
 if(!out.includes(`CAPRC-${id}=0`))throw new Error('guest capture failed: '+out.slice(-1000));
 const encoded=out.replace(/\r/g,'').split(`BEGIN-${id}\n`)[1]?.split(`END-${id}`)[0];
 if(!encoded)throw new Error('guest PNG markers missing: '+out.slice(-1000));
 const bytes=Buffer.from(encoded.replace(/\s/g,''),'base64');
 return {bytes,...parsePng(bytes)};
}
