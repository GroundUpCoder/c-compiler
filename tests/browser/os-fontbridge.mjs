// #791: actual gucOS CPU/GPU font consumers. Timings are host-call/submission
// latency, not GPU completion, display latency, or a claimed GPU speedup.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openOsSession} from './lib/os-harness.mjs';
import {guestPng} from './lib/guest-png.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PORT = 3498;
const source=fs.readFileSync(path.join(ROOT,'tests/browser/fixtures/fontbridge.c'),'utf8');
const dir=path.join(ROOT,'build/fontbridge-browser',new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(dir,{recursive:true});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const evidence={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),files:{},runs:[],measurement:'CPU-side call/submission latency; not GPU completion or display latency'};
const s=await openOsSession({port:PORT,serverTries:2400,serverInterval:250});
const {page,setVt,waitOut,check}=s;
for(const f of ['host.js','compiler.js','os/process-worker.js','os/image.json','os/os-system.img','os/os-system.img.small.json','tests/browser/fixtures/fontbridge.c']){
 const p=path.join(ROOT,f);evidence.files[f]=fs.existsSync(p)?hash(fs.readFileSync(p)):null;
}
let cpu;
try{
 for(const f of ['host.js','compiler.js','os/process-worker.js']){
  const response=await page.request.get(new URL('/'+f,s.url).href);
  if(!response.ok()||hash(await response.body())!==evidence.files[f])throw new Error('served identity mismatch: '+f);
 }
 await page.context().grantPermissions(['clipboard-read','clipboard-write']);await setVt(1);
 await page.evaluate(src=>navigator.clipboard.writeText(src),source);
 await page.keyboard.type('pbpaste > /root/font.c && cc /root/font.c -o /root/fonttest && echo FONT-C""OMPILED\r');await waitOut('FONT-COMPILED',180000);
 const identityStart=await page.evaluate(()=>window.__osOut.length);
 await page.keyboard.type('sha256sum /root/fonttest /usr/lib/small/runtime.js /usr/lib/fontbridge.wasm; cat /usr/share/os-release; cat /usr/lib/small/snapshot.json; echo FONT-I""DENTIFIED\r');
 await waitOut('FONT-IDENTIFIED',30000);
 evidence.installed=await page.evaluate(start=>window.__osOut.slice(start),identityStart);
 for(const mode of ['CPU','GPU']){
  const start=await page.evaluate(()=>window.__osOut.length);
  await page.keyboard.type(`/root/fonttest${mode==='CPU'?' software':''} & wmctl wait win fontbridge 15000 && wmctl move fontbridge 40 60\r`);
  await page.waitForFunction(({start,mode})=>window.__osOut.slice(start).includes('FONT-READY '+mode),{start,mode},{timeout:90000});
  const out=await page.evaluate(start=>window.__osOut.slice(start),start);
  check(`${mode} cold and warm percentile records`,out.includes(`FONT-PERF ${mode} cold-`)&&out.includes(`FONT-PERF ${mode} warm-`));
  const shot=await guestPng(s,'wmctl shot fontbridge');
  check(`${mode} surface dimensions`,shot.w===512&&shot.h===192);
  let ink=0,childInk=0,leaked=0;
  for(let y=32;y<64;y++)for(let x=16;x<500;x++){const [r,g,b]=shot.px(x,y);if(r>80&&g>80&&b>80)ink++;}
  for(let y=96;y<136;y++)for(let x=0;x<512;x++){const [r,g,b]=shot.px(x,y);if(r>80&&g>80&&b>80){if(x>=80&&x<300)childInk++;else leaked++;}}
  check(`${mode} actual FreeType text ink`,ink>200,{ink});check(`${mode} child text clipped`,childInk>100&&leaked===0,{childInk,leaked});
  if(mode==='CPU')cpu=shot;else{
   let different=0;for(let i=0;i<shot.rgba.length;i++)if(Math.abs(shot.rgba[i]-cpu.rgba[i])>2)different++;
   check('CPU/GPU same font scene within channel tolerance 2',different===0,{different});
  }
  fs.writeFileSync(path.join(dir,`${mode}.png`),shot.bytes);
  fs.writeFileSync(path.join(dir,`${mode}-screen.png`),(await guestPng(s,'wmctl shot screen')).bytes);
  evidence.runs.push({mode,ink,childInk,leaked,output:out});
  await page.keyboard.type(`wmctl close fontbridge; wmctl wait nowin fontbridge 15000 && echo FONT-D""ONE-${mode}\r`);await waitOut(`FONT-DONE-${mode}`,30000);
 }
 evidence.browser=await s.browser.version();
}catch(e){s.fail(e);evidence.error=String(e.stack||e);}finally{fs.writeFileSync(path.join(dir,'evidence.json'),JSON.stringify(evidence,null,2));await s.close();}
s.finish('fontbridge CPU and WebGPU');
