#!/usr/bin/env node
'use strict';
// #783: captured WebKit26.5 stack from the actual one-record diagnostic:
// c-compiler-async782/build/async782/trap-observation-v1-a4dDUo/run.json.
// This is a captured-engine formatter regression, NOT a browser execution.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const realm = vm.createContext({ TextEncoder, TextDecoder, WebAssembly });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../host.js'), 'utf8'), realm);
const format = vm.runInContext('formatTrapReport', realm);
const captured = '57@wasm-function[57]\n@http://127.0.0.1:59288/host.js:13286:57';
const u = n => { const b=[]; do { const x=n&127; n>>>=7; b.push(x|(n?128:0)); } while(n); return b; };
const str = s => { const b=Array.from(new TextEncoder().encode(s)); return [...u(b.length),...b]; };
const section = (id,b) => [id,...u(b.length),...b];
// Real, valid Wasm module with 58 functions; custom debug sections are test
// data. The map deliberately has an entry at zero: fabricating offset zero
// for an index-only frame would falsely attribute it to fixture.c:73.
function moduleFor(named, mapped) {
  let bytes=[0,97,115,109,1,0,0,0,
    ...section(1,[1,96,0,0]),
    ...section(3,[58,...Array(58).fill(0)]),
    ...section(10,[58,...Array.from({length:58},()=>[2,0,11]).flat()])];
  if(named) bytes.push(...section(0,[...str('name'),...section(1,[1,57,...str('fault')])]));
  if(mapped) bytes.push(...section(0,[...str('c.sourcemap'),1,...str('fixture.c'),1,0,0,73]));
  return new WebAssembly.Module(new Uint8Array(bytes));
}
const report = (stack,module) => format({message:'unreachable',stack},module,'probe');
let checks=0;
function check(name,fn) { fn();checks++;console.log('PASS '+name); }
for(const named of [false,true]) for(const mapped of [false,true]) {
  check('captured index-only named='+named+' mapped='+mapped,()=>{
    const text=report(captured,moduleFor(named,mapped));
    assert(text && /wasm backtrace/.test(text), 'captured JSC trap must report');
    assert(text.includes(named?'#0  fault':'#0  wasm-function[57]'),text);
    assert(text.includes('[wasm-function[57]]'),text);
    assert(!/\+0x|fixture\.c|host\.js|13286/.test(text),text);
  });
}
check('offset-bearing named mapped frame keeps its actual location',()=>{
 const text=report('    at ignored (wasm://wasm/hash:wasm-function[57]:0x2A)',moduleFor(true,true));
 assert(text.includes('#0  fault  at fixture.c:73'),text);
 assert(text.includes('[wasm-function[57] +0x2a]'),text);
});
check('real zero offset is distinct from absent offset',()=>{
 const text=report('wasm-function[57]:0x0',moduleFor(true,true));
 assert(text.includes('fixture.c:73') && text.includes('+0x0'),text);
});
check('unnamed V8 frame retains index and offset without source map',()=>{
 const text=report('at wasm://wasm/hash:wasm-function[57]:0x2a',moduleFor(false,false));
 assert(text.includes('#0  wasm-function[57]') && text.includes('+0x2a'),text);
 assert(!text.includes('fixture.c'),text);
});
check('mixed frames keep order and only locate known offsets',()=>{
 const text=report(captured+'\n at wasm://wasm/hash:wasm-function[57]:0x2a',moduleFor(true,true));
 assert(text.includes('#0  fault\n') && text.includes('#1  fault  at fixture.c:73'),text);
 assert.strictEqual((text.match(/fixture\.c:73/g)||[]).length,1,text);
});
for(const stack of ['', '@http://127.0.0.1/host.js:13286:57', 'Error: wasm-function[57]',
 '57@wasm-function[57]:0x', '57@wasm-function[57]junk', '57@wasm-function[-1]']) {
 check('non-frame or malformed stack '+JSON.stringify(stack),()=>assert.strictEqual(report(stack,moduleFor(true,true)),null));
}
console.log('PASS '+checks+' captured-stack formatter checks; no browser launched');
