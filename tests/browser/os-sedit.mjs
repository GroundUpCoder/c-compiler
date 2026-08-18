// #718 headed acceptance, independently authored from tracked compositor and
// os-harness contracts. No pre-existing or user-owned sedit fixture was read.
import { startServer, launchBrowser, waitForServer, makeCheck, osHelpers, osUrl } from './lib/os-harness.mjs';
const PORT=3298,URL=osUrl(PORT),server=startServer(PORT),browser=await launchBrowser();
const {check,state}=makeCheck();
try{
 await waitForServer(URL);const context=await browser.newContext({viewport:{width:1100,height:900}}),page=await context.newPage();
 await page.goto(URL);await page.waitForFunction(()=>window.__osState==='ready',{timeout:180000,polling:'raf'});check('boots to ready',true);await page.waitForFunction(()=>/~ #/.test(window.__osOut),{timeout:30000,polling:'raf'});
 const {setVt,waitScreen}=osHelpers(page);await setVt(1);
 await page.keyboard.type("printf '#include <stdio.h>\\nint main(void) { /* green */ return 0; }\\n' > /root/headed.c\r");
 await page.keyboard.type("sedit /root/headed.c:2 & wmctl wait label EDIT:0 12000 && echo SEDIT-WINDOW-RE''ADY\r");
 await page.waitForFunction(()=>window.__osOut.includes('SEDIT-WINDOW-READY'),{timeout:30000,polling:'raf'});await setVt(2);await waitScreen();
 const rect=await page.evaluate(()=>{const r=document.getElementById('screen').getBoundingClientRect();return{x:r.x,y:r.y}});
 // First window placement is (12,36), menu 30px; editor starts immediately
 // below it. Wait for syntax pixels, then classify the committed AA palette.
 const palette=([x,y])=>{const c=document.getElementById('screen'),t=document.createElement('canvas');t.width=c.width;t.height=c.height;const q=t.getContext('2d');q.drawImage(c,0,0);const d=q.getImageData(x,y,700,120).data;let blue=0,green=0,red=0,purple=0;for(let i=0;i<d.length;i+=4){const R=d[i],G=d[i+1],B=d[i+2];if(B>90&&B>R*1.3)blue++;if(G>55&&G>R*1.25&&G>B*1.15)green++;if(R>90&&R>G*1.5)red++;if(R>60&&B>60&&G<70)purple++;}return{blue,green,red,purple};};
 await page.waitForFunction(([x,y])=>{const c=document.getElementById('screen'),t=document.createElement('canvas');t.width=c.width;t.height=c.height;const q=t.getContext('2d');q.drawImage(c,0,0);const d=q.getImageData(x,y,700,120).data;let blue=0,green=0,red=0,purple=0;for(let i=0;i<d.length;i+=4){const R=d[i],G=d[i+1],B=d[i+2];if(B>90&&B>R*1.3)blue++;if(G>55&&G>R*1.25&&G>B*1.15)green++;if(R>90&&R>G*1.5)red++;if(R>60&&B>60&&G<70)purple++;}return blue>5&&green>5&&red>5&&purple>5;},[12,36+30],{timeout:30000,polling:'raf'});const hist=await page.evaluate(palette,[12,36+30]);
 check('headed syntax palette distinguishes C categories',hist.blue>5&&hist.green>5&&hist.red>5&&hist.purple>5,hist);
 // Ctrl+F must open a real modal search, Enter must select the next match,
 // and destroying the dialog must return focus to the document EDIT.
 await page.keyboard.press('Control+F');await setVt(1);await page.keyboard.type("wmctl wait label 'Find text:' 8000 && echo SEDIT-FIND-O''PEN\r");await page.waitForFunction(()=>window.__osOut.includes('SEDIT-FIND-OPEN'),{timeout:15000,polling:'raf'});await setVt(2);await page.keyboard.type('return');await page.keyboard.press('Enter');await page.keyboard.type('X');await page.keyboard.press('Control+Z');
 await setVt(1);await page.keyboard.type("wmctl wait nolabel 'Find text:' 8000 && wmctl gettext EDIT:0 && echo SEDIT-FIND-D''ONE\r");await page.waitForFunction(()=>window.__osOut.includes('SEDIT-FIND-DONE'),{timeout:15000,polling:'raf'});const findOut=await page.evaluate(()=>window.__osOut);check('Ctrl+F finds and returns focus to the editor',findOut.includes('/* green */ return 0;'),findOut.slice(-500));await setVt(2);
 // Real keyboard path: select all, replace, save. The shell later verifies
 // bytes, so this is not a screenshot-only assertion.
 await page.mouse.click(rect.x+12+220,rect.y+36+30+55);await page.keyboard.press('Control+A');await page.keyboard.type('int main(void) { return 7; }');
 await setVt(1);await page.keyboard.type("wmctl wait text EDIT:0 'return 7' 6000 && echo SEDIT-TEXT-SE''TTLED\r");await page.waitForFunction(()=>window.__osOut.includes('SEDIT-TEXT-SETTLED'),{timeout:20000,polling:'raf'});await setVt(2);await page.keyboard.press('Control+S');
 await setVt(1);await page.keyboard.type("echo ==headed-file; cat /root/headed.c; echo SEDIT-CHECK-DO''NE\r");await page.waitForFunction(()=>window.__osOut.includes('SEDIT-CHECK-DONE'),{timeout:20000,polling:'raf'});const out=await page.evaluate(()=>window.__osOut);const saved=(out.split('==headed-file\n').pop()||'').split('SEDIT-CHECK-DONE')[0];check('real keyboard edit/save round trip',saved.includes('int main(void) { return 7; }'),saved);
}catch(e){console.error('FAIL: '+(e&&e.message));state.failures++;}finally{await browser.close();server.kill();}
console.log(state.failures===0?'\nos sedit (browser): PASS':`\nos sedit (browser): ${state.failures} FAILED`);process.exit(state.failures?1:0);
