#!/usr/bin/env node
// Side-by-side compatibility runner for --backend=guc.
//
// For each test case, compile + run with both backends and check the
// output matches. Designed for fast iteration during the migration —
// tests are inline C programs, no scaffolding files.
//
// Run: node tests/guc-compat.js [filter]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const COMPILER = path.join(ROOT, 'compiler.js');
const HOST = path.join(ROOT, 'host.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gucc-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

let pass = 0, fail = 0, skip = 0;
const failures = [];

function compileWith(srcPath, wasmPath, backend) {
  const args = [COMPILER, srcPath, '-o', wasmPath];
  if (backend === 'guc') args.push('--backend=guc');
  const r = spawnSync('node', args, { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function runWasm(wasmPath) {
  const r = spawnSync('node', [HOST, wasmPath], { encoding: 'utf8', timeout: 5000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function runTest(name, src, expectedStdout, expectedExit) {
  expectedStdout = expectedStdout ?? '';
  expectedExit = expectedExit ?? 0;
  const srcPath = path.join(TMP, `${name}.c`);
  fs.writeFileSync(srcPath, src);

  // Build with both backends.
  const defaultWasm = path.join(TMP, `${name}-default.wasm`);
  const gucWasm = path.join(TMP, `${name}-guc.wasm`);
  const dc = compileWith(srcPath, defaultWasm, 'default');
  const gc = compileWith(srcPath, gucWasm, 'guc');

  const fmt = (label, what) => `${label}: ${what.split('\n').slice(0, 4).join('\n  ')}`;

  if (dc.code !== 0) {
    fail++;
    failures.push(`${name}: default backend FAILED to compile\n  ${fmt('stderr', dc.stderr)}`);
    return;
  }
  if (gc.code !== 0) {
    fail++;
    failures.push(`${name}: guc backend FAILED to compile\n  ${fmt('stderr', gc.stderr)}`);
    return;
  }

  // Run both.
  const dr = runWasm(defaultWasm);
  const gr = runWasm(gucWasm);

  if (dr.stdout !== expectedStdout || dr.code !== expectedExit) {
    fail++;
    failures.push(`${name}: default backend output mismatch\n  expected exit=${expectedExit} stdout=${JSON.stringify(expectedStdout)}\n  got      exit=${dr.code} stdout=${JSON.stringify(dr.stdout)}`);
    return;
  }
  if (gr.stdout !== expectedStdout || gr.code !== expectedExit) {
    fail++;
    failures.push(`${name}: guc backend output mismatch\n  expected exit=${expectedExit} stdout=${JSON.stringify(expectedStdout)}\n  got      exit=${gr.code} stdout=${JSON.stringify(gr.stdout)}\n  guc compile stderr: ${gc.stderr}`);
    return;
  }

  pass++;
  console.log(`  ok   ${name}`);
}

// =========== test cases ===========

const filter = process.argv[2];
const T = (name, ...rest) => {
  if (filter && !name.includes(filter)) { skip++; return; }
  runTest(name, ...rest);
};

T('return-int-literal',
  'int main(void) { return 42; }',
  '', 42);

T('return-zero',
  'int main(void) { return 0; }',
  '', 0);

T('return-signed-negative',
  'int main(void) { return -1; }',
  '', 255);  // exit code wraps to unsigned 8-bit

T('binary-add',
  'int main(void) { return 1 + 2; }',
  '', 3);

T('binary-sub-mul',
  'int main(void) { return 5 * 6 - 8; }',
  '', 22);

T('binary-div',
  'int main(void) { return 100 / 4; }',
  '', 25);

T('binary-mod',
  'int main(void) { return 17 % 5; }',
  '', 2);

T('binary-bitops',
  'int main(void) { return (0xF0 | 0x0F) & 0xFF; }',
  '', 255);

T('binary-shifts',
  'int main(void) { return (1 << 5) >> 2; }',
  '', 8);

T('binary-cmp-eq-true',
  'int main(void) { return 5 == 5; }',
  '', 1);

T('binary-cmp-eq-false',
  'int main(void) { return 5 == 6; }',
  '', 0);

T('binary-cmp-lt',
  'int main(void) { return 3 < 5; }',
  '', 1);

T('logical-and-true',
  'int main(void) { return 5 && 7; }',
  '', 1);

T('logical-and-false',
  'int main(void) { return 5 && 0; }',
  '', 0);

T('logical-or',
  'int main(void) { return 0 || 42; }',
  '', 1);

T('unary-neg',
  'int main(void) { return -7 + 10; }',
  '', 3);

T('unary-bnot',
  'int main(void) { return ~0; }',
  '', 255); // exit wraps -1 to 255

T('unary-lnot-true',
  'int main(void) { return !0; }',
  '', 1);

T('unary-lnot-false',
  'int main(void) { return !42; }',
  '', 0);

T('unsigned-div',
  'unsigned int u(unsigned int a, unsigned int b){ return a/b; } '
  + 'int main(void){ return (int)u(100u, 7u); }',
  '', 14);

// Parameters and locals
T('param-passthrough',
  'int f(int x) { return x; } int main(void) { return f(7); }',
  '', 7);

T('two-params',
  'int add(int a, int b) { return a + b; } int main(void) { return add(20, 22); }',
  '', 42);

T('local-decl-init',
  'int main(void) { int x = 10; int y = 20; return x + y; }',
  '', 30);

T('local-no-init',
  'int main(void) { int x; x = 17; return x; }',
  '', 17);

T('compound-assign',
  'int main(void) { int x = 5; x += 3; x *= 2; return x; }',
  '', 16);

T('chained-assign',
  'int main(void) { int a; int b; int c; a = b = c = 7; return a + b + c; }',
  '', 21);

T('long-long-arith',
  'int main(void) { long long x = 1000000000LL; long long y = x * 3; return (int)(y / 100000000); }',
  '', 30);

T('cast-i64-to-i32',
  'int main(void) { long long x = 0x100000007LL; return (int)x; }',
  '', 7);

T('cast-i32-to-i64',
  'int main(void) { int x = 42; long long y = (long long)x; return (int)y; }',
  '', 42);

// Control flow
T('if-then',
  'int main(void) { int x = 0; if (1) x = 7; return x; }',
  '', 7);

T('if-else',
  'int main(void) { int x; if (0) x = 1; else x = 2; return x; }',
  '', 2);

T('if-nested',
  'int sgn(int x){ if (x > 0) return 1; else if (x < 0) return -1; else return 0; } '
  + 'int main(void){ return sgn(-42) + 10; }',
  '', 9);

T('while-loop',
  'int main(void) { int n = 5; int s = 0; while (n > 0) { s = s + n; n = n - 1; } return s; }',
  '', 15);

T('do-while-loop',
  'int main(void) { int i = 0; int s = 0; do { s += i; i += 1; } while (i < 5); return s; }',
  '', 10);

T('for-loop',
  'int main(void) { int s = 0; for (int i = 0; i < 5; i += 1) s += i; return s; }',
  '', 10);

T('for-no-init-no-inc',
  'int main(void) { int i = 0; int s = 0; for (; i < 4;) { s += i; i += 1; } return s; }',
  '', 6);

T('break',
  'int main(void) { int n = 0; while (1) { if (n == 7) break; n = n + 1; } return n; }',
  '', 7);

T('continue',
  'int main(void) { int s = 0; for (int i = 0; i < 10; i += 1) { if (i == 5) continue; s += 1; } return s; }',
  '', 9);

T('nested-loops',
  'int main(void) { int s = 0; for (int i = 0; i < 3; i += 1) for (int j = 0; j < 3; j += 1) s += 1; return s; }',
  '', 9);

T('break-only-inner',
  'int main(void) { int s = 0; '
  + 'for (int i = 0; i < 3; i += 1) for (int j = 0; j < 5; j += 1) { if (j == 2) break; s += 1; } '
  + 'return s; }',
  '', 6);

// ===== Phase B: linear-memory aggregates =====
T('local-array-write-read',
  'int main(void) { int a[5]; a[0] = 7; a[1] = 9; return a[0] + a[1]; }',
  '', 16);

T('local-array-loop',
  'int main(void) { int a[10]; for (int i = 0; i < 10; i += 1) a[i] = i * i; '
  + 'int s = 0; for (int i = 0; i < 10; i += 1) s += a[i]; return s % 100; }',
  '', 85);  // sum of 0..81 = 285, mod 100 = 85

T('addr-of-scalar',
  'int set5(int *p) { *p = 5; return 0; } '
  + 'int main(void) { int x = 1; set5(&x); return x; }',
  '', 5);

T('pointer-deref',
  'int read(int *p) { return *p; } '
  + 'int main(void) { int x = 42; return read(&x); }',
  '', 42);

T('pointer-arith',
  'int main(void) { int a[3]; a[0] = 1; a[1] = 2; a[2] = 4; '
  + 'int *p = a; return *(p + 1) + *(p + 2); }',
  '', 6);

T('struct-basic',
  'struct P { int x; int y; }; '
  + 'int main(void) { struct P p; p.x = 3; p.y = 4; return p.x + p.y; }',
  '', 7);

T('struct-via-pointer',
  'struct P { int x; int y; }; '
  + 'int sum(struct P *p) { return p->x + p->y; } '
  + 'int main(void) { struct P p; p.x = 10; p.y = 32; return sum(&p); }',
  '', 42);

T('char-array',
  'int main(void) { char a[4]; a[0] = 65; a[1] = 66; a[2] = 67; a[3] = 0; '
  + 'return a[0] + a[1] + a[2]; }',
  '', 198);  // 65+66+67

// ===== Phase C: goto =====
T('goto-forward',
  'int main(void) { int x = 0; goto skip; x = 99; skip: return x; }',
  '', 0);

T('goto-backward',
  'int main(void) { int n = 0; '
  + 'loop: n = n + 1; if (n < 5) goto loop; return n; }',
  '', 5);

T('goto-skip-block',
  'int main(void) { int s = 0; '
  + 'for (int i = 0; i < 10; i += 1) { if (i == 3) goto done; s = s + i; } '
  + 'done: return s; }',
  '', 3); // 0+1+2 = 3

// ===== Increment/decrement =====
T('inc-pre',
  'int main(void) { int x = 5; ++x; return x; }',
  '', 6);

T('inc-post',
  'int main(void) { int x = 5; int y = x++; return x + y; }',
  '', 11);

T('dec-pre',
  'int main(void) { int x = 5; --x; return x; }',
  '', 4);

T('dec-post',
  'int main(void) { int x = 5; int y = x--; return x + y; }',
  '', 9);

T('inc-in-loop',
  'int main(void) { int s = 0; for (int i = 0; i < 5; ++i) s += i; return s; }',
  '', 10);

T('inc-pointer',
  'int main(void) { int a[3]; a[0] = 1; a[1] = 2; a[2] = 4; '
  + 'int *p = a; ++p; return *p + *(p + 1); }',
  '', 6);

// ===== Switch =====
T('switch-basic',
  'int f(int x) { switch (x) { case 1: return 10; case 2: return 20; case 3: return 30; default: return -1; } } '
  + 'int main(void) { return f(2); }',
  '', 20);

T('switch-default',
  'int f(int x) { switch (x) { case 1: return 1; default: return 99; } } '
  + 'int main(void) { return f(42); }',
  '', 99);

T('switch-break',
  'int main(void) { int s = 0; '
  + 'for (int i = 0; i < 5; ++i) switch (i) { case 0: case 2: case 4: s += 1; break; default: s += 10; } '
  + 'return s; }',
  '', 23);  // 1 + 10 + 1 + 10 + 1

T('switch-fallthrough',
  'int main(void) { int x = 1; int s = 0; '
  + 'switch (x) { case 1: s += 1; case 2: s += 2; case 3: s += 3; break; case 4: s += 4; } '
  + 'return s; }',
  '', 6); // 1 falls through 2, then 3, then break: 1+2+3=6

// =========== summary ===========

console.log(`\n${pass}/${pass + fail} passed${skip ? `, ${skip} skipped` : ''}${fail ? `, ${fail} failed` : ''}`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
