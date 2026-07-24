#!/usr/bin/env node
// Lane A (win32 source-lib design §1/§8) e2e: the in-OS cc resolves system
// headers and __require_source names from the standard OS install locations
// — /usr/local/include + /usr/include for headers, /usr/local/src + /usr/src
// for sources (admin tier before baked tier; /usr/local lands on the
// writable /var/local, so a booted shell can plant a lib with no bake).
//
//   - a SYNTHETIC source-lib planted from the shell: mylib.h under
//     /usr/local/include carrying __require_source("mylib/impl.c"), the
//     impl under /usr/local/src/mylib/ — `cc main.c && ./a.out` works with
//     no -I and no explicit TU list (the SDL-shaped FS story)
//   - the pulled TU is a full citizen: its own quote include resolves
//     beside its resolved path, and its own __require_source chains
//     transitively
//   - negative: a '..'-bearing require name is a LOUD compile error
//     (traversal closed), not a silent miss
//   - negative: builtin names planted on disk still resolve builtin —
//     a poisoned /usr/local/src/__SDL.c does not hijack an explicit
//     __require_source("__SDL.c"), and a poisoned __alloca.c (auto-required
//     by EVERY compile) plus a poisoned /usr/local/include/stdio.h don't
//     break plain hello.c (builtins beat ambient system dirs)
//
// Run: node tests/kernel/test_cc_srclib_e2e.js
'use strict';
const { driveBoot, freshImage, section } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { image } = freshImage('os-srclib-');

const script = [
  // ---- plant the synthetic source-lib (admin tier, writable) ----
  'mkdir -p /usr/local/include /usr/local/src/mylib',
  "cat > /usr/local/include/mylib.h << 'EOF'",
  '#ifndef MYLIB_H',
  '#define MYLIB_H',
  '__require_source("mylib/impl.c");',
  'int mylib_add(int a, int b);',
  'int mylib_tag(void);',
  '#endif',
  'EOF',
  "cat > /usr/local/src/mylib/impl.c << 'EOF'",
  '__require_source("mylib/impl2.c");',
  '#include "impl_priv.h"',
  'int mylib_two(void);',
  'int mylib_add(int a, int b) { return a + b; }',
  'int mylib_tag(void) { return IMPL_PRIV + mylib_two(); }',
  'EOF',
  "cat > /usr/local/src/mylib/impl_priv.h << 'EOF'",
  '#define IMPL_PRIV 40',
  'EOF',
  "cat > /usr/local/src/mylib/impl2.c << 'EOF'",
  'int mylib_two(void) { return 2; }',
  'EOF',
  // ---- the acceptance compile: no -I, no explicit TU list ----
  "cat > /root/main.c << 'EOF'",
  '#include <stdio.h>',
  '#include <mylib.h>',
  'int main(void) {',
  '    printf("sum=%d tag=%d\\n", mylib_add(2, 3), mylib_tag());',
  '    return 0;',
  '}',
  'EOF',
  'cd /root && cc main.c && ./a.out',
  'echo rc=$?',
  // ---- negative: traversal name is a loud compile error ----
  "cat > /root/bad.c << 'EOF'",
  '__require_source("../../etc/x.c");',
  'int main(void) { return 0; }',
  'EOF',
  'echo ==bad',
  'cc bad.c 2>&1',
  'echo badrc=$?',
  // ---- negative: builtin precedence over planted twins ----
  'echo "#error planted __SDL.c hijacked the builtin" > /usr/local/src/__SDL.c',
  'echo "#error planted __alloca.c hijacked the builtin" > /usr/local/src/__alloca.c',
  'echo "#error planted stdio.h hijacked the builtin" > /usr/local/include/stdio.h',
  "cat > /root/sdlreq.c << 'EOF'",
  '__require_source("__SDL.c");',
  'int main(void) { return 0; }',
  'EOF',
  'echo ==builtin',
  'cc sdlreq.c -o sdlreq.out && echo SDL-BUILTIN-WINS',
  'cc hello.c && ./a.out',                       // seeded hello.c: stdio.h + __alloca.c poison inert
  'echo ==done',
  'exit',
].join('\n');

const r = driveBoot(script, { image, timeout: 420000 });
check('session exits clean', r.status === 0, String(r.status) + ' ' + (r.stderr || '').slice(-300));

const lines = r.stdout.split('\n');
check('FS-resolved lib compiles and runs (sum + transitive tag)',
  lines.includes('sum=5 tag=42'), JSON.stringify(lines.slice(0, 6)));
check('acceptance compile rc=0', lines.includes('rc=0'), JSON.stringify(lines.slice(0, 6)));

const bad = section(r.stdout, 'bad');
check('traversal require name is a loud compile error',
  bad.includes('invalid required source name') && bad.includes('badrc=1'), JSON.stringify(bad));
check('traversal error names the offender', bad.includes('../../etc/x.c'), JSON.stringify(bad));

const builtin = section(r.stdout, 'builtin');
check('planted __SDL.c does not hijack the builtin',
  builtin.includes('SDL-BUILTIN-WINS'), JSON.stringify(builtin));
check('poisoned stdio.h/__alloca.c twins are inert (hello still runs)',
  builtin.includes('hello, wasm world'), JSON.stringify(builtin));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
