// The freshness spec for build-doom.mjs's product (ticket #466), shared by
// doom-renders.mjs and doom-motion-check.mjs so the two drivers cannot drift
// apart on what "fresh" means. The comparison itself lives in
// fresh-artifacts.mjs (ticket #171) — this module only states the inputs.
//
// build-doom.mjs runs `node compiler.js vendor/doom/bin.json -o www/doom.html`,
// so the emitted page is a function of:
//   - compiler.js, plus the two siblings it reads at emit time: host.js
//     (inlined into every single-file HTML bundle) and libc-ext.js (optional
//     extension libc sources merged into the stdlib when present);
//   - vendor/doom/bin.json and everything it names: the src/ and Nuked-OPL3/
//     translation units and the bundled data/doom1.wad (dataFiles);
//   - build-doom.mjs itself (its flags shape the output).
// This closure is deliberately WIDER than bin.json's literal source list — it
// takes every .c/.h under src/ and Nuked-OPL3/ rather than re-parsing the
// manifest, the same conservative over-approximation quake-renders.mjs uses:
// a header not currently included can only make a fresh artifact look stale,
// never a stale one look fresh.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TB   = path.resolve(__dirname, '..');            // tests/browser
export const ROOT = path.resolve(TB, '..', '..');      // repo root

export function doomFreshnessSpec() {
  const DOOM = path.join(ROOT, 'vendor', 'doom');
  return [{
    artifact: path.join(TB, 'www', 'doom.html'),
    inputs: [
      path.join(ROOT, 'compiler.js'),
      path.join(ROOT, 'host.js'),
      path.join(ROOT, 'libc-ext.js'),
      path.join(DOOM, 'bin.json'),
      { dir: path.join(DOOM, 'src'),        match: /\.[ch]$/ },
      { dir: path.join(DOOM, 'Nuked-OPL3'), match: /\.[ch]$/ },
      path.join(DOOM, 'data', 'doom1.wad'),
      path.join(TB, 'build-doom.mjs'),
    ],
    rebuild: 'node tests/browser/build-doom.mjs',
  }];
}
