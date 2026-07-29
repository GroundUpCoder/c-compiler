#!/usr/bin/env node
// todos/0421 — the page console reaches the tty, IN THE OS.
//
// A page author inside gucOS had no evidence channel at all: the gucOS
// window table carried no `console_log`, so every console call ended at
// NSLOG, which is silent without the `-v` first argument.  The demos
// document the console as their own evidence channel; in the OS those
// reports went nowhere.  gucos/gui.c now writes one `js: SOURCE: LEVEL:
// TEXT` line per entry to stderr, which is the shell's tty when the
// browser runs as `netsurf page.html &`.
//
// The page is shaped so the wait is a real completion marker, not a
// clock: the console calls sit in a <head> script and the <title> the
// test waits on comes AFTER them, so `wmctl wait win ConsoleDone` cannot
// be satisfied until every call has run and flushed.
//
// What is asserted:
//   - each of the five console levels reaches the tty under its own name;
//   - a multi-line entry puts the prefix on BOTH lines, so one grep finds
//     all of a stack trace and no continuation line can pass for the
//     page's own output;
//   - one trailing newline does NOT become an empty extra line, while a
//     deliberately empty entry DOES keep its line (the core allows one);
//   - `2>FILE` really is the off-switch: the same page leaves the tty
//     clean and lands every line in the file instead.
//
// Uncaught exceptions are NOT asserted here.  Nothing in the tree emits
// BW_CS_SCRIPT_ERROR, so an exception reaches no console at all — that is
// todos/0424, and it is fixed at dukky's error sites, not in this seam.
//
// Run: node tests/kernel/test_netsurf_console_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage, section } = require('./lib/drive.js');

const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* Every console level, plus the two text shapes with their own branch in
 * gui.c: an entry carrying a newline, and an entry that is empty.  The
 * <title> is deliberately BELOW the script — it is the completion marker
 * for the wait, so it must not be reachable before the calls have run. */
const CONSOLE_PAGE = `<html>
<head>
<script>
console.log('CMARK-plain');
console.debug('CMARK-debug');
console.info('CMARK-info');
console.warn('CMARK-warn');
console.error('CMARK-error');
console.log('CMARK-first\\nCMARK-second');
console.log('CMARK-trailing\\n');
console.log('');
console.log('CMARK-args', 42);
</script>
<title>ConsoleDone</title>
</head>
<body style="margin: 0; background: #ffffff"><p>console</p></body>
</html>
`;

const { dir: tmp, image } = freshImage('os-nsconsole-');
driveBoot('true', { image });

{
  const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
  const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
  const rootStore = new COMMON.NodeFileStore(fs, image.slice(0, -4) + '-root.img', false);
  const rfs = BLOCK_FS.createV4(rootStore);
  const W = 0x40 | 0x200 | 1; /* O_CREAT|O_TRUNC|O_WRONLY */
  const bytes = Buffer.from(CONSOLE_PAGE, 'utf-8');
  const fd = rfs.open('/root/console.html', W, 0o644);
  rfs.write(fd, bytes, bytes.length);
  rfs.close(fd);
  rootStore.flush();
  rootStore.close();
}

const sidOf = (v, title) => `${v}=$(wmctl list | grep "\t${title}$" | sed "s/[^0-9].*//")`;

const out = driveBoot([
  /* --- the off-switch first, so its window is gone before the tty leg
   *     opens one: `2>FILE` must leave the tty completely clean --- */
  'echo ==redir',
  'netsurf /root/console.html 2>/root/js.log &',
  'wmctl wait win ConsoleDone 30000',
  sidOf('R', 'ConsoleDone'),
  'wmctl close $R && wmctl wait nowin ConsoleDone 8000 && echo redir-closed',
  'echo ==redirfile',
  'cat /root/js.log',

  /* --- the tty route: no redirection, the lines land on the shell's tty --- */
  'echo ==tty',
  'netsurf /root/console.html &',
  'wmctl wait win ConsoleDone 30000',
  sidOf('T', 'ConsoleDone'),
  'wmctl close $T && wmctl wait nowin ConsoleDone 8000 && echo tty-closed',
  'echo ==end',
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 }).stdout;

fs.rmSync(tmp, { recursive: true, force: true });

const redir = section(out, 'redir');
const redirFile = section(out, 'redirfile');
const tty = section(out, 'tty');

check('the redirected run finished', redir.includes('redir-closed'), JSON.stringify(redir));
check('the tty run finished', tty.includes('tty-closed'), JSON.stringify(tty));

/* --- the tty route, one level at a time --- */
const LEVELS = [
  ['log', 'CMARK-plain'],
  ['debug', 'CMARK-debug'],
  ['info', 'CMARK-info'],
  ['warn', 'CMARK-warn'],
  ['error', 'CMARK-error'],
];
for (const [level, marker] of LEVELS) {
  const line = `js: console: ${level}: ${marker}`;
  check(`console.${level} reaches the tty under its own level`, tty.includes(line), line);
}

/* --- extra arguments do not break the line --- */
check('an entry with several arguments still gets one prefixed line',
      tty.includes('js: console: log: CMARK-args'));

/* --- a multi-line entry prefixes EVERY line --- */
check('a newline in the text starts a new prefixed line, not a bare one',
      tty.includes('js: console: log: CMARK-first\n' +
                   'js: console: log: CMARK-second'),
      JSON.stringify(tty.slice(tty.indexOf('CMARK-first') - 40,
                               tty.indexOf('CMARK-first') + 80)));

/* --- the two empty-line branches, asserted together ---
 * The page logs exactly one deliberately empty entry, and one entry that
 * ends in a newline.  So the tty must carry EXACTLY ONE empty console
 * line: two would mean the trailing newline grew an extra line, none
 * would mean the empty entry was dropped. */
const empties = tty.split('js: console: log: \n').length - 1;
check('a trailing newline adds no empty line, and an empty entry keeps its line',
      empties === 1, `empty console lines on the tty: ${empties} (want 1)`);
check('the entry ending in a newline is one line',
      tty.split('js: console: log: CMARK-trailing').length - 1 === 1);

/* --- 2>FILE is the off-switch --- */
check('with stderr redirected the tty carries NO console line',
      !redir.includes('js: '), JSON.stringify(redir));
for (const [level, marker] of LEVELS) {
  const line = `js: console: ${level}: ${marker}`;
  check(`the redirected file carries console.${level}`, redirFile.includes(line), line);
}

console.log(failures === 0 ? 'PASS' : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
