#!/usr/bin/env node
// Regenerates manifest-sha256.json for this evidence folder (every file but
// this script and the manifest itself), sorted by path.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = __dirname;
const out = {};
(function walk(dir) {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    const rel = path.relative(root, p);
    if (rel === 'manifest.js' || rel === 'manifest-sha256.json') continue;
    out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
})(root);
fs.writeFileSync(path.join(root, 'manifest-sha256.json'), JSON.stringify(out, null, 2) + '\n');
console.log(Object.keys(out).length + ' files hashed');
