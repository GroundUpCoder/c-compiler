'use strict';
// No npm dependencies or node-gyp. Build SDL3 and the plain C Node-API addon.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const build = path.join(root, 'build', 'native');
const version = '3.4.16';
const sha256 =
    '7322236cd12090c3eb40b9728be4d49c76f66ad17d04369584d4ecad5cf77c68';
const prefix = path.join(build, 'sdl');
// wgpu-native supplies WebGPU (webgpu.h C API on Metal/Vulkan/DX12). Prebuilt
// release archives are pinned per platform; --no-webgpu builds SDL only.
const wgpuVersion = 'v29.0.1.1';
const wgpuArchives = {
  'darwin-arm64': ['wgpu-macos-aarch64-release.zip', 'a5797a37b1adf720bcd5dcffb291edbbd5b7b14be0a3874c28e6393a655a7a3e'],
  'darwin-x64': ['wgpu-macos-x86_64-release.zip', '8e2f7378548ddd0e2cf21e7d864dda46e953f0af724855a33778b85ead206d41'],
  'linux-x64': ['wgpu-linux-x86_64-release.zip', '95a4d90c071005a98d03eab348beaa6b07e16eb00d1dcdb9f8348f75eb97ec5a'],
  'linux-arm64': ['wgpu-linux-aarch64-release.zip', '015fcdf1dbae82e614a783cc38017e5399ae0927a889fe9b69c9b664bc61b47a'],
};
const wgpuPrefix = path.join(build, 'wgpu');
const webgpu = !process.argv.includes('--no-webgpu');
const cmake = process.argv.find(x => x.startsWith('--cmake='))?.slice(8) ||
              path.join(os.homedir(), '.local', 'bin', 'cmake');
