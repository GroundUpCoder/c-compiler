#!/usr/bin/env node
// embed.mjs — splice adapt.mjs's output into compiler.js as the builtin
// "__SDL_wave.h" / "__SDL_wave.c" template-literal entries (#723).
//
// Idempotent: an existing entry is replaced, a missing one is inserted at its
// anchor. Escaping: backslash, backtick, and ${ are escaped for the JS
// template literal (the standard builtin-source embedding rules).
//
//   node embed.mjs <path-to-compiler.js>

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
if (!target) { console.error('usage: embed.mjs <compiler.js>'); process.exit(1); }

const adaptedH = execFileSync('node', [path.join(HERE, 'adapt.mjs'), '--print', 'h'], { encoding: 'utf8', maxBuffer: 1 << 24 });
const adaptedC = execFileSync('node', [path.join(HERE, 'adapt.mjs'), '--print', 'c'], { encoding: 'utf8', maxBuffer: 1 << 24 });

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

function splice(text, key, content, anchor) {
  const entry = `  "${key}": \`\n${esc(content)}\`,\n`;
  const startPat = `  "${key}": \``;
  const start = text.indexOf(startPat);
  if (start >= 0) {
    // replace the existing entry: find the closing backtick-comma-newline
    let i = start + startPat.length;
    for (;;) {
      const bt = text.indexOf('`', i);
      if (bt < 0) throw new Error(key + ': unterminated entry');
      if (text[bt - 1] === '\\') { i = bt + 1; continue; }
      if (text.slice(bt, bt + 3) !== '`,\n') throw new Error(key + ': unexpected entry terminator');
      return text.slice(0, start) + entry + text.slice(bt + 3);
    }
  }
  const a = text.indexOf(anchor);
  if (a < 0) throw new Error(key + ': anchor not found: ' + anchor);
  return text.slice(0, a) + entry + text.slice(a);
}

let js = fs.readFileSync(target, 'utf8');
js = splice(js, '__SDL_wave.h', adaptedH, '  "__atexit.h": `');
js = splice(js, '__SDL_wave.c', adaptedC, '  "__SDL_image.c": `');
fs.writeFileSync(target, js);
console.log('embedded __SDL_wave.h (%d B) + __SDL_wave.c (%d B) into %s', adaptedH.length, adaptedC.length, target);
