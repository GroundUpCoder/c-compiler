#!/usr/bin/env node
// Golden test runner for asm86.js
//
// For each test/*.asm file:
//   1. nasm -f bin <test>.asm -o <test>.golden.bin  (if --update or missing golden)
//   2. node asm86.js -f bin <test>.asm -o <test>.out.bin
//   3. cmp <test>.golden.bin <test>.out.bin
//
// Usage:
//   node test/run.js              # run all tests
//   node test/run.js --filter=add # run tests matching "add"
//   node test/run.js --update     # regenerate all golden files
//   node test/run.js -v           # verbose (show per-test PASS/FAIL)
//   node test/run.js --keep       # keep .out.bin files on success

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST_DIR = __dirname;
const ASM86 = path.join(ROOT, 'asm86.js');

// Find NASM: env var, PATH, or the known bundled copy.
function findNasm() {
  if (process.env.NASM) return process.env.NASM;

  // Try PATH
  try {
    const p = execSync('which nasm 2>/dev/null', { encoding: 'utf8' }).trim();
    if (p) return p;
  } catch (_) {}

  // Known bundled copy from the story repo
  const bundled = path.join(
    process.env.HOME, 'git/story/videos/011-color-a-pixel/tools/nasm-2.16.03/nasm'
  );
  if (fs.existsSync(bundled)) return bundled;

  console.error('NASM not found. Set NASM= env var or install nasm.');
  process.exit(1);
}

const NASM = findNasm();

function parseArgs(argv) {
  const args = { filter: '', update: false, verbose: false, keep: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update') args.update = true;
    else if (a === '-v' || a === '--verbose') args.verbose = true;
    else if (a === '--keep') args.keep = true;
    else if (a.startsWith('--filter=')) args.filter = a.slice('--filter='.length);
    else args.filter = a; // bare arg is a filter
  }
  return args;
}

function findTests() {
  const files = fs.readdirSync(TEST_DIR)
    .filter(f => f.endsWith('.asm'))
    .sort();
  return files.map(f => ({
    name: f.replace(/\.asm$/, ''),
    asm: path.join(TEST_DIR, f),
    golden: path.join(TEST_DIR, f.replace(/\.asm$/, '.golden.bin')),
    out: path.join(TEST_DIR, f.replace(/\.asm$/, '.out.bin')),
  }));
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function run(cmd, opts) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', ...opts });
    return { ok: true, stdout: out, stderr: '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || '', status: e.status };
  }
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hexdump(buf, maxLen) {
  const len = Math.min(buf.length, maxLen || Infinity);
  const parts = [];
  for (let i = 0; i < len; i++) {
    parts.push(buf[i].toString(16).padStart(2, '0'));
  }
  if (buf.length > len) parts.push('...');
  return parts.join(' ');
}

async function main() {
  const args = parseArgs(process.argv);
  const allTests = findTests();
  const tests = args.filter
    ? allTests.filter(t => t.name.includes(args.filter))
    : allTests;

  if (!tests.length) {
    console.log('No tests found.');
    process.exit(args.filter ? 1 : 0);
  }

  console.log(`NASM: ${NASM}`);
  console.log(`asm86: ${ASM86}`);
  console.log(`Tests: ${tests.length}${args.filter ? ` (filter: ${args.filter})` : ''}\n`);

  let passed = 0, failed = 0, skipped = 0;
  const failures = [];

  for (const test of tests) {
    // Step 1: generate / update golden file
    if (args.update || !fs.existsSync(test.golden)) {
      const r = run(`${NASM} -f bin "${test.asm}" -o "${test.golden}"`);
      if (!r.ok) {
        console.log(`  GOLDEN ${test.name}: FAILED to generate\n${r.stderr.trim()}`);
        skipped++;
        continue;
      }
    }

    const golden = fs.readFileSync(test.golden);

    // Step 2: run asm86.js
    const asmResult = run(`node "${ASM86}" -f bin "${test.asm}" -o "${test.out}"`);
    if (!asmResult.ok) {
      console.log(`  FAIL ${test.name}: asm86.js exited ${asmResult.status}`);
      const stripped = stripAnsi(asmResult.stderr).trim();
      if (stripped) console.log(`  stderr: ${stripped}`);
      failed++;
      failures.push({ name: test.name, reason: 'asm86.js exited non-zero', detail: stripped });
      continue;
    }

    // Step 3: compare
    let asmOut;
    try {
      asmOut = fs.readFileSync(test.out);
    } catch (_) {
      console.log(`  FAIL ${test.name}: asm86.js did not produce output`);
      failed++;
      failures.push({ name: test.name, reason: 'no output file' });
      continue;
    }

    if (bytesEqual(golden, asmOut)) {
      if (args.verbose) console.log(`  PASS ${test.name} (${asmOut.length} bytes)`);
      else process.stdout.write('.');
      passed++;
      if (!args.keep) {
        try { fs.unlinkSync(test.out); } catch (_) {}
      }
    } else {
      console.log(`\n  FAIL ${test.name}: output differs (golden=${golden.length} asm86=${asmOut.length})`);
      if (golden.length <= 64 && asmOut.length <= 64) {
        console.log(`    golden: ${hexdump(golden)}`);
        console.log(`    asm86:  ${hexdump(asmOut)}`);
      } else {
        // Find first differing byte
        const maxLen = Math.max(golden.length, asmOut.length);
        let firstDiff = -1;
        for (let i = 0; i < maxLen; i++) {
          if (golden[i] !== asmOut[i]) { firstDiff = i; break; }
        }
        if (firstDiff >= 0) {
          const ctx = 16;
          const start = Math.max(0, firstDiff - ctx);
          const end = Math.min(maxLen, firstDiff + ctx);
          console.log(`    first diff at byte ${firstDiff}:`);
          console.log(`    golden[${start}..${end}]: ${hexdump(golden.slice(start, end))}`);
          console.log(`    asm86 [${start}..${end}]: ${hexdump(asmOut.slice(start, end), 0)}`);
        }
      }
      failed++;
      failures.push({ name: test.name, reason: 'output differs', detail: `golden=${golden.length} asm86=${asmOut.length}` });
    }
  }

  // Summary
  console.log(`\n\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  ${f.name}: ${f.reason}`);
      if (f.detail) console.log(`    ${f.detail}`);
    }
    process.exit(1);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
