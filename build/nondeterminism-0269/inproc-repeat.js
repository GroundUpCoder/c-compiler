// Build sameboy REPEATEDLY in ONE process; report SHA per iteration.
// Mimics the bake (many builds share a process). Optional arg: iterations.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..');
const which = process.env.PIN ? 'orig' : '.';
const CompilerJS = require(process.env.PIN ? path.join(__dirname,'orig','compiler.js') : path.join(ROOT,'compiler.js'));
const COMMON = require(process.env.PIN ? path.join(__dirname,'orig','os-common.js') : path.join(ROOT,'os','os-common.js'));
const readHostFile = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const N = parseInt(process.argv[2] || '20', 10);
const seen = {};
for (let i = 0; i < N; i++) {
  const wasm = COMMON.buildProject(CompilerJS, 'vendor/sameboy/bin.json', readHostFile);
  const buf = Buffer.from(wasm);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  seen[sha] = (seen[sha]||0)+1;
  console.log(`${String(i+1).padStart(3)}/${N} ${sha} ${buf.length}`);
}
console.log('--- distinct:', Object.keys(seen).length, JSON.stringify(seen));
