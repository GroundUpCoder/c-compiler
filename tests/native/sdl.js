'use strict';
// Uses real SDL's dummy video/audio drivers: no desktop/clipboard changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const C = require('../../compiler.js');
C.Runtime = require('../../host.js');
C.runModule = C.Runtime;
const s = C.Runtime.loadNativeSDL(true);
assert.ok(s.SDL_SetHint('SDL_VIDEO_DRIVER', 'dummy'));
assert.ok(s.SDL_SetHint('SDL_AUDIO_DRIVER', 'dummy'));
const memory = new WebAssembly.Memory({initial : 2});
const events = [];
const adapter = C.Runtime.createNativeSDL({
  getMemory : () => memory,
  getExports : () => new Proxy(
      {}, {get : (_, name) => (...args) => events.push([ name, ...args ])}),
  readString : () => 'test'
},
                                          s);
const inventory = new Set();
for (const source of Object.values(C.getStdlibSources()))
  for (const m of source.matchAll(
           /__import\s+[^;]*?\b(__sdl_\w+|__clip_\w+)\s*\(/g))
    inventory.add(m[1]);
for (const name of inventory)
  assert.equal(typeof (adapter.c[name] || adapter.clipboard[name]), 'function',
               'Missing native import ' + name);
console.log(inventory.size + ' SDL/clipboard host imports covered');
adapter.close();
assert.throws(() => s.SDL_Init(-1), /range/);
assert.ok(s.SDL_Init(0x20 | 0x10 | 0x2000));
const w = s.SDL_CreateWindow('SDL native test', 16, 16, 8);
assert.ok(w, s.SDL_GetError());
assert.deepEqual(s.SDL_GetWindowSize(w), [ 16, 16 ]);
const r = s.SDL_CreateRenderer(w, 1);
assert.ok(r, s.SDL_GetError());
assert.throws(() => s.SDL_DestroyTexture(w), /wrong-type/);
assert.ok(s.SDL_SetRenderDrawColorFloat(r, 1, 0, 0, 1));
assert.ok(s.SDL_RenderClear(r));
let frame = s.SDL_RenderReadPixels(r);
assert.deepEqual([...frame.pixels.subarray(0, 4) ], [ 255, 0, 0, 255 ]);
const t = s.SDL_CreateTexture(r, 0, 2, 2);
assert.ok(t);
assert.throws(() => s.SDL_UpdateTexture(t, Buffer.alloc(1), 8, 0, 0, 2, 2),
              /short/);
assert.throws(() => s.SDL_UpdateTexture(t, Buffer.alloc(16), 8, 2, 0, 2, 2),
              /outside/);
assert.ok(s.SDL_UpdateTexture(t, Buffer.from([
  0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255
]),
                              8, 0, 0, 2, 2));
assert.ok(s.SDL_SetTextureBlendMode(t, 0));
assert.equal(s.SDL_GetTextureBlendMode(t), 0);
assert.ok(s.SDL_SetTextureScaleMode(t, 0));
assert.equal(s.SDL_GetTextureScaleMode(t), 0);
const verts = new Float32Array([
  0, 0, 0, 0, 1, 1, 1, 1, 16, 0,  1, 0, 1, 1, 1, 1, 16, 16, 1, 1, 1, 1, 1, 1,
  0, 0, 0, 0, 1, 1, 1, 1, 16, 16, 1, 1, 1, 1, 1, 1, 0,  16, 0, 1, 1, 1, 1, 1
]);
assert.ok(s.SDL_SetRenderClipRect(r, 1, 4, 4, 4, 4));
assert.deepEqual(s.SDL_GetRenderClipRect(r), [ 1, 4, 4, 4, 4 ]);
assert.ok(s.SDL_RenderGeometry(r, t, Buffer.from(verts.buffer), 6));
frame = s.SDL_RenderReadPixels(r);
assert.deepEqual([...frame.pixels.subarray(5 * frame.pitch + 5 * 4,
                                           5 * frame.pitch + 5 * 4 + 4) ],
                 [ 0, 255, 0, 255 ]);
assert.deepEqual([...frame.pixels.subarray(0, 4) ], [ 255, 0, 0, 255 ]);
assert.ok(s.SDL_SetRenderClipRect(r, 0, 0, 0, 0, 0));
// Both the small stack buffer and heap fallback accept unaligned input.
for (const count of [96, 102]) {
  const unaligned = Buffer.alloc(1 + count * 32).subarray(1);
  for (let off=0; off<unaligned.length; off+=verts.byteLength)
    Buffer.from(verts.buffer).copy(unaligned,off);
  assert.ok(s.SDL_RenderGeometry(r,t,unaligned,count));
}
assert.throws(() => s.SDL_RenderGeometry(r,t,Buffer.alloc(1),3), /Invalid geometry/);
const target = s.SDL_CreateTexture(r, 2, 4, 4);
assert.ok(target);
assert.ok(s.SDL_SetRenderTarget(r, target));
assert.ok(s.SDL_SetRenderDrawColorFloat(r, 0, 0, 1, 1));
assert.ok(s.SDL_RenderClear(r));
assert.deepEqual([...s.SDL_RenderReadPixels(r).pixels.subarray(0, 4) ],
                 [ 0, 0, 255, 255 ]);
assert.ok(s.SDL_SetRenderTarget(r, 0));
assert.ok(s.SDL_RenderPresent(r));
const audio = s.SDL_OpenAudioDeviceStream(22050, 0x8010, 2);
assert.ok(audio, s.SDL_GetError());
assert.ok(s.SDL_PutAudioStreamData(audio, Buffer.alloc(22050 * 4)));
assert.equal(s.SDL_GetAudioStreamQueued(audio), 22050 * 4);
assert.ok(s.SDL_PauseAudioStreamDevice(audio, 0));
s.SDL_Delay(100);
assert.ok(s.SDL_GetAudioStreamQueued(audio) < 22050 * 4,
          'dummy playback must consume queued PCM');
assert.ok(s.SDL_PauseAudioStreamDevice(audio, 1));
assert.ok(s.SDL_ClearAudioStream(audio));
assert.equal(s.SDL_GetAudioStreamQueued(audio), 0);
s.SDL_DestroyAudioStream(audio);
assert.throws(() => s.SDL_GetAudioStreamQueued(audio), /destroyed/);
assert.deepEqual(s.SDL_GetGamepads(), []);
assert.ok(s.SDL_SetClipboardText('native ✓'));
assert.equal(s.SDL_GetClipboardText(), 'native ✓');
assert.ok(s.SDL_HasClipboardText());
assert.ok(s.SDL_ClearClipboardData());
s.SDL_PollEvents(0);
const event = Buffer.alloc(s.eventSize);
event.writeUInt32LE(0x300);
event.writeInt32LE(4, 24);
event.writeUInt32LE(97, 28);
event[36] = 1;
assert.ok(s.SDL_PushEvent(event));
assert.ok(s.SDL_PollEvents(100).some(e => e.type === 0x300 && e.key === 97 &&
                                          e.scancode === 4));
s.SDL_DestroyWindow(w);
assert.throws(() => s.SDL_RenderPresent(r), /destroyed/);
assert.throws(() => s.SDL_GetTextureScaleMode(t), /destroyed/);
s.SDL_Quit();
console.log(
    'Native handles, framebuffer pixels, clipping, textures, targets, audio playback, events, clipboard passed');
// Exercise Wasm-memory decoding and quad lowering through the JS adapter.
const a = C.Runtime.createNativeSDL({getMemory:()=>memory,getExports:()=>({}),readString:()=> 'adapter'},s);
const e=a.c;
e.__sdl_init(0x20|0x10);
const aw=e.__sdl_create_window(0,0,0,8,8,8);
const ar=e.__sdl_create_renderer(aw,1);
const at=e.__sdl_create_texture(ar,0,1,1);
new Uint8Array(memory.buffer,16,4).set([255,255,255,255]);
e.__sdl_update_texture(at,16,4,0,0,1,1);
e.__sdl_set_texture_color_mod(at,0,1,0);
e.__sdl_set_draw_color(ar,1,0,0,1);
e.__sdl_render_clear(ar);
e.__sdl_render_quad(ar,at,0,0,8,0,8,8,0,8,0,0,1,1);
a.getLastFrame();
e.__sdl_render_present(ar);
assert.deepEqual([...a.getLastFrame().pixels.subarray(0,4)],[0,255,0,255]);
assert.throws(()=>e.__sdl_update_texture(at,memory.buffer.byteLength-1,4,0,0,1,1),/outside/);
assert.ok(e.__sdl_native_path(0,0,0,0,0)>0);
const ad=e.__sdl_open_audio_device(22050,0x8010,1);
assert.ok(ad);
const inputSpec=s.SDL_GetAudioStreamFormat(ad).slice(0,3);
assert.deepEqual(inputSpec,[0,1,2].map(i=>e.__sdl_audio_dst_query(ad,i)), 'C PCM sink format must equal the native stream input format');
assert.deepEqual(inputSpec,s.SDL_GetAudioDeviceFormat(ad));
e.__sdl_close_audio_device(ad);
a.close();
console.log('Adapter memory bounds, texture modulation, quad rendering and capture passed');
// SDL_CreateWindow initializes video implicitly in SDL3. Such callers must
// still pump real events and release the native subsystem on completion.
const implicitEvents=[];
const implicit=C.Runtime.createNativeSDL({getMemory:()=>memory,readString:()=> 'implicit',getExports:()=>({__sdl_push_key_event:(...args)=>implicitEvents.push(args)})},s);
const iw=implicit.c.__sdl_create_window(0,0,0,8,8,8);
assert.ok(iw);
assert.ok(s.SDL_PushEvent(event));
implicit.drainInput();
assert.ok(implicitEvents.some(args=>args[1]===0x300 && args[3]===97), 'implicit video initialization must enable the event pump');
implicit.close();
assert.throws(()=>s.SDL_GetWindowSize(iw),/destroyed/);
console.log('Implicit video initialization, event pumping and cleanup passed');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-sdl-test-'));
(async () => {
  try {
    const src = path.join(dir, 'test.c'), wasm = path.join(dir, 'test.wasm');
    fs.writeFileSync(
        src,
        `#include <SDL.h>\n#include <assert.h>\nint main(void) {\nassert(SDL_Init(0));\nassert(SDL_InitSubSystem(SDL_INIT_VIDEO));\nassert(SDL_WasInit(SDL_INIT_VIDEO));\nSDL_Window *w=SDL_CreateWindow("test",8,8,SDL_WINDOW_HIDDEN);assert(w);\nassert(SDL_UpdateWindowSurface(w));\nSDL_DestroyWindow(w);\nSDL_QuitSubSystem(SDL_INIT_VIDEO);assert(!SDL_WasInit(SDL_INIT_VIDEO));\nassert(SDL_InitSubSystem(SDL_INIT_AUDIO));\nreturn 0;\n}`);
    execFileSync(process.execPath,
                 [ path.join(__dirname, '../../compiler.js'), src, '-o', wasm ],
                 {stdio : 'pipe'});
    const cli=path.join(__dirname,'../../compiler.js');
    const childEnv={...process.env,SDL_VIDEO_DRIVER:'dummy',SDL_AUDIO_DRIVER:'dummy'};
    const generated=path.join(dir,'app.js');
    execFileSync(process.execPath,[cli,src,'-o',generated],{stdio:'pipe'});
    assert.throws(()=>execFileSync(process.execPath,[generated],{env:childEnv,stdio:'pipe'}), e=>e.stderr.toString().includes('Assertion failed'));
    // Copy the complete runtime layout OUTSIDE both repositories. Relative
    // dynamic-library paths must suffice; never rely on the build prefix.
    const portable = path.join(dir, 'native');
    fs.mkdirSync(portable);
    const built = path.resolve(__dirname, '../../build/native');
    fs.copyFileSync(path.join(built, 'sdl3.node'), path.join(portable, 'sdl3.node'));
    fs.cpSync(path.join(built, 'sdl/lib'), path.join(portable, 'sdl/lib'), {recursive:true, dereference:true});
    if (fs.existsSync(path.join(built, 'wgpu/lib')))
      fs.cpSync(path.join(built, 'wgpu/lib'), path.join(portable, 'wgpu/lib'), {recursive:true, dereference:true});
    execFileSync(process.execPath,[generated],{env:childEnv,stdio:'pipe'});
    fs.rmSync(portable,{recursive:true,force:true});
    const nested=fs.mkdtempSync(path.join(__dirname,'../../build/native/loader-test-'));
    try {
      const relocated=path.join(nested,'app.js');
      fs.copyFileSync(generated,relocated);
      execFileSync(process.execPath,[relocated],{env:childEnv,stdio:'pipe'});
      execFileSync(process.execPath,[path.join(__dirname,'../../host.js'),wasm,'--sdl=native'],{env:childEnv,stdio:'pipe'});
    } finally {fs.rmSync(nested,{recursive:true,force:true});}
    const minimal=path.join(dir,'minimal.c');
    fs.writeFileSync(minimal,'#include <SDL.h>\nint main(void) { return SDL_Init(SDL_INIT_VIDEO) ? 0 : 1; }\n');
    execFileSync(process.execPath,[cli,minimal,'--sdl=null','-o',generated],{stdio:'pipe'});
    execFileSync(process.execPath,[generated],{stdio:'pipe'});
    console.log('Wasm CLI, generated JS, relocated native libraries, addon discovery, missing addon, explicit null backend passed');
    for (let i = 0; i < 2; i++)
      assert.equal(await C.runModule(
                       {bytes : fs.readFileSync(wasm), args : [ 'test' ], fs}),
                   0);
    assert.equal(s.SDL_OpenAudioDeviceStream(22050, 0x8010, 2), 0,
                 'runModule must quit SDL on return');
    let leakedWindow;
    const faultyNative =
        Object.fromEntries(Object.getOwnPropertyNames(s).map(k => [k, s[k]]));
    faultyNative.SDL_CreateWindow = (...a) => {
      leakedWindow = s.SDL_CreateWindow(...a);
      return leakedWindow;
    };
    faultyNative.SDL_UpdateWindowPixels =
        () => { throw Error('injected backend failure'); };
    await assert.rejects(C.runModule({
      bytes : fs.readFileSync(wasm),
      args : [ 'test' ],
      fs,
      nativeSDL : faultyNative
    }),
                         /injected backend failure/);
    assert.throws(() => s.SDL_GetWindowSize(leakedWindow), /destroyed/);
    console.log(
        'Compiled C, subsystem transitions, automatic cleanup, repeated execution passed');
    execFileSync(process.execPath,[cli,path.join(__dirname,'fixtures/native-sdl-batch.c'),'-o',wasm],{stdio:'pipe'});
    const counts=[];
    const counted=Object.fromEntries(Object.getOwnPropertyNames(s).map(k=>[k,s[k]]));
    counted.SDL_RenderGeometry=(...args)=>{counts.push(args[3]);return s.SDL_RenderGeometry(...args);};
    let captured;
    assert.equal(await C.runModule({bytes:fs.readFileSync(wasm),args:['batch'],fs,nativeSDL:counted,
      onSdl:a=>{captured=a;a.getLastFrame();}}),0);
    const frame=captured.getLastFrame();
    const pixel=x=>[...frame.pixels.subarray(4*frame.pitch+x*4,4*frame.pitch+x*4+4)];
    for(const [x,color] of [[1,[255,0,0,255]],[5,[0,255,0,255]],[9,[0,0,255,255]],
      [13,[0,255,255,255]],[17,[255,255,255,255]],[19,[0,0,0,255]],
      [21,[255,0,0,255]],[25,[0,0,255,255]],[29,[255,255,0,255]]]) assert.deepEqual(pixel(x),color,'pixel '+x);
    assert.ok(counts.length >= 40, 'exercise the existing per-quad host boundary');
    console.log('Quad rendering, texture updates/modulation/destruction, clipping, targets and geometry ordering passed');
  } finally {
    s.SDL_Quit();
    fs.rmSync(dir, {recursive : true, force : true});
  }
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