function run(cmd, args) { execFileSync(cmd, args, {stdio : 'inherit'}); }
async function download(url, destination, hash) {
  if (fs.existsSync(destination) &&
      crypto.createHash('sha256')
              .update(fs.readFileSync(destination))
              .digest('hex') === hash)
    return;
  console.log('Downloading ' + url);
  const r = await fetch(url);
  if (!r.ok)
    throw Error('Download failed: ' + r.status + ' ' + url);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash)
    throw Error('SHA-256 mismatch: ' + url);
  fs.writeFileSync(destination, bytes);
}
(async () => {
  if (!['darwin', 'linux'].includes(process.platform))
    throw Error('Native build currently supports macOS and Linux');
  fs.mkdirSync(build, {recursive : true});
  const source = path.join(build, 'SDL3-' + version);
  const library = path.join(prefix, 'lib', process.platform === 'darwin' ? 'libSDL3.dylib' : 'libSDL3.so');
  const installedVersion = path.join(prefix, 'version.txt');
  if (!fs.existsSync(library) || !fs.existsSync(installedVersion) || fs.readFileSync(installedVersion, 'utf8') !== version) {
    if (!fs.existsSync(cmake))
      throw Error(
          'CMake missing. Install with: uv tool install cmake (or pass --cmake=/path/to/cmake)');
    const archive = path.join(build, 'SDL-' + version + '.tar.gz');
    await download(
        `https://github.com/libsdl-org/SDL/releases/download/release-${
            version}/SDL3-${version}.tar.gz`,
        archive, sha256);
    if (!fs.existsSync(source))
      run('tar', [ '-xzf', archive, '-C', build ]);
    const obj = path.join(build, 'sdl-build');
    run(cmake, [
      '-S', source, '-B', obj, '-DCMAKE_BUILD_TYPE=Release', '-DSDL_SHARED=ON',
      '-DSDL_STATIC=OFF', '-DSDL_TESTS=OFF', '-DSDL_EXAMPLES=OFF',
      '-DCMAKE_INSTALL_PREFIX=' + prefix
    ]);
    run(cmake, [ '--build', obj, '--parallel', '4' ]);
    run(cmake, [ '--install', obj ]);
    fs.writeFileSync(installedVersion, version);
  }
  if (webgpu) {
    const archive = wgpuArchives[process.platform + '-' + process.arch];
    if (!archive)
      throw Error('No prebuilt wgpu-native for ' + process.platform + '-' + process.arch +
                  '. Pass --no-webgpu to build the SDL-only addon.');
    const wgpuLibrary = path.join(wgpuPrefix, 'lib', process.platform === 'darwin' ? 'libwgpu_native.dylib' : 'libwgpu_native.so');
    const wgpuInstalled = path.join(wgpuPrefix, 'version.txt');
    if (!fs.existsSync(wgpuLibrary) || !fs.existsSync(wgpuInstalled) || fs.readFileSync(wgpuInstalled, 'utf8') !== wgpuVersion) {
      const zip = path.join(build, archive[0]);
      await download(`https://github.com/gfx-rs/wgpu-native/releases/download/${wgpuVersion}/${archive[0]}`, zip, archive[1]);
      fs.rmSync(wgpuPrefix, {recursive : true, force : true});
      fs.mkdirSync(wgpuPrefix, {recursive : true});
      run('unzip', [ '-o', '-q', zip, '-d', wgpuPrefix ]);
      fs.writeFileSync(wgpuInstalled, wgpuVersion);
    }
  }
  if (process.argv.includes('--deps-only')) return;
  let nodeHeaders =
      path.join(os.homedir(),
                process.platform === 'darwin' ? 'Library/Caches/node-gyp'
                                              : '.cache/node-gyp',
                process.versions.node, 'include', 'node');
  const cachedHeaders = path.join(build, 'node-' + process.version, 'include', 'node');
  if (fs.existsSync(path.join(cachedHeaders, 'node_api.h'))) nodeHeaders = cachedHeaders;
  if (!fs.existsSync(path.join(nodeHeaders, 'node_api.h'))) {
    const base = `https://nodejs.org/dist/${process.version}/`;
    const response = await fetch(base + 'SHASUMS256.txt');
    if (!response.ok) throw Error('Node header checksums download failed: ' + response.status);
    const checks = await response.text();
    const name = `node-${process.version}-headers.tar.gz`;
    const hash =
        checks.split('\n').find(x => x.endsWith('  ' + name))?.split(' ')[0];
    if (!hash)
      throw Error('Node headers checksum not found');
    const archive = path.join(build, name);
    await download(base + name, archive, hash);
    run('tar', [ '-xzf', archive, '-C', build ]);
    nodeHeaders =
        path.join(build, 'node-' + process.version, 'include', 'node');
  }
  if (process.argv.includes('--deps-only'))
    return;
  const flags = [
    '-std=c11', '-O2', '-Wall', '-Wextra', '-DNAPI_VERSION=8',
    '-I' + nodeHeaders, '-I' + path.join(prefix, 'include'),
    path.join(__dirname, 'sdl3.c'), path.join(__dirname, 'webgpu.c'),
    '-L' + path.join(prefix, 'lib'), '-lSDL3'
  ];
  if (webgpu)
    flags.push('-I' + path.join(wgpuPrefix, 'include'), '-L' + path.join(wgpuPrefix, 'lib'), '-lwgpu_native');
  else
    flags.push('-DNO_WEBGPU');
  if (process.platform === 'darwin')
    flags.push('-bundle', '-undefined', 'dynamic_lookup',
               '-Wl,-rpath,@loader_path/sdl/lib', '-Wl,-rpath,@loader_path/wgpu/lib');
  else
    flags.push('-shared', '-fPIC', '-Wl,-rpath,$ORIGIN/sdl/lib', '-Wl,-rpath,$ORIGIN/wgpu/lib');
  flags.push('-o', path.join(build, 'sdl3.node'));
  run(process.platform === 'darwin' ? 'clang' : 'cc', flags);
  console.log('Built ' + path.join(build, 'sdl3.node'));
})().catch(e => {
  console.error(e.message);
  process.exitCode = 1;
});
