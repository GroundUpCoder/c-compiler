// #790 AUTOMATED real-browser evidence for configure identities and frame
// ownership on the INSTALLED OPFS image — software (shm) AND WebGPU (gpu
// transport) renderers, wmctl resize storms + a real frame drag, screenshots
// of the composited screen (WebGPU copy of the actual canvas, PNG-encoded in
// Node — no Canvas2D, no browser font rendering). Automated Playwright input
// and probes; NOT manual interaction.
//
// The fixture (ui-frames.c) paints every frame in a color that encodes its
// own geometry (R = w & 255, G = h & 255, B = 0x5A). So after a storm the
// screen must show EXACTLY w*h pixels of the final geometry's color and ZERO
// pixels of any earlier geometry's color: a whole frame of the committed
// buffer, never a torn or stale one, with the kernel probes confirming zero
// lock misses and reporting stale acks / rejected frames as they happen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {startServer,launchBrowser,waitForServer,osUrl,osHelpers} from './lib/os-harness.mjs';
const require=createRequire(import.meta.url),{encodePng}=require('../lib/png.js');
const root=path.resolve(import.meta.dirname,'../..');
const dir=path.join(root,'build/test-browser/ui-frames-'+Date.now());fs.mkdirSync(dir,{recursive:true});
const port=3351,url=osUrl(port),server=startServer(port),browser=await launchBrowser();
const source=fs.readFileSync(path.join(import.meta.dirname,'ui-frames.c'),'utf8');
let page;
const evidence={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),kind:'automated Playwright wmctl/mouse resize storms + WebGPU canvas screenshots; no manual interaction',url,files:{},runs:[],
  // the load this run executed under (suite-runner --under-load[=N] exports it; absent = none)
  underLoad:Number(process.env.CC_UNDER_LOAD||0)};
