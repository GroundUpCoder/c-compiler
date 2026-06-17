#!/usr/bin/env node
// End-to-end test: compile real C programs that do file I/O, run them
// against BlockFS on MemoryByteStore in Node.js.
'use strict';

var compiler = require('../../compiler.js');
var host = require('../../host.js');
var runModule = host;
var BLOCK_FS = host.BLOCK_FS;
var MemoryByteStore = BLOCK_FS.MemoryByteStore;

var fs = require('fs');
var path = require('path');

var passed = 0;
var failed = 0;

 async function test(name, fn) {
   try {
     var result = fn();
     if (result && typeof result.then === 'function') await result;
     passed++;
     console.log('  PASS: ' + name);
   } catch (e) {
     failed++;
     console.error('  FAIL: ' + name);
     console.error('    ' + (e.stack || e.message));
   }
 }

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'assertEq') + ': ' + a + ' !== ' + b);
}

// -------------------------------------------------------------------
// Compile via the CLI (reliable), run through BlockFS, return output.
// -------------------------------------------------------------------

var childProcess = require('child_process');
var COMPILER_JS = path.join(__dirname, '..', '..', 'compiler.js');
var _testCounter = 0;

function compileAndRun(cSource, opts) {
  opts = opts || {};
  var id = ++_testCounter;
  var tmpDir = '/tmp/blockfs_e2e_' + process.pid + '_' + id;
  fs.mkdirSync(tmpDir, { recursive: true });
  var cFile = path.join(tmpDir, 'main.c');
  var wasmFile = path.join(tmpDir, 'main.wasm');
  fs.writeFileSync(cFile, cSource);

  // Compile via CLI (handles stdlib headers, linking, etc. correctly)
  var compileResult = childProcess.spawnSync('node', [COMPILER_JS, '-o', wasmFile, cFile], {
    encoding: 'utf-8',
    timeout: 30000
  });
  if (compileResult.status !== 0) {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
    throw new Error('compile failed (exit ' + compileResult.status + '):\n' +
      (compileResult.stderr || compileResult.stdout || ''));
  }
  var wasmBinary = fs.readFileSync(wasmFile);
  assert(wasmBinary.length > 0, 'WASM binary is empty');

  // Run with BlockFS
  var store = new MemoryByteStore(opts.storeSize || (2 * 1024 * 1024));
  var blockFS = BLOCK_FS.create(store);
  var stdoutParts = [];
  var stderrParts = [];

  return runModule({
    bytes: wasmBinary,
    args: [path.basename(cFile)].concat(opts.args || []),
    blockFsFactory: async function (ctx) {
      return { c: blockFS.toWasmEnv(ctx) };
    },
    writeOut: function (buf) { stdoutParts.push(buf instanceof Uint8Array ? new TextDecoder().decode(buf) : String(buf)); },
    writeErr: function (buf) { stderrParts.push(buf instanceof Uint8Array ? new TextDecoder().decode(buf) : String(buf)); },
    fs: undefined,
  }).then(function (exitCode) {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
    return {
      exitCode: exitCode,
      stdout: stdoutParts.join(''),
      stderr: stderrParts.join(''),
      store: store,
      blockFS: blockFS
    };
  });
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

async function runTests() {

  // ---- Basic file write + read ----
  await test('C: fopen / fwrite / fclose / fopen / fread', async function () {
    var result = await compileAndRun(
      '#include <stdio.h>\n' +
      'int main() {\n' +
      '  FILE *f = fopen("/test.txt", "w");\n' +
      '  if (!f) { fprintf(stderr, "fopen write failed\\n"); return 1; }\n' +
      '  fwrite("hello from C", 1, 13, f);\n' +
      '  fclose(f);\n' +
      '  f = fopen("/test.txt", "r");\n' +
      '  if (!f) { fprintf(stderr, "fopen read failed\\n"); return 2; }\n' +
      '  char buf[20] = {0};\n' +
      '  int n = fread(buf, 1, 20, f);\n' +
      '  fclose(f);\n' +
      '  printf("%.*s", n, buf);\n' +
      '  return 0;\n' +
      '}'
    );
    assertEq(result.exitCode, 0, 'exit code');
    assertEq(result.stdout, 'hello from C', 'stdout');
  });

  // ---- Multiple files ----
  await test('C: multiple files', async function () {
    var result = await compileAndRun(
      '#include <stdio.h>\n' +
      'int main() {\n' +
      '  FILE *a = fopen("/a.txt", "w");\n' +
      '  FILE *b = fopen("/b.txt", "w");\n' +
      '  fwrite("aaa", 1, 3, a);\n' +
      '  fwrite("bbb", 1, 3, b);\n' +
      '  fclose(a); fclose(b);\n' +
      '  a = fopen("/a.txt", "r");\n' +
      '  b = fopen("/b.txt", "r");\n' +
      '  char ba[10]={0}, bb[10]={0};\n' +
      '  fread(ba, 1, 3, a);\n' +
      '  fread(bb, 1, 3, b);\n' +
      '  fclose(a); fclose(b);\n' +
      '  printf("%s %s", ba, bb);\n' +
      '  return 0;\n' +
      '}'
    );
    assertEq(result.exitCode, 0, 'exit code');
    assertEq(result.stdout, 'aaa bbb', 'stdout');
  });

  // ---- mkdir / rmdir via system() or stat ----
  await test('C: stat on file', async function () {
    var result = await compileAndRun(
      '#include <stdio.h>\n' +
      '#include <sys/stat.h>\n' +
      'int main() {\n' +
      '  FILE *f = fopen("/s.txt", "w");\n' +
      '  fwrite("12345678", 1, 8, f);\n' +
      '  fclose(f);\n' +
      '  struct stat st;\n' +
      '  if (stat("/s.txt", &st) != 0) { fprintf(stderr, "stat failed\\n"); return 1; }\n' +
      '  printf("size=%ld mode=0%o", (long)st.st_size, st.st_mode & 07777);\n' +
      '  return 0;\n' +
      '}'
    );
    assertEq(result.exitCode, 0, 'exit code');
    // size should be 8, mode should be 644 (S_IFREG | 0644)
    assert(result.stdout.indexOf('size=8') >= 0, 'stdout has size=8: ' + result.stdout);
    assert(result.stdout.indexOf('mode=0644') >= 0, 'stdout has mode=0644: ' + result.stdout);
  });

  // ---- lseek / ftell ----
  await test('C: fseek / ftell', async function () {
    var result = await compileAndRun(
      '#include <stdio.h>\n' +
      'int main() {\n' +
      '  FILE *f = fopen("/seek.txt", "w+");\n' +
      '  fwrite("ABCDEFGHIJ", 1, 10, f);\n' +
      '  fseek(f, 3, SEEK_SET);\n' +
      '  long pos = ftell(f);\n' +
      '  printf("pos=%ld", pos);\n' +
      '  fclose(f);\n' +
      '  return 0;\n' +
      '}'
    );
    assertEq(result.exitCode, 0, 'exit code');
    assertEq(result.stdout, 'pos=3', 'stdout');
  });

  // ---- rename ----
  await test('C: rename via stdio', async function () {
    var result = await compileAndRun(
      '#include <stdio.h>\n' +
      'int main() {\n' +
      '  FILE *f = fopen("/old.txt", "w");\n' +
      '  fwrite("renamed", 1, 7, f);\n' +
      '  fclose(f);\n' +
      '  if (rename("/old.txt", "/new.txt") != 0) { fprintf(stderr, "rename failed\\n"); return 1; }\n' +
      '  f = fopen("/old.txt", "r");\n' +
      '  if (f) { fprintf(stderr, "old should not exist\\n"); return 2; }\n' +
      '  f = fopen("/new.txt", "r");\n' +
      '  if (!f) { fprintf(stderr, "new should exist\\n"); return 3; }\n' +
      '  char buf[10]={0};\n' +
      '  fread(buf, 1, 7, f);\n' +
      '  fclose(f);\n' +
      '  printf("%s", buf);\n' +
      '  return 0;\n' +
      '}'
    );
    assertEq(result.exitCode, 0, 'exit code');
    assertEq(result.stdout, 'renamed', 'stdout');
  });

  // ---- opendir / readdir / closedir via dirent.h ----
  await test('C: opendir / readdir', async function () {
    var result = await compileAndRun(
      '#include <stdio.h>\n' +
      '#include <dirent.h>\n' +
      'int main() {\n' +
      '  FILE *f;\n' +
      '  f = fopen("/x.txt", "w"); fclose(f);\n' +
      '  f = fopen("/y.txt", "w"); fclose(f);\n' +
      '  f = fopen("/z.txt", "w"); fclose(f);\n' +
      '  DIR *d = opendir("/");\n' +
      '  if (!d) { fprintf(stderr, "opendir failed\\n"); return 1; }\n' +
      '  int count = 0;\n' +
      '  struct dirent *e;\n' +
      '  while ((e = readdir(d)) != NULL) {\n' +
      '    if (e->d_name[0] != \'.\') count++;\n' +
      '  }\n' +
      '  closedir(d);\n' +
      '  printf("%d files", count);\n' +
      '  return 0;\n' +
      '}'
    );
    assertEq(result.exitCode, 0, 'exit code');
    assertEq(result.stdout, '3 files', 'stdout');
  });

  // ---- stdout / stderr ----
  await test('C: stdout and stderr', async function () {
    var result = await compileAndRun(
      '#include <stdio.h>\n' +
      'int main() {\n' +
      '  printf("out1");\n' +
      '  fprintf(stderr, "err1");\n' +
      '  printf("out2");\n' +
      '  return 42;\n' +
      '}'
    );
    assertEq(result.exitCode, 42, 'exit code');
    assertEq(result.stdout, 'out1out2', 'stdout');
    assertEq(result.stderr, 'err1', 'stderr');
  });

  // ---- Large append (tests extent growth) ----
  await test('C: large append (128KB)', async function () {
    var result = await compileAndRun(
      '#include <stdio.h>\n' +
      '#include <string.h>\n' +
      'int main() {\n' +
      '  FILE *f = fopen("/big.txt", "w");\n' +
      '  if (!f) { fprintf(stderr, "fopen failed\\n"); return 1; }\n' +
      '  char buf[1024];\n' +
      '  memset(buf, \'A\', 1024);\n' +
      '  for (int i = 0; i < 128; i++) {\n' +
      '    if (fwrite(buf, 1, 1024, f) != 1024) {\n' +
      '      fprintf(stderr, "fwrite failed at iter %d\\n", i);\n' +
      '      return 2;\n' +
      '    }\n' +
      '  }\n' +
      '  fclose(f);\n' +
      '\n' +
      '  f = fopen("/big.txt", "r");\n' +
      '  if (!f) { fprintf(stderr, "fopen read failed\\n"); return 3; }\n' +
      '  int total = 0; int n;\n' +
      '  while ((n = fread(buf, 1, 1024, f)) > 0) total += n;\n' +
      '  fclose(f);\n' +
      '  printf("total=%d", total);\n' +
      '  return 0;\n' +
      '}'
    );
    assertEq(result.exitCode, 0, 'exit code: ' + result.stderr);
    assert(result.stdout.indexOf('total=131072') >= 0, 'stdout: ' + result.stdout);
  });

  // ---- chdir / getcwd ----
  await test('C: chdir and getcwd', async function () {
    var result = await compileAndRun(
      '#include <stdio.h>\n' +
      '#include <unistd.h>\n' +
      '#include <sys/stat.h>\n' +
      'int main() {\n' +
      '  if (mkdir("/sub", 0755) != 0) { fprintf(stderr, "mkdir failed\\n"); return 1; }\n' +
      '  if (chdir("/sub") != 0) { fprintf(stderr, "chdir failed\\n"); return 2; }\n' +
      '  char cwd[256];\n' +
      '  if (!getcwd(cwd, sizeof(cwd))) { fprintf(stderr, "getcwd failed\\n"); return 3; }\n' +
      '  printf("%s", cwd);\n' +
      '  return 0;\n' +
      '}'
    );
    assertEq(result.exitCode, 0, 'exit code: ' + result.stderr);
    assertEq(result.stdout, '/sub', 'stdout');
  });

  // ---- Large file data integrity ----
  await test('C: write pattern and verify (256KB)', async function () {
    var result = await compileAndRun(
      '#include <stdio.h>\n' +
      'int main() {\n' +
      '  FILE *f = fopen("/pat.dat", "w");\n' +
      '  if (!f) { fprintf(stderr, "fopen write failed\\n"); return 1; }\n' +
      '  /* Write 256KB where byte i == i mod 256 */\n' +
      '  for (int i = 0; i < 256 * 1024; i++) {\n' +
      '    unsigned char c = (unsigned char)(i & 0xFF);\n' +
      '    if (fwrite(&c, 1, 1, f) != 1) {\n' +
      '      fprintf(stderr, "write failed at %d\\n", i); return 2;\n' +
      '    }\n' +
      '  }\n' +
      '  fclose(f);\n' +
      '\n' +
      '  f = fopen("/pat.dat", "r");\n' +
      '  if (!f) { fprintf(stderr, "fopen read failed\\n"); return 3; }\n' +
      '  int errors = 0;\n' +
      '  for (int i = 0; i < 256 * 1024; i++) {\n' +
      '    unsigned char c;\n' +
      '    if (fread(&c, 1, 1, f) != 1) { fprintf(stderr, "read failed at %d\\n", i); return 4; }\n' +
      '    if (c != (unsigned char)(i & 0xFF)) errors++;\n' +
      '  }\n' +
      '  fclose(f);\n' +
      '  printf("errors=%d", errors);\n' +
      '  return 0;\n' +
      '}',
      { storeSize: 4 * 1024 * 1024 } // 4MB store
    );
    assertEq(result.exitCode, 0, 'exit code: ' + result.stderr);
    assertEq(result.stdout, 'errors=0', 'stdout');
  });

  // ---- File truncation ----
  await test('C: truncate file on reopen', async function () {
    var result = await compileAndRun(
      '#include <stdio.h>\n' +
      'int main() {\n' +
      '  FILE *f = fopen("/t.txt", "w");\n' +
      '  fwrite("long data here", 1, 14, f);\n' +
      '  fclose(f);\n' +
      '  /* Reopen with truncation */\n' +
      '  f = fopen("/t.txt", "w");\n' +
      '  fwrite("short", 1, 5, f);\n' +
      '  fclose(f);\n' +
      '  /* Read back */\n' +
      '  f = fopen("/t.txt", "r");\n' +
      '  char buf[20] = {0};\n' +
      '  int n = fread(buf, 1, 20, f);\n' +
      '  fclose(f);\n' +
      '  printf("%d:%.*s", n, n, buf);\n' +
      '  return 0;\n' +
      '}'
    );
    assertEq(result.exitCode, 0, 'exit code: ' + result.stderr);
    assertEq(result.stdout, '5:short', 'stdout');
  });

  // ---- Stress: 200 files created, read back in random order ----
  await test('C: 200 files', async function () {
    var result = await compileAndRun(
      '#include <stdio.h>\n' +
      '#include <string.h>\n' +
      'int main() {\n' +
      '  char name[32];\n' +
      '  /* Create 200 files */\n' +
      '  for (int i = 0; i < 200; i++) {\n' +
      '    sprintf(name, "/f%d.txt", i);\n' +
      '    FILE *f = fopen(name, "w");\n' +
      '    if (!f) { printf("FAIL: fopen %s", name); return 1; }\n' +
      '    fprintf(f, "file_%d", i);\n' +
      '    fclose(f);\n' +
      '  }\n' +
      '  /* Read back every 10th file */\n' +
      '  char buf[20];\n' +
      '  for (int i = 0; i < 200; i += 10) {\n' +
      '    sprintf(name, "/f%d.txt", i);\n' +
      '    FILE *f = fopen(name, "r");\n' +
      '    if (!f) { printf("FAIL: fopen read %s", name); return 2; }\n' +
      '    int n = fread(buf, 1, 20, f);\n' +
      '    fclose(f);\n' +
      '    buf[n] = 0;\n' +
      '    char expect[20];\n' +
      '    sprintf(expect, "file_%d", i);\n' +
      '    if (strcmp(buf, expect) != 0) { printf("FAIL: mismatch %s vs %s", buf, expect); return 3; }\n' +
      '  }\n' +
      '  printf("ok 200 files");\n' +
      '  return 0;\n' +
      '}',
      { storeSize: 4 * 1024 * 1024 }
    );
    assertEq(result.exitCode, 0, 'exit code: ' + result.stderr);
    assertEq(result.stdout, 'ok 200 files', 'stdout: ' + result.stdout);
  });

  // ---- Stress: mixed read/write/seek on single file ----
  await test('C: random access writes', async function () {
    var result = await compileAndRun(
      '#include <stdio.h>\n' +
      '#include <string.h>\n' +
      'int main() {\n' +
      '  FILE *f = fopen("/random.dat", "w+");\n' +
      '  if (!f) { printf("FAIL: fopen"); return 1; }\n' +
      '  /* Write markers at various positions */\n' +
      '  long positions[] = {0, 1000, 5000, 200, 8000, 50, 4096, 100000};\n' +
      '  char *markers[] = {"start","1k","5k","200b","8k","50b","4k","end"};\n' +
      '  int n = 8;\n' +
      '  for (int i = 0; i < n; i++) {\n' +
      '    fseek(f, positions[i], SEEK_SET);\n' +
      '    fwrite(markers[i], 1, strlen(markers[i]), f);\n' +
      '  }\n' +
      '  /* Read them back in reverse order to verify */\n' +
      '  int errors = 0;\n' +
      '  for (int i = n-1; i >= 0; i--) {\n' +
      '    char buf[20] = {0};\n' +
      '    fseek(f, positions[i], SEEK_SET);\n' +
      '    int len = strlen(markers[i]);\n' +
      '    int nr = fread(buf, 1, len, f);\n' +
      '    if (nr != len || strncmp(buf, markers[i], len) != 0) errors++;\n' +
      '  }\n' +
      '  fclose(f);\n' +
      '  printf("errors=%d", errors);\n' +
      '  return 0;\n' +
      '}',
      { storeSize: 4 * 1024 * 1024 }
    );
    assertEq(result.exitCode, 0, 'exit code: ' + result.stderr);
    assertEq(result.stdout, 'errors=0', 'stdout: ' + result.stdout);
  });

  console.log('');
  console.log('--- BlockFS C E2E Tests ---');
  console.log('Passed: ' + passed);
  console.log('Failed: ' + failed);
  if (failed > 0) process.exit(1);
}

runTests().catch(function (e) {
  console.error('Fatal:', e.stack || e.message);
  process.exit(1);
});
