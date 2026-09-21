'use strict';
// Real GPU compute and offscreen render/readback; --window also tests SDL presentation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');
const C = require('../../compiler.js');
C.Runtime = require('../../host.js');
C.runModule = C.Runtime;
const root = path.resolve(__dirname, '../..');
const native = C.Runtime.loadNativeSDL(true);
assert.equal(typeof native.WGPU_CreateInstance, 'function', 'Build with node native/build.js');
const memory = new WebAssembly.Memory({initial: 4});
const events = [];
const gpu = C.Runtime.createNativeWebGPU({
  getMemory: () => memory,
  getExports: () => new Proxy({}, {get: (_, name) => (...args) => events.push({name, args})}),
  readString: p => {
    const bytes = new Uint8Array(memory.buffer); let end = p;
    while (bytes[end]) end++;
    return new TextDecoder().decode(bytes.subarray(p, end));
  }
}, native);
const e = gpu.c;
let cursor = 1024;
function data(values, Type = Int32Array) {
  const p = cursor; cursor += Math.ceil(values.length * Type.BYTES_PER_ELEMENT / 8) * 8;
  new Type(memory.buffer, p, values.length).set(values); return p;
}
function string(s) {return data(Buffer.from(s + '\0'), Uint8Array);}
const headers = Object.values(C.getStdlibHeaders()).join('\n');
function val(name) {
  const m = headers.match(new RegExp('\\b' + name + '\\s*=\\s*(0x[0-9a-f]+|[0-9]+)', 'i'));
  assert.ok(m, name); return Number(m[1]);
}
async function completion(name) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    gpu.pump();
    const i = events.findIndex(e => e.name === name);
    if (i >= 0) return events.splice(i, 1)[0].args;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw Error('Timed out waiting for ' + name);
}
async function map(buffer, offset, size, mode = 1) {
  e.__wgpu_buffer_map_async(buffer, mode, offset, size, 13, 14, 15);
  assert.deepEqual(await completion('__wgpu_call_buffer_map_cb'), [13, 1, 14, 15]);
}
async function main() {
  const inventory = new Set();
  for (const source of Object.values(C.getStdlibSources()))
    for (const m of source.matchAll(/__import\s+[^;]*?\b(__wgpu_\w+)\s*\(/g)) inventory.add(m[1]);
  for (const name of inventory) assert.equal(typeof e[name], 'function', name);
  // Compare by enum NAME: the veneer and native header use different numbers.
  const nativeHeader = fs.readFileSync(path.join(root, 'build/native/wgpu/include/webgpu/webgpu.h'), 'utf8');
  const bridge = fs.readFileSync(path.join(root, 'native/webgpu.c'), 'utf8');
  let enums = 0;
  for (const [, type] of bridge.matchAll(/\{"(WGPU\w+)", probe_/g)) {
    const body = headers.match(new RegExp('typedef enum ' + type + ' \\{([\\s\\S]*?)\\}'))[1];
    for (const [, name, value] of body.matchAll(/(WGPU\w+)\s*=\s*(0x[0-9a-f]+|\d+)/gi)) {
      if (name.endsWith('_Undefined')) continue;
      const match = nativeHeader.match(new RegExp('\\b' + name + '\\s*=\\s*(0x[0-9a-f]+|\\d+)', 'i'));
      assert.ok(match, name);
      assert.equal(native.WGPU_MapEnum(type, Number(value)), Number(match[1]), name);
      enums++;
    }
  }
  console.log(`${inventory.size} WebGPU imports and ${enums} enum translations verified`);
  const instance = e.__wgpu_create_instance();
  e.__wgpu_instance_request_adapter(instance, 7, 8, 9);
  const a = await completion('__wgpu_call_adapter_cb');
  assert.equal(a[1], 1, 'A native GPU adapter is required');
  assert.deepEqual([a[0], a[5], a[6]], [7, 8, 9]);
  e.__wgpu_adapter_request_device(a[2], 10, 11, 12);
  const d = await completion('__wgpu_call_device_cb'); assert.equal(d[1], 1);
  const device = d[2], queue = e.__wgpu_device_get_queue(device);
  assert.throws(() => native.WGPU_DeviceCreateBuffer(device, Infinity, 1, 0), /range/);
  assert.throws(() => e.__wgpu_queue_write_buffer(queue, 0, 0, memory.buffer.byteLength - 1, 8), /outside/);

  // mappedAtCreation staging must survive memory.grow and flush on unmap.
  const upload = e.__wgpu_device_create_buffer(device, 32, 4, 1);
  e.__wgpu_buffer_get_mapped_range(upload, 8, 16, 64);
  memory.grow(1);
  new Uint32Array(memory.buffer, 64, 4).set([11, 22, 33, 44]);
  assert.throws(() => native.WGPU_BufferReadMappedRange(upload, 28, Buffer.alloc(8)), /range/);
  e.__wgpu_buffer_unmap(upload);
  const readback = e.__wgpu_device_create_buffer(device, 32, 9, 0);
  let encoder = e.__wgpu_device_create_command_encoder(device);
  e.__wgpu_cmd_copy_buffer_to_buffer(encoder, upload, 0, readback, 0, 32);
  e.__wgpu_queue_submit_one(queue, e.__wgpu_command_encoder_finish(encoder));
  await map(readback, 8, 16);
  e.__wgpu_buffer_get_mapped_range(readback, 8, 16, 128);
  assert.deepEqual([...new Uint32Array(memory.buffer, 128, 4)], [11,22,33,44]);
  assert.throws(() => native.WGPU_BufferReadMappedRange(readback, 0, Buffer.alloc(8)), /range/);
  assert.throws(() => native.WGPU_BufferWriteMappedRange(readback, 8, Buffer.alloc(8)), /reading/);
  e.__wgpu_buffer_unmap(readback);
  assert.throws(() => native.WGPU_BufferReadMappedRange(readback, 0, Buffer.alloc(4)), /not mapped/);

  // Render an actual triangle, copy texture to a buffer, assert foreground/background pixels.
  const shader = string(`@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
    var p=array<vec2f,3>(vec2f(-1,-1),vec2f(1,-1),vec2f(0,1)); return vec4f(p[i],0,1);
  } @fragment fn fs()->@location(0) vec4f {return vec4f(0,1,0,1);}`);
  const module = e.__wgpu_device_create_shader_module_wgsl(device, shader, -1);
  const vs = string('vs'), frag = string('fs');
  const targets = data([1, val('WGPUTextureFormat_RGBA8Unorm'), 15, 0, 0,0,0,0,0,0]);
  const pipeline = e.__wgpu_device_create_render_pipeline(device, module, vs, -1, module, frag, -1,
    targets, 10, val('WGPUPrimitiveTopology_TriangleList'), 0, val('WGPUCullMode_None'), val('WGPUFrontFace_CCW'),
    data([0]), 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0xffffffff, 0, 0,0,0,0,0,0);
  assert.ok(pipeline);
  const texture = e.__wgpu_device_create_texture(device, 8, 8, 1, val('WGPUTextureFormat_RGBA8Unorm'), 17, val('WGPUTextureDimension_2D'), 1, 1);
  const view = e.__wgpu_texture_create_view(texture, 0,0,0,0,0,0,0);
  encoder = e.__wgpu_device_create_command_encoder(device);
  const pass = e.__wgpu_command_encoder_begin_render_pass(encoder, data([1,view,0,1,1,-1]), 6,
    data([1,0,0,1], Float64Array), 0,0,0,0,0,0,0,0,0);
  e.__wgpu_render_pass_set_pipeline(pass, pipeline);
  e.__wgpu_render_pass_draw(pass, 3, 1, 0, 0);
  e.__wgpu_render_pass_end(pass);
  const pixels = e.__wgpu_device_create_buffer(device, 8*256, 9, 0);
  e.__wgpu_cmd_copy_texture_to_buffer(encoder, texture, 0,0,0,0,pixels,0,256,8,8,8,1);
  e.__wgpu_queue_submit_one(queue, e.__wgpu_command_encoder_finish(encoder));
  await map(pixels, 0, 8*256);
  e.__wgpu_buffer_get_mapped_range(pixels, 0, 8*256, 65536);
  const image = new Uint8Array(memory.buffer, 65536, 8*256);
  assert.deepEqual([...image.subarray(4*256+4*4,4*256+4*4+4)], [0,255,0,255]);
  assert.deepEqual([...image.subarray(0,4)], [255,0,0,255]);
  e.__wgpu_buffer_unmap(pixels);

  e.__wgpu_device_push_error_scope(device, val('WGPUErrorFilter_Validation'));
  e.__wgpu_device_create_buffer(device, 4, 0, 0); // invalid usage, captured rather than process abort
  e.__wgpu_device_pop_error_scope(device, 17,18,19);
  assert.deepEqual(await completion('__wgpu_call_pop_error_cb'), [17,1,val('WGPUErrorType_Validation'),18,19]);
  e.__wgpu_device_push_error_scope(device, val('WGPUErrorFilter_Validation'));
  e.__wgpu_device_pop_error_scope(device, 17,18,19);
  assert.deepEqual(await completion('__wgpu_call_pop_error_cb'), [17,1,val('WGPUErrorType_NoError'),18,19]);
  assert.throws(() => native.WGPU_DeviceCreatePipelineLayout(device, Buffer.alloc(5).subarray(1)), /alignment/);
  console.log('GPU mapped writes/readback, memory growth, rendering pixels, and error scopes passed');
  if (process.argv.includes('--surfaces')) {
    assert.ok(native.SDL_Init(0x20));
    const win = native.SDL_CreateWindow('WebGPU surface lifecycle',64,64,0x20);
    const sf = e.__wgpu_instance_create_surface_for_window(instance,win);
    assert.ok(sf);
    assert.throws(()=>native.SDL_CreateRenderer(win,1),/WebGPU surface/);
    assert.throws(()=>native.SDL_UpdateWindowPixels(win,Buffer.alloc(64*64*4),64,64,64*4),/WebGPU surface/);
    assert.throws(()=>e.__wgpu_instance_create_surface_for_window(instance,win),/already has/);
    const fmt=e.__wgpu_surface_get_preferred_format(sf);
    const configure=(width,height)=>e.__wgpu_surface_configure(sf,device,fmt,16,width,height,0,1,data([0]),1);
    configure(64,64);
    native.SDL_SetWindowSize(win,96,80); native.SDL_PollEvents(0);
    configure(96,80);
    native.SDL_DestroyWindow(win);
    assert.throws(()=>e.__wgpu_surface_get_preferred_format(sf),/destroyed/);
    const sw=native.SDL_CreateWindow('SDL renderer ownership',16,16,8);
    native.SDL_CreateRenderer(sw,1);
    assert.throws(()=>e.__wgpu_instance_create_surface_for_window(instance,sw),/SDL_Renderer/);
    native.SDL_DestroyWindow(sw);
    console.log('SDL/WebGPU surface creation, resizing, exclusive presentation and window-owned cleanup passed');
  }
  // Releasing public handles before pending completion must not free callback userdata.
  e.__wgpu_buffer_map_async(readback, 1, 0, 32, 20,21,22);
  e.__wgpu_release(readback);
  e.__wgpu_release(device);
  gpu.close(); gpu.close();
  assert.throws(() => native.WGPU_DeviceGetQueue(device), /destroyed/);

  const run = args => execFileSync(process.execPath, [path.join(root,'compiler.js'), ...args], {cwd:root, encoding:'utf8', timeout:30000});
  const compute = path.join(__dirname, 'fixtures/gpu-compute.c');
  const computeWasm = path.join(root, 'build/native/compute-test.wasm');
  run([compute, '-o', computeWasm]);
  const runWasm = (wasm, flags = []) => execFileSync(process.execPath, [path.join(root,'host.js'), wasm, ...flags], {cwd:root,encoding:'utf8',timeout:30000});
  assert.match(runWasm(computeWasm), /1024 values.*all verified/);
  const noGpu = spawnSync(process.execPath, ['host.js',computeWasm,'--sdl=null'], {cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(noGpu.status,1); assert.match(noGpu.stderr,/no WebGPU adapter/);
  // Generated JS also embeds the native bridge and discovers the addon.
  const dir = fs.mkdtempSync(path.join(root,'build/native/gpu-test-'));
  try {
    const pure = path.join(dir,'instance.c');
    fs.writeFileSync(pure,'#include <webgpu.h>\nint main(void) { WGPUInstance i=wgpuCreateInstance(0); if (!i) return 1; wgpuInstanceRelease(i); return 0; }\n');
    run([pure,'-o',path.join(dir,'pure.wasm')]); runWasm(path.join(dir,'pure.wasm')); // No SDL imports: native GPU selection must still work.
    const wasm = path.join(dir,'compute.wasm');
    run([compute,'-o',wasm]);
    const bytes=fs.readFileSync(wasm);
    for (let i=0;i<2;i++) {
      let out='';
      assert.equal(await C.runModule({bytes,args:['compute'],fs,writeOut:x=>{out+=typeof x==='string'?x:Buffer.from(x).toString();}}),0);
      assert.match(out,/all verified/);
    }
    let failedDevice;
    const failing=Object.fromEntries(Object.getOwnPropertyNames(native).map(k=>[k,native[k]]));
    failing.WGPU_DeviceCreateBuffer=(device)=>{failedDevice=device;throw Error('injected GPU failure');};
    await assert.rejects(C.runModule({bytes,args:['compute'],fs,nativeSDL:failing,writeErr:()=>{}}),/injected GPU failure/);
    assert.throws(()=>native.WGPU_DeviceGetQueue(failedDevice),/destroyed/);
    const output = path.join(dir,'compute.js');
    run([compute,'-o',output]);
    assert.match(execFileSync(process.execPath,[output],{encoding:'utf8',timeout:30000}),/all verified/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}

  console.log('Native compute C/CLI/generated JS, null backend, and pending-callback cleanup passed');
}
main().catch(err => {console.error(err); process.exitCode=1;}).finally(() => {gpu.close(); native.SDL_Quit();});
