#!/usr/bin/env node
// Ad-hoc (netsurf-bughunt lane): open every shipped netsurf demo headless,
// shot each window, and persist the shots as viewable PNGs for interaction
// calibration. Not a test — a calibration tool.
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage } = require('./lib/drive.js');
const { parsePng, encodePng } = require('../lib/png.js');

const ROOT = path.resolve(__dirname, '../..');
const NSDEMOS = require(path.join(ROOT, 'vendor/netsurf/demos/demos.js'));
const OUT = process.argv[2] || '/tmp/nscal';
fs.mkdirSync(OUT, { recursive: true });

const PKG = 'netsurf-demos';
const SEED_DEST = Object.keys(JSON.parse(fs.readFileSync(
  path.join(ROOT, 'packages', PKG + '.json'), 'utf8')).seed)[0];
const BASE = '/root/' + SEED_DEST;
const DEMOS = NSDEMOS.demos();

const script = [];
for (const d of DEMOS) {
  script.push(
    `netsurf "${BASE}/${d.name}/index.html" &`,
    `wmctl wait win "${d.title}" 60000`,
    `S=$(wmctl list | grep "\t${d.title}$" | sed "s/[^0-9].*//")`,
    `wmctl shot $S /root/cal-${d.name}.png && echo shot-${d.name}-ok`,
    `wmctl close $S && wmctl wait nowin "${d.title}" 8000 && echo closed-${d.name}`,
  );
}

const { dir, image } = freshImage('os-nscal-');
const r = driveBoot(script, { image, timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
for (const d of DEMOS) {
  if (!r.stdout.includes(`shot-${d.name}-ok`)) { console.log('NO SHOT: ' + d.name); }
}
const back = driveBoot('cat ' + DEMOS.map((d) => `/root/cal-${d.name}.png`).join(' ') + '\n',
                       { image, encoding: null, maxBuffer: 256 * 1024 * 1024 });
let off = 0;
for (const d of DEMOS) {
  const { w, h, rgba: rgb, next } = parsePng(back.stdout, off);
  off = next;
  fs.writeFileSync(path.join(OUT, `cal-${d.name}.png`), encodePng(w, h, rgb));
  console.log(`saved ${OUT}/cal-${d.name}.png (${w}x${h})`);
}
fs.rmSync(dir, { recursive: true, force: true });
