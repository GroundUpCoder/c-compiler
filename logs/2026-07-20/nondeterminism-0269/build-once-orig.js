// Build vendor/sameboy/bin.json using compiler.js + os-common.js pinned at
// 7d04f1d (the commit where the drift was originally observed). vendor/ is
// unchanged since, so we read it from the worktree.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const CompilerJS = require(path.join(__dirname, 'orig', 'compiler.js'));
const COMMON = require(path.join(__dirname, 'orig', 'os-common.js'));

const readHostFile = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

const wasm = COMMON.buildProject(CompilerJS, 'vendor/sameboy/bin.json', readHostFile);
const buf = Buffer.from(wasm);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
process.stdout.write(sha + ' ' + buf.length + '\n');
