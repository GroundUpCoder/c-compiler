// Spike: build a freetype-linked service blob with buildProject (the exact
// bake-time pipeline) and dump its import/export surface.
const fs = require('fs');
const path = require('path');
const CompilerJS = require(path.join(__dirname, '../../../compiler.js'));
const OS_COMMON = require(path.join(__dirname, '../../../os/os-common.js'));
const root = path.join(__dirname, '../../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const proj = process.argv[2] || 'os/ksvc/bin.json';
const bytes = OS_COMMON.buildProject(CompilerJS, proj, read);
fs.writeFileSync(path.join(__dirname, 'ksvc.wasm'), bytes);
const mod = new WebAssembly.Module(bytes);
console.log('== bytes:', bytes.length);
console.log('== imports:');
for (const i of WebAssembly.Module.imports(mod)) console.log('  ', i.module + '.' + i.name, i.kind);
console.log('== exports:');
for (const e of WebAssembly.Module.exports(mod)) console.log('  ', e.name, e.kind);
