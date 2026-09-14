'use strict';
// #791: real software rasterization into the surface SAB, with a small kernel
// hook fixture. This is pixel evidence for the renderer, not an OS boot.
const assert = require('assert');
const HOST = require('../../host.js');
const { WM_SAB_LAYOUT: L } = require('../../kernel.js');
const memory = new WebAssembly.Memory({ initial: 2 });
let fb;
const s = HOST.createSurfaceSDL({ctx: {
 readString: () => 'clip', getMemory: () => memory, getExports: () => ({})
}, hooks: { wmSabLayout: L, surfaceCreate(w,h,title,sab) { fb=sab; return {sid:1}; }, surfaceDestroy() {} }});
const e=s.c;
const w=e.__sdl_create_window(0,0,0,32,32,0), r=e.__sdl_create_renderer(w,1);
function clip(x,y,w,h) { e.__sdl_set_render_clip_rect(r,1,x,y,w,h); }
function quad(t=0) { e.__sdl_render_quad(r,t,0,0,32,0,32,32,0,32,0,0,32,32); }
function pixels() { e.__sdl_render_present(r); const i=new Int32Array(fb); return new Uint8Array(fb, L.shHdrBytes + (i[L.shFlip]&1)*32*32*4,32*32*4); }
function checkMask(p, pred, inside) { for(let y=0;y<32;y++) for(let x=0;x<32;x++) {
 const o=(y*32+x)*4; assert.deepStrictEqual(Array.from(p.slice(o,o+3)),pred(x,y)?inside(x,y):[0,0,0],`pixel ${x},${y}`);
}}
e.__sdl_set_draw_color(r,0,0,0,1); clip(8,9,10,11); e.__sdl_render_clear(r);
e.__sdl_set_draw_color(r,1,0,0,1); quad();
checkMask(pixels(),(x,y)=>x>=8&&x<18&&y>=9&&y<20,()=>[255,0,0]);
// UV mapping must remain based on the full source/destination, not the clip.
const bytes=new Uint8Array(memory.buffer); for(let y=0;y<32;y++)for(let x=0;x<32;x++)bytes.set([x*8,y*8,64,255],4096+(y*32+x)*4);
const t=e.__sdl_create_texture(r,0,32,32); e.__sdl_update_texture(t,4096,128,0,0,32,32);
e.__sdl_set_texture_scale_mode(t,0); e.__sdl_set_draw_color(r,0,0,0,1);e.__sdl_render_clear(r);quad(t);
checkMask(pixels(),(x,y)=>x>=8&&x<18&&y>=9&&y<20,(x,y)=>[x*8,y*8,64]);
// Triangle geometry and rotated quads use the same scissor, without changing
// barycentrics. Compare to unscissored output inside an intersected child clip.
const v=new Float32Array(memory.buffer,8192,24);v.set([0,0,0,0,1,0,0,1,32,0,1,0,0,1,0,1,0,32,0,1,0,0,1,1]);
e.__sdl_set_render_clip_rect(r,0,0,0,0,0); e.__sdl_render_clear(r);e.__sdl_render_geometry(r,0,8192,3);const full=pixels().slice();
clip(8,9,10,11);e.__sdl_render_clear(r);e.__sdl_render_geometry(r,0,8192,3);const cut=pixels();
for(let y=0;y<32;y++)for(let x=0;x<32;x++){const o=(y*32+x)*4;assert.deepStrictEqual(Array.from(cut.slice(o,o+3)),x>=8&&x<18&&y>=9&&y<20?Array.from(full.slice(o,o+3)):[0,0,0]);}
for(const c of [[0,0,0,32],[0,0,32,0],[100,100,20,20],[-100,-100,5,5]]){clip(...c);e.__sdl_render_clear(r);quad();checkMask(pixels(),()=>false,()=>[]);}
clip(-2147483648,-2147483648,2147483647,2147483647);quad();checkMask(pixels(),()=>false,()=>[]);
console.log('software clipping: PASS (quad UVs, geometry, empty/offscreen/overflow)');
