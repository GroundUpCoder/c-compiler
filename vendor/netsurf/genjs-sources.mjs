#!/usr/bin/env node
// Keep netsurf-core.json's generated-binding source list == nsgenbind's own
// manifest.  Called by regen-js-bindings.sh (maintainer-only); not part of any
// build.
//
//   node genjs-sources.mjs <generated-Makefile> <netsurf-core.json> [--check]
//
// nsgenbind emits a `Makefile` fragment next to the sources whose
// NSGENBIND_SOURCES variable lists exactly the .c files it generated, in the
// order upstream's build compiles them.  netsurf-core.json has to carry the
// same list (buildProject has no wildcards — by design), so an interface added
// to or removed from a .idl/.bnd would otherwise mean a hand-edited 223-line
// JSON block.  This splices the block instead, preserving the rest of the file
// byte-for-byte (a JSON round-trip would reformat all 380 lines and bury the
// real diff).
//
// --check: report drift and exit 1 instead of rewriting.

import fs from 'node:fs';
import process from 'node:process';

const [mkPath, jsonPath, ...rest] = process.argv.slice(2);
const check = rest.includes('--check');
if (!mkPath || !jsonPath) {
  console.error('usage: genjs-sources.mjs <generated-Makefile> <netsurf-core.json> [--check]');
  process.exit(2);
}

const PREFIX = 'genjs/duktape/';

// ---- nsgenbind's manifest ----
const mk = fs.readFileSync(mkPath, 'utf-8');
const m = mk.match(/^NSGENBIND_SOURCES\s*:?=\s*(.*)$/m);
if (!m) {
  console.error(`genjs-sources: no NSGENBIND_SOURCES in ${mkPath}`);
  process.exit(1);
}
const want = m[1].trim().split(/\s+/).filter(Boolean).map((f) => PREFIX + f);
if (want.length === 0) {
  console.error('genjs-sources: NSGENBIND_SOURCES is empty — refusing to blank the source list');
  process.exit(1);
}

// ---- the committed block ----
const src = fs.readFileSync(jsonPath, 'utf-8');
const lines = src.split('\n');
const isGenjs = (l) => l.trim().replace(/^"|",?$/g, '').startsWith(PREFIX);
const first = lines.findIndex(isGenjs);
if (first < 0) {
  console.error(`genjs-sources: ${jsonPath} lists no ${PREFIX} sources`);
  process.exit(1);
}
let last = first;
while (last + 1 < lines.length && isGenjs(lines[last + 1])) last++;
// A non-contiguous block would mean the list was hand-shuffled; splicing would
// silently drop the strays, so refuse.
const total = lines.filter(isGenjs).length;
if (total !== last - first + 1) {
  console.error(`genjs-sources: ${PREFIX} entries are not contiguous in ${jsonPath} — fix by hand`);
  process.exit(1);
}

const have = lines.slice(first, last + 1)
  .map((l) => l.trim().replace(/^"|",?$/g, ''));

if (have.length === want.length && have.every((h, i) => h === want[i])) {
  console.log(`genjs-sources: netsurf-core.json matches NSGENBIND_SOURCES (${want.length} files)`);
  process.exit(0);
}

const added = want.filter((w) => !have.includes(w));
const removed = have.filter((h) => !want.includes(h));
const report = [
  `${have.length} listed vs ${want.length} generated`,
  added.length ? `+${added.length} (${added.slice(0, 5).join(' ')}${added.length > 5 ? ' …' : ''})` : '',
  removed.length ? `-${removed.length} (${removed.slice(0, 5).join(' ')}${removed.length > 5 ? ' …' : ''})` : '',
  !added.length && !removed.length ? 'same set, different order' : '',
].filter(Boolean).join('; ');

if (check) {
  console.error(`genjs-sources: DRIFT — ${report}`);
  process.exit(1);
}

// Match the surrounding indent/comma style rather than assuming it.
const indent = lines[first].match(/^\s*/)[0];
const tailComma = lines[last].trimEnd().endsWith(',');
const block = want.map((w, i) => {
  const comma = i < want.length - 1 || tailComma ? ',' : '';
  return `${indent}"${w}"${comma}`;
});
lines.splice(first, last - first + 1, ...block);
fs.writeFileSync(jsonPath, lines.join('\n'));
console.log(`genjs-sources: rewrote netsurf-core.json's ${PREFIX} block — ${report}`);
