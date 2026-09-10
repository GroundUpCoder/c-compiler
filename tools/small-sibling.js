'use strict';
// Snapshot the optional sibling once per image assembly. No runtime checkout dependency.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
function snapshot(root) {
  const sibling = path.resolve(root, '../small');
  if (!fs.existsSync(sibling)) return null;
  const files = {};
  function read(name) {
    const full = path.join(sibling, name);
    const real = fs.realpathSync(full);
    if (!real.startsWith(fs.realpathSync(sibling) + path.sep)) throw new Error('Small source escapes sibling: ' + name);
    return fs.readFileSync(full, 'utf8');
  }
  try {
    files['compiler.js'] = read('small.js').replace(/^#![^\n]*/, '');
    const context = vm.createContext({});
    vm.runInContext(files['compiler.js'], context, { timeout: 10000 });
    const Small = context.Small;
    if (!Small || typeof Small.compileGucosProgram !== 'function' || typeof Small.createHostModule !== 'function')
      throw new Error('compiler lacks compileGucosProgram/createHostModule');
    files['runtime.js'] = '(' + Small.createHostModule.toString() + ')()';
    function walk(dir) {
      for (const name of fs.readdirSync(path.join(sibling, dir)).sort()) {
        const rel = dir + '/' + name;
        const st = fs.lstatSync(path.join(sibling, rel));
        if (st.isSymbolicLink()) throw new Error('symlinks are not supported in Small root: ' + rel);
        if (st.isDirectory()) walk(rel);
        else if (name.endsWith('.wc')) files[rel] = read(rel);
      }
    }
    walk('root');
    for (const rel of ['root/gucos/Runtime.wc', 'root/std/Memory.wc', 'root/java/lang/String.wc', 'root/java/lang/System.wc'])
      if (!files[rel]) throw new Error('missing ' + rel);
    const sha256 = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
    return { files, sha256 };
  } catch (e) { throw new Error('invalid Small sibling at ' + sibling + ': ' + e.message); }
}
function fold(root, manifest) {
  const snap = snapshot(root);
  if (!snap) return manifest;
  const result = JSON.parse(JSON.stringify(manifest));
  const system = result.system || (result.system = { dirs: [], files: {} });
  const dirs = new Set([...(system.dirs || []), "/usr/bin"]);
  for (const name of Object.keys(snap.files).sort()) {
    const dest = '/usr/lib/small/' + name;
    let parent = path.posix.dirname(dest);
    while (parent !== '/' && parent !== '/usr') { dirs.add(parent); parent = path.posix.dirname(parent); }
    if (system.files[dest]) throw new Error('Small snapshot collision: ' + dest);
    system.files[dest] = { content: snap.files[name] };
  }
  system.dirs = [...dirs].sort((a,b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  system.files['/usr/lib/small/snapshot.json'] = { content: JSON.stringify({ format: 1, sha256: snap.sha256 }) + '\n' };
  if (system.files['/usr/bin/small']) throw new Error('Small command already installed');
  system.files['/usr/bin/small'] = { c: 'cc.c' };
  result.smallSnapshot = snap.sha256;
  return result;
}
function metadataMatches(imagePath, expected) {
  try {
    const metadata = JSON.parse(fs.readFileSync(imagePath + '.small.json', 'utf8'));
    return metadata.format === 1 && metadata.smallSnapshot === (expected || null);
  } catch (e) { return false; }
}
module.exports = { snapshot, fold, metadataMatches };
