#!/usr/bin/env node
'use strict';
// Package-launcher convention lint (todos/0444, ticket #189).
//
// Every inline /bin/sh launcher a package ships must be SPAWN-FREE: the old
// dirname-of-realpath self-location convention cost four processes per launch
// (two subshells + realpath + dirname — the majority of `python --version`'s
// spawn chain). The replacement is a known-prefix probe over the only two
// plant sites — /opt/<name> (gucman install) else /usr/opt/<name> (the
// os-common.js bake fold) — using `[`, a hush builtin (CONFIG_HUSH_TEST=y),
// so self-location spawns nothing.
//
// Rules enforced over packages/*.json `files[].content` entries that start
// with "#!/bin/sh" (derivation, not a carried list — a new launcher is linted
// the day it lands):
//   1. No command substitution outside comments: no `$(` and no backtick.
//   2. Both plant sites or neither: a launcher that hardcodes /opt/<name>
//      must also handle /usr/opt/<name> (and vice versa) — a single-prefix
//      launcher works installed but breaks silently on the fat (baked) image,
//      or the other way round.
//
// A third rule (no plain shell-variable assignment) existed while #296 was
// open — the libc's copy+free putenv corrupted hush's variable store on
// script files under the default boot env. #296 fixed putenv to POSIX
// pointer semantics; assignments in launchers are safe again, so the rule
// (and register entry L67) is retired.
//
// Run: node tests/host/test_launcher_convention.js
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const dir = path.join(ROOT, 'packages');
const defs = fs.readdirSync(dir).filter((f) => /\.json$/.test(f)).sort();
let launchers = 0;

for (const f of defs) {
  const name = f.slice(0, -5);
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
  for (const [key, entry] of Object.entries(d.files || {})) {
    if (!entry || typeof entry.content !== 'string') continue;
    if (!entry.content.startsWith('#!/bin/sh')) continue;
    launchers++;
    const label = `${name}:${key}`;
    // Strip comment lines — a backtick or "$(" in prose is inert; the lint
    // is about what the shell executes.
    const code = entry.content.split('\n')
      .filter((l) => !/^\s*#/.test(l)).join('\n');
    check(`${label}: no command substitution ($( ) outside comments`,
      !code.includes('$('), code);
    check(`${label}: no backtick substitution outside comments`,
      !code.includes('`'), code);
    const opt = code.includes(`/opt/${name}`);
    const usrOpt = code.includes(`/usr/opt/${name}`);
    check(`${label}: handles both plant sites (/opt + /usr/opt) or neither`,
      opt === usrOpt, code);
  }
}

// The census tripwire from the ticket: the derived launcher set is the real
// answer, but ZERO launchers means the derivation grep went dark — fail loud
// rather than vacuously pass (the 0444 estate ships 6).
check(`derived launcher set is non-empty (found ${launchers} across ${defs.length} packages)`,
  launchers > 0);

console.log(failures ? `\nlauncher convention: ${failures} FAILED` : '\nlauncher convention: PASS');
process.exit(failures ? 1 : 0);
