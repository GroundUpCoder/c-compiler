// Build vendor/sameboy/bin.json once, print SHA-256 of the wasm output.
// Fresh process per invocation (harness spawns node repeatedly).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const CompilerJS = require(path.join(ROOT, 'compiler.js'));
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));

const readHostFile = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

const wasm = COMMON.buildProject(CompilerJS, 'vendor/sameboy/bin.json', readHostFile);
const buf = Buffer.from(wasm);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
process.stdout.write(sha + ' ' + buf.length + '\n');
