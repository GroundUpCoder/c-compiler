// #791: compile once in actual gucOS, run separate CPU and WebGPU processes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openOsSession } from './lib/os-harness.mjs';
import { guestPng } from './lib/guest-png.mjs';
import {imageIdentity,surfaceTransport} from './lib/render-evidence.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PORT = 3499;
const source=fs.readFileSync(path.join(ROOT,'tests/browser/fixtures/sdl-clip.c'),'utf8');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const dir=path.join(ROOT,'build/renderclip',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(dir,{recursive:true});
const s=await openOsSession({port:PORT,serverTries:2400,serverInterval:250});
const {page,setVt,waitOut,check}=s;
const evidence={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),source:hash(source),files:{},runs:[]};
for(const f of ['tests/browser/os-renderclip.mjs','tests/browser/lib/render-evidence.mjs','tests/browser/lib/guest-png.mjs','host.js','compiler.js','os/process-worker.js','os/image.json','os/os-system.img']){
 const p=path.join(ROOT,f);evidence.files[f]=fs.existsSync(p)?hash(fs.readFileSync(p)):null;
}
try{
 evidence.identity=await imageIdentity(s,ROOT);
 for(const f of ['host.js','compiler.js','os/process-worker.js']){
  const response=await page.request.get(new URL('/'+f,s.url).href);
  if(!response.ok()||hash(await response.body())!==evidence.files[f])throw new Error('served identity mismatch: '+f);
 }
 await page.context().grantPermissions(['clipboard-read','clipboard-write']);
 await setVt(1);await page.evaluate(src=>navigator.clipboard.writeText(src),source);
 await page.keyboard.type('pbpaste > /root/clip.c && cc /root/clip.c -o /root/cliptest && echo CLIP-C""OMPILED\r');
 await waitOut('CLIP-COMPILED',180000);
 const identityStart=await page.evaluate(()=>window.__osOut.length);
 await page.keyboard.type('sha256sum /root/cliptest /usr/lib/small/runtime.js /usr/lib/fontbridge.wasm; cat /usr/share/os-release; cat /usr/lib/small/snapshot.json; echo CLIP-I""DENTIFIED\r');
 await waitOut('CLIP-IDENTIFIED',30000);
 evidence.installed=await page.evaluate(start=>window.__osOut.slice(start),identityStart);
 for(const mode of ['CPU','GPU']){
  const start=await page.evaluate(()=>window.__osOut.length);
  await page.keyboard.type(`/root/cliptest${mode==='CPU'?' software':''} & wmctl wait win cliptest 15000 && CLIPSID=$(wmctl list | grep "cliptest$" | sed "s/[^0-9].*//") && wmctl move $CLIPSID 40 60 && echo CLIP-U""P-${mode}\r`);
  await waitOut(`CLIP-UP-${mode}`,30000);await waitOut(`CLIP-READY ${mode}`,30000);
  await setVt(2);await s.waitScreen();
  const probes=[[2,2,[12,18,24]],[10,10,[255,0,0]],[25,21,[0,255,0]],[49,21,[255,0,0]],
   [72,20,[12,18,24]],[88,8,[64,32,128]],[103,39,[184,156,128]],[104,20,[12,18,24]],
   [121,9,[0,0,255]],[119,9,[12,18,24]],[150,20,[12,18,24]],
   [9,81,[0,255,255]],[17,89,[255,255,0]],[39,111,[0,255,255]],[65,81,[255,255,255]],[100,100,[12,18,24]]];
  await page.waitForFunction(start=>window.__osOut.slice(start).includes('CLIP-FRAME'),start,{timeout:30000});
  const surface=await guestPng(s,'wmctl shot $CLIPSID');
  for(const [x,y,c] of probes)check(`${mode} clip ${x},${y}`,s.near(surface.px(x,y).slice(0,3),c,1),surface.px(x,y));
  fs.writeFileSync(path.join(dir,`${mode}.png`),surface.bytes);
  const screen=await guestPng(s,'wmctl shot screen');
  fs.writeFileSync(path.join(dir,`${mode}-screen.png`),screen.bytes);
  evidence.runs.push({mode,transport:await surfaceTransport(s,'cliptest',mode),probes:probes.length,screenshot:`${mode}.png`});
  await setVt(1);await page.keyboard.type(`wmctl close $CLIPSID; wmctl wait nowin cliptest 15000 && echo CLIP-D""ONE-${mode}\r`);await waitOut(`CLIP-DONE-${mode}`,30000);
 }
 evidence.browser=await s.browser.version();evidence.output=await page.evaluate(()=>window.__osOut||'');
}catch(e){s.fail(e);evidence.error=String(e.stack||e);evidence.output=await page.evaluate(()=>window.__osOut||'').catch(String);}finally{fs.writeFileSync(path.join(dir,'evidence.json'),JSON.stringify(evidence,null,2));await s.close();}
s.finish('SDL clipping CPU and WebGPU');
