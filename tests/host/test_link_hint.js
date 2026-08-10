#!/usr/bin/env node
'use strict';
// #632 — the __link_hint directive: a header-carried diagnostic for a library
// that deliberately does NOT auto-require its sources. At link time an
// undefined symbol whose name starts with the hint's prefix gets the hint's
// message appended to its error, so a default-include-path header's promise
// fails NAMING the fix instead of as a bare "Undefined symbol".
//
// libgit2 is the founding consumer: <git2.h> cannot carry a __require_source
// block (211 TUs, ~19 s per in-OS compile, and its vendored deps/zlib would
// duplicate-define against <zlib.h>'s z/* block in any mixed program), so
// git2/common.h carries a __link_hint naming <git2_srclib.h> instead. Leg (5)
// pins that wiring — deleting the hint from the real header goes red HERE,
// on every compiler.js diff, without booting an OS.
var fs = require('fs');
var os = require('os');
var path = require('path');
var { spawnSync } = require('child_process');

var ROOT = path.join(__dirname, '..', '..');
var COMPILER = path.join(ROOT, 'compiler.js');
var failures = 0;

function check(name, ok, detail) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (!ok && detail ? ' — ' + detail : ''));
  if (!ok) failures++;
}

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'link-hint-'));
function write(name, text) {
  var p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  return p;
}
function compile(args) {
  var r = spawnSync(process.execPath, [COMPILER].concat(args, ['-o', path.join(tmp, 'out.wasm')]),
    { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ---- (1) prefix-scoped: the hint reaches matching symbols and ONLY them ----
var a = write('a.c', [
  '__link_hint("demo_", "add demo_srclib.h");',
  'extern int demo_missing(void);',
  'extern int other_missing(void);',
  'int main(void) { return demo_missing() + other_missing(); }',
  '',
].join('\n'));
var r1 = compile([a]);
check('(1) undefined symbol matching the prefix carries the hint',
  r1.status !== 0 && /Undefined symbol 'demo_missing' during linking — add demo_srclib\.h/.test(r1.out), r1.out);
check('(1) undefined symbol OUTSIDE the prefix stays bare (scope control)',
  /Undefined symbol 'other_missing' during linking\n/.test(r1.out) &&
  !/other_missing' during linking —/.test(r1.out), r1.out);

// ---- (2) cross-TU: a hint declared in one TU reaches a reference in another ----
var hintH = write('hint.h', '__link_hint("demo_", "add demo_srclib.h");\n');
var b1 = write('b1.c', '#include "hint.h"\nint unrelated(void) { return 1; }\n');
var b2 = write('b2.c', 'extern int demo_gone(void);\nint main(void) { return demo_gone(); }\n');
var r2 = compile([b1, b2]);
check('(2) a hint from TU A annotates an undefined reference in TU B',
  r2.status !== 0 && /demo_gone' during linking — add demo_srclib\.h/.test(r2.out), r2.out);

// ---- (3) dedup: the same header in N TUs appends the message once ----
var c1 = write('c1.c', '#include "hint.h"\nint unrelated1(void) { return 1; }\n');
var c2 = write('c2.c', '#include "hint.h"\nextern int demo_gone(void);\nint main(void) { return demo_gone(); }\n');
var r3 = compile([c1, c2]);
var appended = (r3.out.match(/add demo_srclib\.h/g) || []).length;
check('(3) duplicate hint registrations collapse (message appears exactly once)',
  r3.status !== 0 && appended === 1, 'appearances=' + appended + '\n' + r3.out);

// ---- (4) malformed directives fail loud, never parse as something else ----
var d1 = write('d1.c', '__link_hint("demo_");\nint main(void) { return 0; }\n');
var r4a = compile([d1]);
check('(4) missing message argument is a compile error', r4a.status !== 0, r4a.out);
var d2 = write('d2.c', '__link_hint("", "message");\nint main(void) { return 0; }\n');
var r4b = compile([d2]);
check('(4) empty prefix is a compile error naming the rule',
  r4b.status !== 0 && /non-empty/.test(r4b.out), r4b.out);

// ---- (5) the real consumer: git2/common.h carries the libgit2 hint ----
// This is the wiring red control for #632 — remove the __link_hint from
// vendor/libgit2/include/git2/common.h and this leg goes red.
var g = write('g.c', '#include <git2.h>\nint main(void) { return git_libgit2_init() < 0; }\n');
var r5 = compile(['-I' + path.join(ROOT, 'vendor/libgit2/include'), g]);
check('(5) bare <git2.h> link failure names <git2_srclib.h> (the #632 hint)',
  r5.status !== 0 &&
  /Undefined symbol 'git_libgit2_init' during linking — libgit2 does not link automatically/.test(r5.out) &&
  /git2_srclib\.h/.test(r5.out), r5.out);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? '\nlink-hint: ' + failures + ' FAILED' : '\nlink-hint: PASS');
process.exit(failures ? 1 : 0);
