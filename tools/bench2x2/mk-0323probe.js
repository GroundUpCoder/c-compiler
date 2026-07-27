#!/usr/bin/env node
// bench-2x2: derive a CPython-linkable compiler from STOCK v176 compiler.js by
// applying ONLY the 0323 probe relaxation.
//
// As of v176 (main @82bf5994) the 0320 preprocessor blow-up and the 0321 static
// re-declaration bug are BOTH shipped, so stock compiler.js compiles all 174
// CPython TUs. The one remaining blocker is todos/0323: whole-program link
// rejects a cross-TU declared-type mismatch (a `const` qualifier with no ABI
// consequence) that separate compilation allows and clang/gcc/MSVC accept.
//
// This is the SAME blunt error->warning downgrade the M0 probe used. It is NOT
// a fix for 0323 and must never be reported as one -- it is the minimum edit
// that lets an artifact exist so the A/B can be measured at all.
//
//   node mk-0323probe.js <stock-compiler.js> <out.js>
const fs = require('fs');
const [, , src, out] = process.argv;
if (!src || !out) { console.error('usage: mk-0323probe.js <in> <out>'); process.exit(2); }

let s = fs.readFileSync(src, 'utf8');
const needle = 'addError(`conflicting types for ';
const i = s.indexOf(needle);
if (i < 0) throw new Error('0323 link-check site not found -- compiler.js changed shape');
if (s.indexOf(needle, i + 1) >= 0) throw new Error('0323 site is not unique');

const lineStart = s.lastIndexOf('\n', i) + 1;
const lineEnd = s.indexOf('\n', i);
const orig = s.slice(lineStart, lineEnd);

const repl = "      if (typeof process !== 'undefined' && process.stderr) "
  + "process.stderr.write('warning[0323-probe]: conflicting types for ' + getName(a) + '\\n');";

s = s.slice(0, lineStart) + repl + s.slice(lineEnd);
fs.writeFileSync(out, s);
console.log('site   : ' + src + ' offset ' + i);
console.log('was    : ' + orig.trim());
console.log('now    : ' + repl.trim());
console.log('wrote  : ' + out + ' (' + fs.statSync(out).size + ' bytes)');
