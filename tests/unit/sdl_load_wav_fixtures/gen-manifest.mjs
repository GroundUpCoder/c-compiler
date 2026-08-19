#!/usr/bin/env node
// gen-manifest.mjs — collect the pinned-upstream oracle's verdicts into the
// committed reference manifest (manifest.json) for #529-B (#723).
//
//   node gen-manifest.mjs <path-to-native-oracle-binary>
//
// The oracle binary is built OUT OF TREE against upstream SDL at the pin —
// build recipe in logs/2026-08-20/529b-evidence/oracle.c and ../sdl_load_wav/upstream.json. This script is
// committed for provenance; CI never runs it (the committed manifest IS the
// pinned upstream truth; regenerating it requires rebuilding the oracle).
//
// Every fixture's entry records the upstream result verbatim: success ->
// {format, channels, freq, len, bufnull, sha256(decoded bytes)}; failure ->
// the exact upstream error string. The differential test compares the gucOS
// loader byte-for-byte (via sha256) and string-for-string against this,
// because the adaptation preserves upstream's decoder logic AND its error
// wording verbatim. IO-layer errors (unopenable path) are the one deliberate
// divergence — the private FILE* adapter words its own errors — and those
// have no fixture here by construction.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const oracle = process.argv[2];
if (!oracle) { console.error('usage: gen-manifest.mjs <oracle-binary>'); process.exit(1); }

const wavs = fs.readdirSync(HERE).filter((f) => f.endsWith('.wav')).sort();
const out = execFileSync(oracle, wavs.map((f) => path.join(HERE, f)), { encoding: 'utf8', maxBuffer: 1 << 24 });

const entries = {};
for (const line of out.trim().split('\n')) {
  const r = JSON.parse(line);
  entries[path.basename(r.file)] = r.ok
    ? { ok: true, format: r.format, channels: r.channels, freq: r.freq, len: r.len, bufnull: r.bufnull, sha256: r.sha256 }
    : { ok: false, error: r.error };
}

const manifest = {
  _meta: {
    pin: 'libsdl-org/SDL release-3.4.0 @ a962f40bbba175e9716557a25d5d7965f134a3d3',
    oracle: 'oracle.c built natively against the pinned upstream static SDL3 (recipe in oracle.c); no hints set (upstream 3.4.0 defaults)',
    generator: 'gen-fixtures.mjs (deterministic; seeded LCG per fixture name) + sample.wav/sword.wav imported verbatim from the pinned SDL test/ tree (zlib license)',
    fixtures: wavs.length,
  },
  fixtures: entries,
};
fs.writeFileSync(path.join(HERE, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`manifest.json: ${wavs.length} fixtures`);
