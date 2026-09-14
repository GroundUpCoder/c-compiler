'use strict';
// #791: real compiled FreeType/fontcore module and real process-local loader.
const fs=require('fs'),path=require('path'),assert=require('assert');
const ROOT=path.resolve(__dirname,'../..');
const HOST=require('../../host.js'), COMMON=require('../../os/os-common.js'), C=require('../../compiler.js');
const bytes=COMMON.buildProject(C,'os/fontbridge/bin.json',p=>fs.readFileSync(path.join(ROOT,p),'utf8'),{debug:true});
const B=HOST.BLOCK_FS,kfs=B.create(new B.MemoryByteStore(16*1024*1024));
for(const p of ['/usr','/usr/lib','/usr/share','/usr/share/fonts','/etc','/etc/fonts'])kfs.mkdir(p,0o755);
function put(p,b){const fd=kfs.open(p,0x241,0o644);assert(fd!==null);kfs.write(fd,b,b.length);kfs.close(fd);}
put('/usr/lib/fontbridge.wasm',bytes);put('/usr/share/fonts/mono.ttf',fs.readFileSync(path.join(ROOT,'vendor/fonts/NotoSansMono-Regular.ttf')));
put('/usr/share/fonts/sans.ttf',fs.readFileSync(path.join(ROOT,'vendor/fonts/NotoSans-Regular.ttf')));
put('/bad.ttf',new Uint8Array([1,2,3]));
const memory=new WebAssembly.Memory({initial:16});
const text=p=>{const b=new Uint8Array(memory.buffer);let e=p;while(b[e])e++;return new TextDecoder().decode(b.subarray(p,e));};
const e=HOST.createFontBridge({fs:kfs,getMemory:()=>memory,readString:text});
const stage=(s,p=128)=>{const b=new TextEncoder().encode(s);new Uint8Array(memory.buffer).set(b,p);new Uint8Array(memory.buffer)[p+b.length]=0;return b.length;};
assert.equal(e.__font_abi(),1);
const font=e.__font_open(0,20,0);assert(font>0);assert(e.__font_metric(font,0)>0);
const a=e.__font_glyph(font,65);assert(a>0);const n=e.__font_result_field(a,5);assert(n>0);assert.equal(e.__font_result_copy(a,65536,n-1,0xffffffff),-2);
assert.equal(e.__font_result_copy(a,65536,n,0xffffffff),n);
const expected=new Uint8Array(memory.buffer,65536,n).slice();assert(expected.some((v,i)=>i%4===3&&v>0));
// Old results remain owned across cache churn, memory growth, and font close.
for(let cp=32;cp<240;cp++){const h=e.__font_glyph(font,cp);assert(h>0);assert.equal(e.__font_result_release(h),0);}
assert(e.__font_metric(font,4)<=512*1024);memory.grow(1);
assert.equal(e.__font_result_copy(a,65536,n,0xffffffff),n);assert.deepEqual(new Uint8Array(memory.buffer,65536,n),expected);
const len=stage('Hello Ω');const run=e.__font_codepoint_run(font,128,len);assert(run>0);assert(e.__font_result_field(run,4)>e.__font_result_field(a,4));
// Independent composition of glyph results must equal the codepoint run.
const rw=e.__font_result_field(run,0),rh=e.__font_result_field(run,1),rl=e.__font_result_field(run,2),rt=e.__font_result_field(run,3);
const reference=new Uint8Array(rw*rh);let pen=-rl;
for(const ch of 'Hello Ω'){
 const g=e.__font_glyph(font,ch.codePointAt(0));assert(g>0);
 const gw=e.__font_result_field(g,0),gh=e.__font_result_field(g,1),gl=e.__font_result_field(g,2),gt=e.__font_result_field(g,3),ga=e.__font_result_field(g,4);
 const gn=e.__font_result_field(g,5);assert.equal(e.__font_result_copy(g,131072,gn,0xffffffff),gn);
 const pixels=new Uint8Array(memory.buffer,131072,gn);
 for(let y=0;y<gh;y++)for(let x=0;x<gw;x++){
  const o=(rt-gt+y)*rw+pen+gl+x,a=pixels[(y*gw+x)*4+3];reference[o]=a+Math.floor((reference[o]*(255-a)+127)/255);
 }
 pen+=ga;e.__font_result_release(g);
}
const rn=e.__font_result_field(run,5);e.__font_result_copy(run,131072,rn,0xffffffff);
const runPixels=new Uint8Array(memory.buffer,131072,rn);
for(let i=0;i<reference.length;i++)assert.equal(runPixels[i*4+3],reference[i],`run coverage ${i}`);
// A leading U+FEFF is a codepoint, not a stream signature to discard.
for (const prefix of ['', '\uFEFF']) {
 const atLimit=prefix+'A'.repeat(4096-prefix.length);
 const h=e.__font_codepoint_run(font,128,stage(atLimit));assert(h>0,'4096 scalars accepted');
 e.__font_result_release(h);
 assert.equal(e.__font_codepoint_run(font,128,stage(atLimit+'A')),-2,'4097 scalars rejected, including leading U+FEFF');
}
const bomGlyph=e.__font_glyph(font,0xfeff);assert(bomGlyph>0);
const bomRun=e.__font_codepoint_run(font,128,stage('\uFEFF'));assert(bomRun>0);
assert.equal(e.__font_result_field(bomRun,4),e.__font_result_field(bomGlyph,4),'leading codepoint retains its advance');
e.__font_result_release(bomGlyph);e.__font_result_release(bomRun);
new Uint8Array(memory.buffer).set([0xc0,0x80],128);assert.equal(e.__font_codepoint_run(font,128,2),-5);
assert(e.__font_glyph(font,0xd800)<0);
stage('/usr/share/fonts/sans.ttf');assert.equal(e.__font_add_fallback(font,128),0);assert.equal(e.__font_metric(font,5),2);
stage('/bad.ttf');assert.equal(e.__font_open(128,20,0),-3);
assert.equal(e.__font_close(font),0);assert.equal(e.__font_close(font),-1);
assert.equal(e.__font_result_copy(a,65536,n,0xffffffff),n);
assert.equal(e.__font_result_release(a),0);assert.equal(e.__font_result_release(a),-1);e.__font_result_release(run);
const f=e.__font_open(0,12,3);assert(f>font);
const handles=[];for(let i=0;i<32;i++){const h=e.__font_glyph(f,65);assert(h>0);handles.push(h);}assert.equal(e.__font_glyph(f,65),-2);
e.__font_result_release(handles.pop());assert(e.__font_glyph(f,66)>0);
e.__font_dispose();assert.equal(e.__font_metric(f,0),-1);assert.equal(e.__font_result_field(handles[0],0),-1);
const fresh=e.__font_open(0,20,0);assert(fresh>f);
const allFonts=[fresh];for(let i=1;i<16;i++){const h=e.__font_open(0,12,0);assert(h>0);allFonts.push(h);}assert.equal(e.__font_open(0,12,0),-2);
for(const h of allFonts)assert.equal(e.__font_close(h),0);
e.__font_dispose();
console.log('fontbridge: PASS (real FreeType ink, metrics, runs, cache/result bounds, UTF-8, stale handles, memory growth, teardown)');
// Compile Small through the installed-snapshot cc driver, then execute through
// the actual runModule import wiring. Optional sibling follows test_small.js.
(async()=>{
 // Compile the bounded allocator fixture against the same shared fontcore and
 // FreeType dependency graph; no production test exports or altered module.
 const bounded=COMMON.buildProject(C,'os/fontbridge/bin.json',p=>fs.readFileSync(path.join(ROOT,
  p==='os/fontbridge/fontbridge.c'?'tests/host/fontcore_tofu_bounds.c':p),'utf8'),{debug:true});
 const boundedModule=new WebAssembly.Module(bounded),boundedImports={};
 for(const im of WebAssembly.Module.imports(boundedModule)) {
  assert.equal(im.module,'c');assert.equal(im.kind,'function');
  boundedImports[im.name]=()=>{throw new Error('tofu fixture unexpected import '+im.name);};
 }
 assert.equal(new WebAssembly.Instance(boundedModule,{c:boundedImports}).exports.main(),0,'tofu pre-allocation bounds');
 console.log('fontcore tofu: PASS (dimension/product/overflow rejection before allocation, exact-bound pixels)');
 const sibling=require('../../tools/small-sibling.js'),snap=sibling.snapshot(ROOT);
 if(!snap){console.log('Small font ABI: NOT RUN (optional sibling absent)');return;}
 const folded=sibling.fold(ROOT,{system:{dirs:[],files:{}}});
 for(const dir of folded.system.dirs)kfs.mkdir(dir,0o755);
 for(const [p,v] of Object.entries(folded.system.files))if(v.content!==undefined)COMMON.writeFile(kfs,p,v.content);
 kfs.mkdir('/work',0o755);
 COMMON.writeFile(kfs,'/work/font.wc',`import std.Memory;
 @import("c","__font_open") int openFont(int path,int px,int flags);
 @import("c","__font_glyph") int glyph(int font,int cp);
 @import("c","__font_result_field") int field(int result,int index);
 @import("c","__font_result_copy") int copy(int result,int ptr,int cap,int rgba);
 @import("c","__font_result_release") int release(int result);
 @import("c","__font_close") int closeFont(int font);
 int main(){
  int f=openFont(0,20,0);if(f<=0)return 1;
  int g=glyph(f,65);if(g<=0)return 2;
  int n=field(g,5);if(n<=0)return 3;
  int p=Memory.malloc(n);if(copy(g,p,n,-1)!=n)return 4;
  int ink=0;for(int i=3;i<n;i+=4){if(Memory.loadByte(p+i)!=0)ink++;}
  Memory.free(p);if(release(g)!=0||closeFont(f)!=0)return 5;
  return ink>0?0:6;
 }`);
 const compiled=await COMMON.createCcDriver(null,kfs)(['/usr/bin/small','font.wc','-o','font'],'/work');
 assert.equal(compiled.exitCode,0,compiled.stderr);
 const rc=await HOST({bytes:COMMON.readFileBytes(kfs,'/work/font'),args:['/work/font'],env:{},blockFsFactory:async ctx=>({c:kfs.toWasmEnv(ctx)})});
 assert.equal(rc,0);
 console.log('Small font ABI: PASS (installed snapshot '+snap.sha256+', actual host imports, real FreeType pixels)');
})().catch(e=>{console.error(e);process.exitCode=1;});