const color=(w,h)=>[w&255,h&255,0x5A];
try {
for(const name of ['host.js','kernel.js','compiler.js','os/image.json','os/compositor.js','os/kernel-worker.js','os/process-worker.js','tests/browser/os-ui-frames.mjs','tests/browser/ui-frames.c']) evidence.files[name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex');
 await waitForServer(url,{tries:2400,interval:100});
 const context=await browser.newContext({viewport:{width:1050,height:800}});page=await context.newPage();
 evidence.browser=browser.version();evidence.errors=[];
 page.on('pageerror',e=>evidence.errors.push(String(e)));
 page.on('console',m=>{if(m.type()==='error')evidence.errors.push(m.text());});
 for(const name of ['os/os-system.img']) evidence.files[name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex');
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
 async function shell(command,marker,timeout=120000) {
   await setVt(1);await page.keyboard.type(command+'\r');
   await page.waitForFunction(m=>window.__osOut.includes(m),marker,{timeout});
 }
 await shell("cat /usr/share/os-release; echo UI-IMAGE-PIN-O''K",'UI-IMAGE-PIN-OK');
 evidence.installed=await page.evaluate(()=>window.__osOut);
 const installedVersion=/(?:^|[\r\n])VERSION_ID=(\d+)/.exec(evidence.installed);
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'os/image.json'),'utf8'));
 if(!installedVersion||Number(installedVersion[1])!==manifest.version)throw Error('installed image version mismatch: '+(installedVersion&&installedVersion[1])+' vs '+manifest.version);
 await shell("cat > /root/ui-frames.c <<'EOF'\n"+source+"EOF\ncc /root/ui-frames.c -o /root/ui-frames && echo UI-COMPILE-O''K",'UI-COMPILE-OK');
 // Read the actual composited canvas via WebGPU (Chromium's page screenshot
 // omits transferred OffscreenCanvas pixels — documented in os-gcode/os-ui-lifecycle).
 let lastShot=null;
 async function capture(name) {
   await setVt(2);await waitScreen();
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
   lastShot=Buffer.from(shot.base64,'base64');
   fs.writeFileSync(path.join(dir,name+'.png'),encodePng(shot.w,shot.h,lastShot));
   return lastShot;
 }
 function countColor([r,g,b]) {
   let n=0;const px=lastShot||new Uint8Array(0);
   for(let i=0;i<px.length;i+=4) if(px[i]===r&&px[i+1]===g&&px[i+2]===b)n++;
   return n;
 }
 // Settle on pixels, never on a nap: capture until the screen shows exactly
 // w*h pixels of the committed color and none of the retired colors.
 async function settle(tag,w,h,retired) {
   let got=-1,stale=0;
   for(let i=0;i<80;i++){
     await capture(tag+'-'+i);
     got=countColor(color(w,h));stale=0;for(const [rw,rh] of retired) stale+=countColor(color(rw,rh));
     if(got===w*h&&stale===0) return {got,stale,captures:i+1};
   }
   throw Error(tag+': screen never settled on a whole '+w+'x'+h+' frame (got '+got+' px, stale '+stale+')');
 }
 let geomN=0;
 async function geometry() {
   // A unique marker per call: the transcript accumulates, so a reused
   // marker would satisfy the wait before the new output arrived.
   const mark='GEOM'+(++geomN)+'-DONE';
   await shell("wmctl list | grep 'UI frames target' | tr '\\t' ' '; echo "+mark.replace('-DONE',"-D''ONE"),mark);
   const out=await page.evaluate(()=>window.__osOut);
   const segs=out.split(mark);
   const m=/(\d+) (\d+) (\d+)x(\d+)\+(-?\d+)\+(-?\d+) [^ ]+ (\d+) [^ ]+ UI frames target/.exec(segs[segs.length-2].split('\n').slice(-6).join('\n'));
   if(!m)throw Error('wmctl list line not found: '+out.slice(-300));
   return {sid:Number(m[1]),w:Number(m[3]),h:Number(m[4]),x:Number(m[5]),y:Number(m[6])};
 }
 const stats=()=>page.evaluate(()=>window.__osCompositorStats());
 for(const driver of ['software','gpu']) {
   await page.evaluate(()=>{window.__osOut='';});
   const before=await stats();
   await shell('/root/ui-frames '+driver+' &','UI-FRAMES-READY');
   const run={driver,phases:[]};
   const s0=await settle(driver+'-01-initial',240,160,[]);
   run.phases.push({phase:'initial 240x160',...s0});
   let g=await geometry();
   if(g.w!==240||g.h!==160)throw Error(driver+': kernel geometry '+g.w+'x'+g.h+' != 240x160');
   // ---- storm 1: rapid wmctl resizes, latest wins, final 400x300 ----
   const storm1=[[300,200],[260,180],[300,200],[320,240],[200,150],[400,300]];
   await shell('S='+g.sid+'; '+storm1.map(([w,h])=>'wmctl resize $S '+w+' '+h).join('; ')+"; wmctl wait dim $S 400x300; echo STORM1-D''ONE",'STORM1-DONE');
   const s1=await settle(driver+'-02-storm1',400,300,[[240,160],...storm1.slice(0,-1)]);
   run.phases.push({phase:'storm1 -> 400x300',...s1});
   // ---- storm 2: end where it started (an equal-size regeneration is a NEW buffer) ----
   const storm2=[[300,200],[400,300],[300,200]];
   await shell('S='+g.sid+"; wmctl resize $S 300 200; wmctl wait dim $S 300x200; wmctl resize $S 400 300; wmctl resize $S 300 200; wmctl wait dim $S 300x200; echo STORM2-D''ONE",'STORM2-DONE');
   const s2=await settle(driver+'-03-storm2',300,200,[[400,300],[240,160]]);
   run.phases.push({phase:'storm2 -> 300x200 (equal-size regeneration)',...s2});
   // ---- storm 3: twenty alternating sizes as fast as the shell issues them ----
   const alt=[];for(let i=0;i<20;i++)alt.push(i%2?[360,240]:[280,220]);
   await shell('S='+g.sid+'; '+alt.map(([w,h])=>'wmctl resize $S '+w+' '+h).join('; ')+"; wmctl wait dim $S 360x240; echo STORM3-D''ONE",'STORM3-DONE');
   const s3=await settle(driver+'-04-storm3',360,240,[[280,220],[300,200]]);
   run.phases.push({phase:'storm3 alternating x20 -> 360x240',...s3});
   // ---- a real frame drag: SE corner, +40/+30 (Win95 outline, one configure at release) ----
   g=await geometry();
   await setVt(2);
   {
     const rect=await page.evaluate(()=>{const r=document.getElementById('screen').getBoundingClientRect();return {x:r.x,y:r.y};});
     await page.mouse.move(rect.x+g.x+g.w+2,rect.y+g.y+g.h+2);
     await page.mouse.down();
     await page.mouse.move(rect.x+g.x+g.w+42,rect.y+g.y+g.h+32,{steps:12});
     await page.mouse.up();
   }
   const s4=await settle(driver+'-05-drag',g.w+40,g.h+30,[[g.w,g.h]]);
   run.phases.push({phase:'frame drag -> '+(g.w+40)+'x'+(g.h+30),...s4});
   const out=await page.evaluate(()=>window.__osOut);
   if(out.includes('INCONSISTENT'))throw Error(driver+': RESIZED event and size queries disagreed');
   const resized=(out.match(/RESIZED \d+ \d+ now \d+ \d+ consistent/g)||[]).length;
   if(resized<5)throw Error(driver+': too few RESIZED events seen: '+resized);
   const geom=/PIXEL-GEOMETRY 240 160 240 160 density 1\.000 scale 1\.000/.test(out);
   if(!geom)throw Error(driver+': pixel geometry line missing or wrong');
   const after=await stats();
   const delta={wmFrames:after.wmFrames-before.wmFrames,configureStale:after.configureStale-before.configureStale,framesRejected:after.framesRejected-before.framesRejected,shmLockMisses:after.shmLockMisses-before.shmLockMisses,shmFlipMisses:after.shmFlipMisses-before.shmFlipMisses,shmContended:after.shmContended-before.shmContended};
   if(driver==='gpu'?delta.wmFrames<=0:delta.wmFrames!==0)throw Error(driver+' transport mismatch: '+delta.wmFrames+' bitmap ships');
   if(delta.shmLockMisses!==0)throw Error(driver+': kernel-side SH_LOCK misses: '+delta.shmLockMisses);
   if(delta.shmFlipMisses!==0)throw Error(driver+': producer-side flip-lock misses: '+delta.shmFlipMisses);
   if(delta.framesRejected!==0)throw Error(driver+': gpu frames rejected: '+delta.framesRejected);
   await shell('S='+g.sid+"; wmctl close $S; echo CLOSE-S''ENT",'CLOSE-SENT');
   await page.waitForFunction(()=>window.__osOut.includes('UI-FRAMES-EXIT'),null,{timeout:60000});
   run.resizedEvents=resized;run.probes=delta;run.transcript=await page.evaluate(()=>window.__osOut);
   evidence.runs.push(run);
 }
 console.log('PASS installed gucOS software and WebGPU resize storms/drag: whole committed frames only, zero lock misses');
} catch(e) { evidence.failure=String(e&&e.message||e); throw e; } finally {
 if(page) evidence.finalTranscript=await page.evaluate(()=>window.__osOut).catch(String);
 fs.writeFileSync(path.join(dir,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log('Evidence: '+dir);await browser.close();server.kill();
}
