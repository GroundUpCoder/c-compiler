#!/usr/bin/env node
// 0397 acceptance, headless: /bin/pbcopy and /bin/pbpaste — the macOS-named
// front-ends over the kernel's ONE clipboard slot, sharing os/clipio.h with
// the pre-existing /bin/clip (todos/0090). The point of the ticket is that
// all THREE programs are on the SAME slot, so the interop is asserted in
// both directions rather than assumed. Covers:
//   - pbcopy -> pbpaste round trip, cross-process (the writer has exited)
//   - interop: pbcopy -> clip -o, and clip -> pbpaste
//   - the empty slot: pbpaste exits 1 and prints NOTHING
//   - argv refusal: pbcopy ARG / pbpaste ARG exit 2 with a usage line
//   - the clip refactor is behavior-preserving: clip, clip -o, clip ARG=2
//   - chunking: ~170KB through the 64KB kernel page in both directions
//   - the recorded text-only limit: bytes at/past a NUL do not ride (with a
//     negative control proving the input really carried the NUL)
//   - GUI: pbcopy feeds notepad's WM_PASTE, and notepad's Copy feeds pbpaste
//
// Run: node tests/kernel/test_pbcopy_e2e.js
'use strict';
const fs = require('fs');
const { driveBoot, freshImage } = require('./lib/drive.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const { dir: tmp, image } = freshImage('os-pbcopy-');

function boot(script, timeout) {
  return driveBoot(script, { image, timeout, maxBuffer: 32 * 1024 * 1024 }).stdout;
}

function section(out, name) {
  return (out.split('==' + name + '\n')[1] || '').split('==')[0];
}

// Bounded condition poll (todos/0154 — not a fixed sync sleep): wait for a
// substring to land in the kernel clip slot. Deliberately reads through
// pbpaste, so the poll itself is a same-slot assertion.
const waitClipHas = (s) =>
  `for i in $(seq 1 120); do pbpaste 2>/dev/null | grep -q "${s}" && break; sleep 0.05; done`;

/* ---- session A: CLI semantics, three-way interop, limits ---- */
function sessionCli() {
  const out = boot([
    // round trip through the pair, writer already exited by the read
    'echo pb-round-trip | pbcopy',
    'echo ==rt',
    'pbpaste',
    'echo ==cut',
    // interop leg 1: pbcopy writes, the OLD clip reads
    'echo hi | pbcopy',
    'echo ==pb2clip',
    'clip -o',
    'echo ==cut',
    // interop leg 2: the OLD clip writes, pbpaste reads
    'echo hi | clip',
    'echo ==clip2pb',
    'pbpaste',
    'echo ==cut',
    // last write wins across the three names
    'echo second-write | clip',
    'echo ==overwrite',
    'pbpaste',
    'echo ==cut',
    // empty slot: exit 1, NOTHING printed
    'printf "" | pbcopy',
    'echo ==empty',
    'pbpaste > /tmp/pb.empty; echo rc=$?',
    'wc -c < /tmp/pb.empty',
    'echo ==cut',
    // clip -o keeps its own empty-slot contract after the refactor
    'echo ==clipempty',
    'clip -o; echo rc=$?',
    'echo ==cut',
    // argv refusal: usage to stderr, exit 2
    'echo ==pbcopyarg',
    'echo x | pbcopy -pboard find; echo rc=$?',
    'echo x | pbcopy -pboard find 2>&1 >/dev/null | head -n 1',
    'echo ==cut',
    'echo ==pbpastearg',
    'pbpaste -pboard find; echo rc=$?',
    'pbpaste -pboard find 2>&1 >/dev/null | head -n 1',
    'echo ==cut',
    // ...and the refused write did NOT touch the slot
    'echo ==untouched',
    'pbpaste',
    'echo ==cut',
    // clip's own argv contract is unchanged by the refactor
    'echo ==cliparg',
    'clip bogus; echo rc=$?',
    'echo ==cut',
    // ~170KB: multi-chunk CLIP_SET and CLIP_GET through the 64KB page
    'seq 1 30000 | pbcopy',
    'echo ==biglines',
    'pbpaste | wc -l',
    'echo ==bigtail',
    'pbpaste | tail -n 1',
    'echo ==cut',
    // no trailing newline is invented: the slot goes out byte for byte
    'printf abc | pbcopy',
    'echo ==nonewline',
    'pbpaste | wc -c',
    'echo ==cut',
    // the recorded text-only limit (clipio.h): a NUL ends the payload.
    // The first count is the NEGATIVE CONTROL — it proves the shell really
    // fed 3 bytes, so the 1 below is truncation and not a lost escape.
    'echo ==nulin',
    'printf "a\\000b" | wc -c',
    'echo ==nulout',
    'printf "a\\000b" | pbcopy',
    'pbpaste | wc -c',
    'echo ==done',
    '',
  ].join('\n'));

  check('pbcopy -> pbpaste round-trips across processes',
    section(out, 'rt') === 'pb-round-trip\n', JSON.stringify(section(out, 'rt')));
  check('interop: pbcopy writes, clip -o reads the SAME slot',
    section(out, 'pb2clip') === 'hi\n', JSON.stringify(section(out, 'pb2clip')));
  check('interop: clip writes, pbpaste reads the SAME slot',
    section(out, 'clip2pb') === 'hi\n', JSON.stringify(section(out, 'clip2pb')));
  check('last write wins across the three names',
    section(out, 'overwrite') === 'second-write\n', JSON.stringify(section(out, 'overwrite')));
  check('empty slot: pbpaste exits 1', section(out, 'empty').includes('rc=1'),
    JSON.stringify(section(out, 'empty')));
  check('empty slot: pbpaste prints nothing',
    section(out, 'empty').trim().split('\n').pop().trim() === '0',
    JSON.stringify(section(out, 'empty')));
  check('refactor: clip -o still exits 1 on an empty slot',
    section(out, 'clipempty').includes('rc=1'), JSON.stringify(section(out, 'clipempty')));
  check('pbcopy ARG exits 2', section(out, 'pbcopyarg').includes('rc=2'),
    JSON.stringify(section(out, 'pbcopyarg')));
  check('pbcopy ARG puts a usage line on stderr',
    /usage: cmd \| pbcopy/.test(section(out, 'pbcopyarg')),
    JSON.stringify(section(out, 'pbcopyarg')));
  check('pbpaste ARG exits 2', section(out, 'pbpastearg').includes('rc=2'),
    JSON.stringify(section(out, 'pbpastearg')));
  check('pbpaste ARG puts a usage line on stderr',
    /usage: pbpaste/.test(section(out, 'pbpastearg')),
    JSON.stringify(section(out, 'pbpastearg')));
  check('a refused pbcopy leaves the slot alone',
    section(out, 'untouched') === '', JSON.stringify(section(out, 'untouched')));
  check('refactor: clip ARG still exits 2', section(out, 'cliparg').includes('rc=2'),
    JSON.stringify(section(out, 'cliparg')));
  check('~170KB survives chunking (line count)',
    section(out, 'biglines').trim() === '30000', section(out, 'biglines').trim());
  check('~170KB survives chunking (last line intact)',
    section(out, 'bigtail').trim() === '30000', section(out, 'bigtail').trim());
  check('pbpaste adds no trailing newline',
    section(out, 'nonewline').trim() === '3', section(out, 'nonewline').trim());
  check('control: the shell fed 3 bytes including the NUL',
    section(out, 'nulin').trim() === '3', section(out, 'nulin').trim());
  check('recorded limit: bytes at/past a NUL do not ride',
    section(out, 'nulout').trim() === '1', section(out, 'nulout').trim());
}

/* ---- session B: the GUI is on the same slot ---- */
function sessionWin32() {
  const out = boot([
    'printf "from-pbcopy" | pbcopy',
    'notepad &',
    'wmctl wait label EDIT:0 12000',              // notepad up + serving
    'wmctl click Paste',
    'wmctl wait text EDIT:0 "from-pbcopy" 6000',
    'echo ==pasted',
    'wmctl gettext EDIT:0',
    'echo ==cut',
    // ...and the other direction: notepad Copy fills the slot pbpaste reads
    'wmctl settext EDIT:0 "COPIED-IN-NOTEPAD"',
    'wmctl click "Select All"',
    'wmctl click Copy',
    waitClipHas('COPIED-IN-NOTEPAD'),
    'echo ==copied',
    'pbpaste',
    'echo ==cut',
    // Exit at the end — a pasted doc is modified, so Exit may raise the save
    // prompt; nothing asserts past here and teardown reaps it.
    'wmctl click Exit',
    'echo ==done',
    '',
  ].join('\n'));

  check('pbcopy feeds notepad WM_PASTE (same slot as the win32 veneer)',
    section(out, 'pasted').trim() === 'from-pbcopy', JSON.stringify(section(out, 'pasted')));
  check('notepad Copy fills the slot pbpaste reads',
    section(out, 'copied') === 'COPIED-IN-NOTEPAD', JSON.stringify(section(out, 'copied')));
}

sessionCli();
sessionWin32();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\npbcopy/pbpaste e2e: ${failures} FAILED` : '\npbcopy/pbpaste e2e: PASS');
process.exit(failures ? 1 : 0);
