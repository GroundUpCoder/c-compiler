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
// The console entries are read off the boot's STDERR, not its stdout.
// The headless twin splits the tty by descriptor — os/boot.js `onOutput`
// sends fd 2 to the host's stderr and everything else to its stdout — so
// stderr IS the tty here, and a console entry landing on stdout would be
// a bug.  The section markers are therefore echoed to both streams.
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
// Uncaught exceptions ARE asserted here since ticket #177 (todos/0424):
// dukky's error sites route them through dukky_report_exception →
// browser_window_console_log(BW_CS_SCRIPT_ERROR), so a thrown click
// listener prints `js: exception: error: ...` on the tty.  The leg
// carries its own control — the same listener RESTYLES a div BEFORE
// throwing, and the repaint is polled off wmctl shots (the
// test_netsurf_pointer_e2e.js pattern) — so an absent exception line can
// never be blamed on a lost click.  (NOT a retitle: document.title's
// setter updates the DOM only; nothing propagates a dynamic title to the
// window, so a title wait is an unreachable condition.)  The no-throw
// console page doubles as the negative control: its tty section must
// carry no `js: exception:` line at all.
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

/* The exception page (#177): the click listener restyles FIRST (the
 * control — the repaint is polled off wmctl shots, the pointer-test
 * pattern) and throws SECOND, so the control is independent of the
 * feature under test. */
const EXC_PAGE = `<html>
<head>
<style>
body { margin: 0; background: #ffffff; }
#ran { width: 300px; height: 120px; background: #dddddd; }
#ran.hit { background: rgb(18, 52, 86); }
</style>
<script>
document.addEventListener('click', function (e) {
  document.getElementById('ran').className = 'hit';
  throw new Error('EMARK-boom');
});
</script>
<title>ExcReady</title>
</head>
<body><div id="ran"></div></body>
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
  for (const [p, text] of [['/root/console.html', CONSOLE_PAGE],
                           ['/root/exc.html', EXC_PAGE]]) {
    const bytes = Buffer.from(text, 'utf-8');
    const fd = rfs.open(p, W, 0o644);
    rfs.write(fd, bytes, bytes.length);
    rfs.close(fd);
  }
  rootStore.flush();
  rootStore.close();
}

const sidOf = (v, title) => `${v}=$(wmctl list | grep "\t${title}$" | sed "s/[^0-9].*//")`;

/* Shot polling, the test_netsurf_pointer_e2e.js helpers verbatim: settle
 * until two consecutive frames match, then detect the click's repaint as
 * a frame that differs from the settled reference. */
const pollStable = (sid, out) => [
  `wmctl shot ${sid} ${out}`,
  `for i in $(seq 1 100); do sleep 0.1; wmctl shot ${sid} /root/poll.ppm; ` +
  `cmp -s /root/poll.ppm ${out} && break; cp /root/poll.ppm ${out}; done`,
];
const pollChange = (sid, ref) => [
  `for i in $(seq 1 100); do wmctl shot ${sid} /root/poll.ppm; ` +
  `cmp -s /root/poll.ppm ${ref} || break; sleep 0.1; done`,
];

/* the same marker on both streams, so each can be cut into sections */
const mark = (name) => `echo ==${name}; echo ==${name} >&2`;

const run = driveBoot([
  /* --- the off-switch first, so its window is gone before the tty leg
   *     opens one: `2>FILE` must leave the tty completely clean --- */
  mark('redir'),
  'netsurf /root/console.html 2>/root/js.log &',
  'wmctl wait win ConsoleDone 30000',
  sidOf('R', 'ConsoleDone'),
  'wmctl close $R && wmctl wait nowin ConsoleDone 8000 && echo redir-closed',
  mark('redirfile'),
  'cat /root/js.log',

  /* --- the tty route: no redirection, the lines land on the shell's tty --- */
  mark('tty'),
  'netsurf /root/console.html &',
  'wmctl wait win ConsoleDone 30000',
  sidOf('T', 'ConsoleDone'),
  'wmctl close $T && wmctl wait nowin ConsoleDone 8000 && echo tty-closed',

  /* --- the uncaught-exception route (#177): click → restyle control →
   *     the exception line on the tty --- */
  mark('exc'),
  'netsurf /root/exc.html &',
  'wmctl wait win ExcReady 30000',
  sidOf('E', 'ExcReady'),
  ...pollStable('$E', '/root/e0.ppm'),
  'echo exc-settled',
  'wmctl click $E 100 50',
  ...pollChange('$E', '/root/e0.ppm'),
  'cmp -s /root/poll.ppm /root/e0.ppm || echo exc-restyled',
  'wmctl close $E && wmctl wait nowin ExcReady 8000 && echo exc-closed',
  mark('end'),
], { image, timeout: 420000, maxBuffer: 64 * 1024 * 1024 });
const out = run.stdout;
const err = String(run.stderr);

fs.rmSync(tmp, { recursive: true, force: true });

const redirFile = section(out, 'redirfile');
const tty = section(err, 'tty');

check('the redirected run finished', section(out, 'redir').includes('redir-closed'),
      JSON.stringify(section(out, 'redir')));
check('the tty run finished', section(out, 'tty').includes('tty-closed'),
      JSON.stringify(section(out, 'tty')));

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

/* --- no console entry may leak onto stdout: it is a diagnostic stream,
 *     and a page must not be able to corrupt a piped `netsurf` --- */
check('no console entry reaches stdout',
      !section(out, 'tty').includes('js: console: '),
      JSON.stringify(section(out, 'tty')));

/* --- 2>FILE is the off-switch --- */
check('with stderr redirected the tty carries NO console line',
      !section(err, 'redir').includes('js: '), JSON.stringify(section(err, 'redir')));
for (const [level, marker] of LEVELS) {
  const line = `js: console: ${level}: ${marker}`;
  check(`the redirected file carries console.${level}`, redirFile.includes(line), line);
}

/* --- the uncaught-exception route (#177) --- */
const excOut = section(out, 'exc');
const excErr = section(err, 'exc');
check('the exception page settled before the click', excOut.includes('exc-settled'));
check('the exception leg CONTROL fired (the same listener repainted the div)',
      excOut.includes('exc-restyled'), JSON.stringify(excOut));
check('the exception window closed', excOut.includes('exc-closed'));
check('the uncaught exception reaches the tty as js: exception: error:',
      excErr.includes('js: exception: error: Error: EMARK-boom'),
      JSON.stringify(excErr));
/* Negative control: the console page throws nothing, so its tty section
 * must carry no exception line — the emission is caused by the throw,
 * not by page traffic in general. */
check('the no-throw page produces NO exception line',
      !tty.includes('js: exception:'), JSON.stringify(tty.slice(0, 400)));

console.log(failures === 0 ? 'PASS' : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
