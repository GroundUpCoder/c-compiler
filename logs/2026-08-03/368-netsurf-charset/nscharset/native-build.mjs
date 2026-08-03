// Build nsmonkey NATIVELY on the Mac Mini with the system clang + the SDK's
// libcurl, from the SAME vendored NetSurf sources — but using UPSTREAM's
// fetchers/curl.c instead of the gucOS http fetcher.
//
// Point: gucOS's NetSurf and this binary share 100% of the parse/charset
// code. The ONLY difference is the fetcher. If this one renders UTF-8 pages
// correctly and gucOS's does not, the fetcher is where the encoding is lost.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const NS = path.join(ROOT, 'vendor', 'netsurf');
const OUT = path.join(ROOT, 'build', 'nscharset');
fs.mkdirSync(OUT, { recursive: true });

const SDK = execFileSync('xcrun', ['--show-sdk-path']).toString().trim();

// ---- gather sources from the same json manifests the wasm build uses ----
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sources = [];
const includes = [];

const core = readJson(path.join(NS, 'netsurf-core.json'));
for (const s of core.sources) sources.push(path.join(NS, s));
for (const i of core.includes) includes.push(path.join(NS, i));

for (const lib of ['libwapcaplet', 'libparserutils', 'libhubbub', 'libdom',
                   'libcss', 'libnsgif', 'libnsbmp', 'libnsutils']) {
  const j = readJson(path.join(NS, lib, 'lib.json'));
  for (const s of j.sources) sources.push(path.join(NS, lib, s));
  for (const i of j.includes) includes.push(path.join(NS, lib, i));
}

const monkey = readJson(path.join(NS, 'bin.json'));
for (const s of monkey.sources) sources.push(path.join(NS, s));

// UPSTREAM's real HTTP fetcher — the whole point of the native build.
sources.push(path.join(NS, 'netsurf', 'content', 'fetchers', 'curl.c'));

// PNG needs an external libpng we do not have natively; the charset question
// does not involve images, so drop that handler (and its -DWITH_PNG).
// The vendored zlib is for the wasm target — link the SDK's instead.
const drop = new Set(['png.c']);
const finalSources = sources.filter(s =>
  !drop.has(path.basename(s)) && !/\/vendor\/zlib\//.test(s));

// `shim/` carries BOTH things we need natively (dom/…, testament.h) and
// things that would shadow the SDK (arpa/, netinet/, iconv.h). Stage a
// native-only include dir with just the two we want.
const SHIM = path.join(NS, 'shim');
const NATINC = path.join(OUT, 'natinc');
fs.rmSync(NATINC, { recursive: true, force: true });
fs.mkdirSync(NATINC, { recursive: true });
fs.symlinkSync(path.join(SHIM, 'dom'), path.join(NATINC, 'dom'));
fs.symlinkSync(path.join(SHIM, 'testament.h'), path.join(NATINC, 'testament.h'));
const finalIncludes = includes.filter(i => !/\/shim$/.test(i)).concat([NATINC]);

const args = [
  '-std=gnu99', '-w', '-O1', '-g0',
  '-isysroot', SDK,
  ...finalIncludes.flatMap(i => ['-I', i]),
  '-I', path.join(NS, 'genjs'),
  '-I', NS,
  '-DWITH_CURL', '-DWITH_BMP', '-DWITH_GIF',
  '-Dnsmonkey',
  '-DMONKEY_RESPATH="' + path.join(OUT, 'res') + '/"',
  '-DNETSURF_BUILTIN_LOG_FILTER="level:WARNING"',
  '-DNETSURF_BUILTIN_VERBOSE_FILTER="level:VERBOSE"',
  '-DNETSURF_UA_FORMAT_STRING="NetSurf/%d.%d"',
  '-DNETSURF_HOMEPAGE="about:welcome"',
  ...finalSources,
  '-lcurl', '-lz', '-liconv', '-lpthread',
  '-o', path.join(OUT, 'nsmonkey-native'),
];

console.log(`compiling ${finalSources.length} sources natively (clang, SDK ${path.basename(SDK)}) …`);
const t0 = Date.now();
const r = spawnSync('clang', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (r.status !== 0) {
  const errs = (r.stderr || '').split('\n');
  const only = errs.filter(l => /error:/.test(l));
  console.error(`native build FAILED in ${secs}s — ${only.length} error lines; first 40:`);
  console.error(only.slice(0, 40).join('\n'));
  const undef = errs.filter(l => /Undefined symbols|_[A-Za-z_]+", referenced/.test(l));
  if (undef.length) { console.error('\nlink errors (first 40):'); console.error(undef.slice(0, 40).join('\n')); }
  process.exit(1);
}
console.log(`built ${path.join(OUT, 'nsmonkey-native')} in ${secs}s`);
