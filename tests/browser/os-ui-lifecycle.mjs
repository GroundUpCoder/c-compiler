// #789 AUTOMATED real browser keyboard/OPFS installed-image evidence, not manual.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {startServer,launchBrowser,waitForServer,osUrl,osHelpers} from './lib/os-harness.mjs';
const require=createRequire(import.meta.url),{parsePng}=require('../lib/png.js');
const root=path.resolve(import.meta.dirname,'../..');
const dir=path.join(root,'build/test-browser/ui-lifecycle-'+Date.now());fs.mkdirSync(dir,{recursive:true});
const port=3349,url=osUrl(port),server=startServer(port),browser=await launchBrowser();
const source=fs.readFileSync(path.join(import.meta.dirname,'ui-lifecycle.c'),'utf8');
const evidence={kind:'automated Playwright keyboard and screenshot probes; no manual interaction',url,files:{},runs:[]};
for(const name of ['host.js','kernel.js','compiler.js','os/image.json']) evidence.files[name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex');
try {
 await waitForServer(url,{tries:2400,interval:100});
 const context=await browser.newContext({viewport:{width:1050,height:800}}),page=await context.newPage();
 await page.goto(url);await page.waitForFunction(()=>window.__osState==='ready',null,{timeout:180000});
 evidence.served={};
 for(const name of Object.keys(evidence.files)) {
   const response=await fetch(new URL('/'+name,url));
   if(!response.ok)throw Error('fingerprint fetch failed: '+name);
   const sha=crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
   evidence.served[name]=sha;
   if(sha!==evidence.files[name])throw Error('served source mismatch: '+name);
 }
 const {setVt,waitScreen}=osHelpers(page);
 async function shell(command,marker) {
   await setVt(1);await page.keyboard.type(command+'\r');
   await page.waitForFunction(m=>window.__osOut.includes(m),marker,{timeout:120000});
 }
 await shell("cat /usr/share/os-release; echo UI-IMAGE-PIN-O''K",'UI-IMAGE-PIN-OK');
 evidence.installed=await page.evaluate(()=>window.__osOut);
 await shell("cat > /root/ui-lifecycle.c <<'EOF'\n"+source+"EOF\ncc /root/ui-lifecycle.c -o /root/ui-lifecycle && echo UI-COMPILE-O''K",'UI-COMPILE-OK');
 async function count(name) {
   await setVt(2);await waitScreen();
   const bytes=await page.locator('#screen').screenshot({path:path.join(dir,name+'.png')});
   const png=parsePng(bytes);let n=0;
   for(let i=0;i<png.rgba.length;i+=4) if(png.rgba[i]===211&&png.rgba[i+1]===31&&png.rgba[i+2]===171)n++;
   return n;
 }
 for(const driver of ['software','gpu']) {
   await page.evaluate(()=>{window.__osOut='';});
   await shell('/root/ui-lifecycle '+driver+' &','UI-LIFECYCLE-READY');
   const hidden=await count(driver+'-01-hidden');if(hidden!==0)throw Error(driver+' hidden frame flashed: '+hidden);
   async function key(k,marker) {
     await setVt(2);await page.keyboard.press(k);
     await page.waitForFunction(m=>window.__osOut.includes(m),marker,{timeout:15000});
   }
   await key('s','ACTION s 1');
   // Frame readiness is observed from screenshot pixels, not an elapsed nap.
   let shown=0;
   for(let i=0;i<80&&!shown;i++)shown=await count(driver+'-02-shown-'+i);
   if(shown<20000)throw Error(driver+' shown pixels missing: '+shown);
   let out=await page.evaluate(()=>window.__osOut);
   if(out.includes('TARGET-FOCUS 1'))throw Error('show stole focus');
   await key('a','TARGET-FOCUS 1');await count(driver+'-03-active');
   await key('h','ACTION h 1');
   let after=-1;
   for(let i=0;i<80&&after!==0;i++)after=await count(driver+'-04-hidden-'+i);
   if(after!==0)throw Error('hide left pixels');
   await key('q','UI-LIFECYCLE-EXIT');
   evidence.runs.push({driver,hidden,shown,after,transcript:await page.evaluate(()=>window.__osOut)});
 }
 console.log('PASS installed gucOS software and WebGPU hidden/show/activate/hide keyboard probes');
} finally {
 fs.writeFileSync(path.join(dir,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log('Evidence: '+dir);await browser.close();server.kill();
}
