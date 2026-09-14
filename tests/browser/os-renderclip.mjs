// #791: compile once in actual gucOS, run separate CPU and WebGPU processes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openOsSession } from './lib/os-harness.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PORT=3499;
const source=fs.readFileSync(path.join(ROOT,'tests/browser/fixtures/sdl-clip.c'),'utf8');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const dir=path.join(ROOT,'build/renderclip',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(dir,{recursive:true});
const s=await openOsSession({port:PORT,serverTries:2400,serverInterval:250});
const {page,setVt,waitOut,check,waitPixel}=s;
const evidence={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),source:hash(source),files:{},runs:[]};
for(const f of ['host.js','compiler.js','os/process-worker.js','os/image.json','os/os-system.img']){
 const p=path.join(ROOT,f);evidence.files[f]=fs.existsSync(p)?hash(fs.readFileSync(p)):null;
}
try{
 await page.context().grantPermissions(['clipboard-read','clipboard-write']);
 await setVt(1);await page.evaluate(src=>navigator.clipboard.writeText(src),source);
 await page.keyboard.type('pbpaste > /root/clip.c && cc /root/clip.c -o /root/cliptest && echo CLIP-C""OMPILED\r');
 await waitOut('CLIP-COMPILED',180000);
 for(const mode of ['CPU','GPU']){
  await page.keyboard.type(`/root/cliptest${mode==='CPU'?' software':''} & wmctl wait win cliptest 15000 && wmctl move cliptest 40 60 && echo CLIP-U""P-${mode}\r`);
  await waitOut(`CLIP-UP-${mode}`,30000);await waitOut(`CLIP-READY ${mode}`,30000);
  await setVt(2);await s.waitScreen();
  const probes=[[2,2,[12,18,24]],[10,10,[255,0,0]],[25,21,[0,255,0]],[49,21,[255,0,0]],
   [72,20,[12,18,24]],[88,8,[64,32,128]],[103,39,[184,156,128]],[104,20,[12,18,24]],
   [121,9,[0,0,255]],[119,9,[12,18,24]],[150,20,[12,18,24]],
   [9,81,[0,255,255]],[17,89,[255,255,0]],[39,111,[0,255,255]],[65,81,[255,255,255]],[100,100,[12,18,24]]];
  for(const [x,y,c] of probes){await waitPixel(40+x,60+y,c,15000,`${mode} clip ${x},${y}`);check(`${mode} clip ${x},${y}`,true);}
  await page.screenshot({path:path.join(dir,`${mode}.png`)});
  evidence.runs.push({mode,probes:probes.length,screenshot:`${mode}.png`});
  await setVt(1);await page.keyboard.type(`wmctl close cliptest; wmctl wait nowin cliptest 15000 && echo CLIP-D""ONE-${mode}\r`);await waitOut(`CLIP-DONE-${mode}`,30000);
 }
 evidence.browser=await s.browser.version();evidence.output=await page.evaluate(()=>window.__osOut||'');
}catch(e){s.fail(e);evidence.error=String(e.stack||e);}finally{fs.writeFileSync(path.join(dir,'evidence.json'),JSON.stringify(evidence,null,2));await s.close();}
s.finish('SDL clipping CPU and WebGPU');
