'use strict';
// #797: compiler + host relocate independently of npm and native binaries.
// Every child rejects non-built-in JS packages, including ambient node_modules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-native-optional-'));
const host = path.join(dir, 'host.js'), compiler = path.join(dir, 'compiler.js');
function run(args, status = 0) {
  const r = spawnSync(process.execPath, ['--require', path.join(dir,'builtins-only.cjs'), ...args],
    {cwd:dir, encoding:'utf8', timeout:30000});
  assert.equal(r.error, undefined);
  assert.equal(r.status, status, r.stdout + r.stderr);
  return r;
}
function compile(name, source, flags = []) {
  const file = path.join(dir, name + '.c'), out = path.join(dir, name + '.wasm');
  fs.writeFileSync(file, source);
  run([compiler, file, '-o', out, ...flags]);
  run([compiler, file, '-o', path.join(dir,name+'.js'), ...flags]);
  return out;
}
try {
  fs.copyFileSync(path.join(root,'host.js'),host);
  fs.copyFileSync(path.join(root,'compiler.js'),compiler);
  fs.writeFileSync(path.join(dir,'builtins-only.cjs'), `
const Module = require('node:module');
const load = Module._load;
Module._load = function(id, ...args) {
  if (!Module.isBuiltin(id) && !require('node:path').isAbsolute(id) && !id.startsWith('.'))
    throw Error('External package attempted: ' + id);
  return load.call(this, id, ...args);
};
`);
  const consoleWasm = compile('console', '#include <stdio.h>\nint main(void) { puts("console works"); return 0; }\n');
  assert.equal(run([host,consoleWasm]).stdout,'console works\n');
  assert.equal(run([path.join(dir,'console.js')]).stdout,'console works\n');
  const argvWasm = compile('argv', `#include <string.h>
int main(int argc, char **argv) {
 return argc != 4 || strcmp(argv[1], "checkout") || strcmp(argv[2], "--") || strcmp(argv[3], "k.txt");
}
`);
  run([host,argvWasm,'--sdl=null','checkout','--','k.txt']);
  run([path.join(dir,'argv.js'),'checkout','--','k.txt']);
  const unavailable = compile('unavailable', `#include <SDL.h>
#include <assert.h>
#include <string.h>
int main(void) {
 assert(SDL_Init(0));
 SDL_Delay(20);
 assert(SDL_GetTicks() >= 20); /* first tick read still measures from init */
 assert(SDL_InitSubSystem(SDL_INIT_EVENTS));
 assert(!SDL_Init(SDL_INIT_VIDEO));
 assert(strstr(SDL_GetError(), "unavailable"));
 assert(!SDL_WasInit(SDL_INIT_VIDEO));
 assert(!SDL_InitSubSystem(SDL_INIT_AUDIO));
 assert(!SDL_Init(SDL_INIT_GAMEPAD));
 assert(!SDL_CreateWindow("missing",8,8,0));
 SDL_AudioSpec spec = { SDL_AUDIO_S16, 2, 22050 };
 assert(!SDL_OpenAudioDeviceStream(SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK,&spec,0,0));
 SDL_Quit();
 return 0;
}
`);
  run([host,unavailable]);
  run([path.join(dir,'unavailable.js')]);
  assert.match(run([host,unavailable,'--sdl=native'],1).stderr,/Native SDL3 addon missing/);
  const nullWasm=compile('null', '#include <SDL.h>\nint main(void) { return SDL_Init(SDL_INIT_VIDEO) ? 0 : 1; }\n',['--sdl=null']);
  run([host,nullWasm,'--sdl=null']);
  run([path.join(dir,'null.js')]);
  assert.match(run([host,consoleWasm,'--sdl=typo'],2).stderr,/--sdl must/);
  assert.match(run([compiler,path.join(dir,'console.c'),'--sdl=typo'],1).stderr,/--sdl must/);
  const gpuSource=fs.readFileSync(path.join(root,'tests/native/fixtures/gpu-compute.c'),'utf8');
  const gpu=compile('gpu',gpuSource);
  assert.match(run([host,gpu],1).stderr,/no WebGPU adapter/);
  assert.match(run([path.join(dir,'gpu.js')],1).stderr,/no WebGPU adapter/);
  fs.mkdirSync(path.join(dir,'native'));
  fs.writeFileSync(path.join(dir,'native/sdl3.node'),'intentionally invalid addon');
  // Lazy: even forced native selection does not load anything for console code.
  assert.equal(run([host,consoleWasm,'--sdl=native']).stderr,'');
  assert.equal(run([path.join(dir,'console.js')]).stderr,'');
  const broken=run([host,unavailable]);
  assert.match(broken.stderr,/Native SDL\/WebGPU unavailable:/);
  assert.match(broken.stderr,/sdl3.node/);
  assert.match(run([host,unavailable,'--sdl=native'],1).stderr,/sdl3.node/);
  run([host,nullWasm,'--sdl=null']);
  console.log('Optional native: relocated console, SDL/GPU absence, explicit null/native, and broken-addon degradation passed (npm imports forbidden)');
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
