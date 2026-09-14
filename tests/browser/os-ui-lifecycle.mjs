// #789 AUTOMATED real browser keyboard/OPFS installed-image evidence, not manual.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {startServer,launchBrowser,waitForServer,osUrl,osHelpers} from './lib/os-harness.mjs';
const require=createRequire(import.meta.url),{encodePng}=require('../lib/png.js');
const root=path.resolve(import.meta.dirname,'../..');
const dir=path.join(root,'build/test-browser/ui-lifecycle-'+Date.now());fs.mkdirSync(dir,{recursive:true});
const port=3349,url=osUrl(port),server=startServer(port),browser=await launchBrowser();
const source=fs.readFileSync(path.join(import.meta.dirname,'ui-lifecycle.c'),'utf8');
let page;
const evidence={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),kind:'automated Playwright keyboard and screenshot probes; no manual interaction',url,files:{},runs:[]};
try {
for(const name of ['host.js','kernel.js','compiler.js','os/image.json','os/kernel-worker.js','os/process-worker.js','tests/browser/os-ui-lifecycle.mjs','tests/browser/ui-lifecycle.c']) evidence.files[name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex');
 await waitForServer(url,{tries:2400,interval:100});
 const context=await browser.newContext({viewport:{width:1050,height:800}});page=await context.newPage();
 evidence.browser=browser.version();evidence.errors=[];
 page.on('pageerror',e=>evidence.errors.push(String(e)));
 page.on('console',m=>{if(m.type()==='error')evidence.errors.push(m.text());});
 for(const name of ['os/os-system.img','os/os-system.img.small.json']) evidence.files[name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex');
 evidence.small=JSON.parse(fs.readFileSync(path.join(root,'os/os-system.img.small.json'),'utf8'));
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
 await shell("cat /usr/share/os-release; cat /usr/lib/small/snapshot.json; echo UI-IMAGE-PIN-O''K",'UI-IMAGE-PIN-OK');
 evidence.installed=await page.evaluate(()=>window.__osOut);
 const installedVersion=/(?:^|[\r\n])VERSION_ID=(\d+)/.exec(evidence.installed);
 const installedSmall=/\{"format":1,"sha256":"([a-f0-9]{64})"\}/.exec(evidence.installed);
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'os/image.json'),'utf8'));
 if(!installedVersion||Number(installedVersion[1])!==manifest.version)throw Error('installed image version mismatch');
 if(!installedSmall||installedSmall[1]!==evidence.small.smallSnapshot)throw Error('installed Small snapshot mismatch');
 await shell("cat > /root/ui-lifecycle.c <<'EOF'\n"+source+"EOF\ncc /root/ui-lifecycle.c -o /root/ui-lifecycle && echo UI-COMPILE-O''K",'UI-COMPILE-OK');
 async function count(name) {
   await setVt(2);await waitScreen();
   // Chromium's page screenshot omits transferred OffscreenCanvas pixels
   // (also documented in os-gcode). Read the actual composited canvas via
   // WebGPU, then encode PNG in Node; no Canvas2D or browser font rendering.
   const shot=await page.evaluate(async()=>{
     const c=document.getElementById('screen'),{w,h}=window.__osScreen;
     const d=window.__uiCaptureDevice ||= await (await navigator.gpu.requestAdapter()).requestDevice();
     const texture=d.createTexture({size:[w,h],format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC|GPUTextureUsage.RENDER_ATTACHMENT});
     const pitch=Math.ceil(w*4/256)*256;
     const buffer=d.createBuffer({size:pitch*h,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
     const bitmap=await createImageBitmap(c);
     d.queue.copyExternalImageToTexture({source:bitmap},{texture},[w,h]);
     bitmap.close();
     const enc=d.createCommandEncoder();enc.copyTextureToBuffer({texture},{buffer,bytesPerRow:pitch},[w,h]);d.queue.submit([enc.finish()]);
     await buffer.mapAsync(GPUMapMode.READ);
     const mapped=new Uint8Array(buffer.getMappedRange()),rgba=new Uint8Array(w*h*4);
     for(let y=0;y<h;y++)rgba.set(mapped.subarray(y*pitch,y*pitch+w*4),y*w*4);
     buffer.unmap();buffer.destroy();texture.destroy();
     let binary='';for(let i=0;i<rgba.length;i+=16384)binary+=String.fromCharCode(...rgba.subarray(i,i+16384));
     return {w,h,base64:btoa(binary)};
   });
   const rgba=Buffer.from(shot.base64,'base64');
   fs.writeFileSync(path.join(dir,name+'.png'),encodePng(shot.w,shot.h,rgba));
   let n=0;lastShot=rgba;
   for(let i=0;i<rgba.length;i+=4) if(rgba[i]===211&&rgba[i+1]===31&&rgba[i+2]===171)n++;
   return n;
 }
 let lastShot=null;
 // Count another solid fill in the LAST capture (the popup's yellow, #794).
 async function countColor(r,g,b) {
   let n=0;const px=lastShot||new Uint8Array(0);
   for(let i=0;i<px.length;i+=4) if(px[i]===r&&px[i+1]===g&&px[i+2]===b)n++;
   return n;
 }
 for(const driver of ['software','gpu']) {
   await page.evaluate(()=>{window.__osOut='';});
   const before=await page.evaluate(()=>window.__osCompositorStats());
   await shell('/root/ui-lifecycle '+driver+' &','UI-LIFECYCLE-READY');
   const hidden=await count(driver+'-01-hidden');if(hidden!==0)throw Error(driver+' hidden frame flashed: '+hidden);
   async function key(k,marker) {
     await setVt(2);await page.keyboard.press(k);
     await page.waitForFunction(m=>window.__osOut.includes(m),marker,{timeout:15000});
   }
   await key('s','ACTION s 1');
   // Frame readiness is observed from screenshot pixels, not an elapsed nap.
   let shown=0;
   for(let i=0;i<80&&shown<20000;i++)shown=await count(driver+'-02-shown-'+i);
   if(shown<20000)throw Error(driver+' shown pixels missing: '+shown);
   const shownStats=await page.evaluate(()=>window.__osCompositorStats());
   const gpuShips=shownStats.wmFrames-before.wmFrames;
   if(driver==='gpu' ? gpuShips<=0 : gpuShips!==0)throw Error(driver+' transport mismatch: '+gpuShips+' bitmap ships');
   let out=await page.evaluate(()=>window.__osOut);
   if(out.includes('TARGET-FOCUS 1'))throw Error('show stole focus');
   await key('a','TARGET-FOCUS 1');await count(driver+'-03-active');
   await key('h','ACTION h 1');
   let after=-1;
   for(let i=0;i<80&&after!==0;i++)after=await count(driver+'-04-hidden-'+i);
   if(after!==0)throw Error('hide left pixels');
   // ---- #794: owner relation + effective visibility ----
   await key('s','ACTION s 1');
   let reshown=0;for(let i=0;i<80&&reshown<20000;i++)reshown=await count(driver+'-05-reshown-'+i);
   if(reshown<20000)throw Error(driver+' re-show pixels missing: '+reshown);
   await key('o','ACTION o 1');           // target is now owned by control
   await key('c','ACTION c 1');           // hide the OWNER only
   await page.waitForFunction(()=>window.__osOut.includes('TARGET-VIEWABLE 0 hidden=0'),null,{timeout:15000});
   let ownerHidden=-1;for(let i=0;i<80&&ownerHidden!==0;i++)ownerHidden=await count(driver+'-06-owner-hidden-'+i);
   if(ownerHidden!==0)throw Error(driver+' owned window stayed on screen under a hidden owner: '+ownerHidden);
   await key('v','ACTION v 1');           // show the owner: the owned window comes back by itself
   await page.waitForFunction(()=>window.__osOut.includes('TARGET-VIEWABLE 1 hidden=0'),null,{timeout:15000});
   let ownerShown=0;for(let i=0;i<80&&ownerShown<20000;i++)ownerShown=await count(driver+'-07-owner-shown-'+i);
   if(ownerShown<20000)throw Error(driver+' owned window did not return with its owner: '+ownerShown);
   // ---- #794: popup dismissal is reason 1, a close request is reason 0 ----
   await key('p','ACTION p 1');
   let popupPx=0;for(let i=0;i<80&&popupPx<1000;i++){await count(driver+'-08-popup-'+i);popupPx=await countColor(240,220,20);}
   if(popupPx<1000)throw Error(driver+' popup pixels missing: '+popupPx);
   await setVt(2);
   {  // a press on the desktop, outside the popup's window tree (canvas-relative, the os-wm.mjs idiom)
     const rect=await page.evaluate(()=>{const r=document.getElementById('screen').getBoundingClientRect();return {x:r.x,y:r.y};});
     await page.mouse.click(rect.x+3,rect.y+3);
   }
   await page.waitForFunction(()=>window.__osOut.includes('CLOSE-REASON 1 popup'),null,{timeout:15000});
   let popupGone=-1;for(let i=0;i<80&&popupGone!==0;i++){await count(driver+'-09-popup-dismissed-'+i);popupGone=await countColor(240,220,20);}
   if(popupGone!==0)throw Error(driver+' dismissed popup still painted: '+popupGone);
   await shell('S=$(wmctl list | grep "UI lifecycle target" | sed "s/[^0-9].*//"); wmctl close $S; echo CLOSE-S""ENT','CLOSE-SENT');
   await page.waitForFunction(()=>window.__osOut.includes('CLOSE-REASON 0 target'),null,{timeout:15000});
   // The app vetoed the close and kept pumping: it must still be alive and
   // responsive after the kernel's grace window, never force-quit.
   await page.waitForFunction(()=>new Promise(r=>setTimeout(()=>r(true),5500)),null,{timeout:20000});
   await key('a','ACTION a 1');
   const vetoed=await count(driver+'-10-vetoed-alive');if(vetoed<20000)throw Error(driver+' target gone after a vetoed close: '+vetoed);
   await key('q','UI-LIFECYCLE-EXIT');
   const finalOut=await page.evaluate(()=>window.__osOut);
   if(!finalOut.includes('OWNER-CASCADE 1'))throw Error(driver+' destroying the owner did not cascade to the owned window');
   evidence.runs.push({driver,hidden,shown,after,reshown,ownerHidden,ownerShown,popupPx,popupGone,vetoed,gpuShips,transcript:finalOut});
 }
 console.log('PASS installed gucOS software and WebGPU hidden/show/activate/hide + owner/viewable/dismiss-reason/veto keyboard probes');
} finally {
 if(page) evidence.finalTranscript=await page.evaluate(()=>window.__osOut).catch(String);
 fs.writeFileSync(path.join(dir,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log('Evidence: '+dir);await browser.close();server.kill();
}
