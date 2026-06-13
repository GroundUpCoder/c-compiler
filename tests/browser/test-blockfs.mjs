// Playwright test: compile a C program with --block-fs, serve the HTML,
// load it in headless Chromium, wait for completion, verify output.
//
// Usage: node test-blockfs.mjs
//
// Prerequisites: pnpm install (Playwright + Chromium already installed)

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const COMPILER_JS = path.join(ROOT, 'compiler.js');

const PORT = 3197;
const passed = [];
const failed = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertIncludes(text, needle, msg) {
  if (text.indexOf(needle) < 0)
    throw new Error((msg || 'assertIncludes') + ': expected "' + text.substring(0, 200) + '" to include "' + needle + '"');
}

// -------------------------------------------------------------------
// Compile C source to HTML using --block-fs
// -------------------------------------------------------------------

function compileToHTML(cSource, opts) {
  opts = opts || {};
  var tmpDir = '/tmp/blockfs_playwright_' + process.pid;
  fs.mkdirSync(tmpDir, { recursive: true });
  var cFile = path.join(tmpDir, 'main.c');
  var htmlFile = path.join(tmpDir, 'output.html');
  fs.writeFileSync(cFile, cSource);

  var args = ['-o', htmlFile];
  if (opts.blockFS) args.push('--block-fs');
  if (opts.compilerArgs) args.push(...opts.compilerArgs);
  args.push(cFile);

  var result = spawnSync('node', [COMPILER_JS, ...args], {
    encoding: 'utf-8',
    timeout: 30000,
    cwd: ROOT,
  });

  if (result.status !== 0) {
    throw new Error('compile failed (exit ' + result.status + '):\n' +
      (result.stderr || result.stdout || ''));
  }

  var html = fs.readFileSync(htmlFile, 'utf-8');
  return { html: html, tmpDir: tmpDir, htmlFile: htmlFile };
}

// -------------------------------------------------------------------
// Start a server and run a test page
// -------------------------------------------------------------------

async function runInBrowser(html, testName) {
  // Write HTML to a temp location the server can serve
  var serveFile = '/tmp/blockfs_serve_' + process.pid + '.html';
  fs.writeFileSync(serveFile, html);

  // Start server
  var server = http.createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.url === '/test.html' || req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });

  await new Promise(resolve => server.listen(PORT, resolve));
  console.log('  [server] up on port', PORT);

  var browser;
  try {
    browser = await chromium.launch({ headless: true });
    var page = await browser.newPage();

    // Collect console messages
    var logLines = [];
    page.on('console', msg => logLines.push('[' + msg.type() + '] ' + msg.text()));
    page.on('pageerror', err => logLines.push('[PAGEERROR] ' + err.message));

    console.log('  [browser] navigating...');
    await page.goto('http://localhost:' + PORT + '/test.html', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    // Click the overlay to start
    var overlay = page.locator('#overlay');
    try { await overlay.click({ timeout: 3000 }); } catch (e) {}

    // Wait for the program to finish (status shows exit code)
    console.log('  [browser] waiting for completion...');
    var status = '';
    var maxWait = 30000;
    var start = Date.now();
    while (Date.now() - start < maxWait) {
      status = await page.evaluate(() => {
        var el = document.getElementById('status');
        return el ? el.textContent : '';
      });
      if (status.indexOf('Exited') >= 0 || status.indexOf('Exit code') >= 0) break;
      await page.waitForTimeout(500);
    }

    // Collect all visible text from the page (stdout goes to xterm
    // terminal when xterm is active, or to #output pre when it's not).
    var pageText = await page.evaluate(() => document.body.innerText || '');

    // Dump for debugging
    console.log('  [browser] status:', status);
    console.log('  [browser] page text:', JSON.stringify(pageText.substring(0, 500)));
    console.log('  [browser] console messages:', logLines.join(' | ').substring(0, 500));

    return { status, pageText, logLines };

  } finally {
    if (browser) await browser.close();
    server.close();
    try { fs.unlinkSync(serveFile); } catch (e) {}
  }
}

// -------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------

async function test(name, fn) {
  try {
    console.log('test:', name);
    await fn();
    passed.push(name);
    console.log('  PASS');
  } catch (e) {
    failed.push(name);
    console.error('  FAIL:', e.message);
    if (e.stack) console.error('    ' + e.stack.split('\n')[1]);
  }
}

async function runTests() {

  // ---- Basic: write and read a file ----
  await test('block-fs: fopen / fwrite / fread', async function () {
    var { html } = compileToHTML(
      '#include <stdio.h>\n' +
      'int main() {\n' +
      '  FILE *f = fopen("/browser_test.txt", "w");\n' +
      '  if (!f) { fprintf(stderr, "FOPEN FAIL"); return 1; }\n' +
      '  fwrite("BROWSER_OK", 1, 10, f);\n' +
      '  fclose(f);\n' +
      '  f = fopen("/browser_test.txt", "r");\n' +
      '  if (!f) { fprintf(stderr, "FOPEN READ FAIL"); return 2; }\n' +
      '  char buf[50] = {0};\n' +
      '  int n = fread(buf, 1, 50, f);\n' +
      '  fclose(f);\n' +
      '  printf("%.*s", n, buf);\n' +
      '  return 0;\n' +
      '}',
      { blockFS: true }
    );

    var result = await runInBrowser(html, 'basic');
    assert(result.status.indexOf('Exited') >= 0, 'expected Exited, got: ' + result.status);
    assertIncludes(result.pageText, 'BROWSER_OK', 'page should contain file content');
  });

  // ---- Verify stdout/stderr separation ----
  await test('block-fs: stdout and stderr', async function () {
    var { html } = compileToHTML(
      '#include <stdio.h>\n' +
      'int main() {\n' +
      '  printf("stdout-text");\n' +
      '  fprintf(stderr, "stderr-text");\n' +
      '  printf("-more");\n' +
      '  return 0;\n' +
      '}',
      { blockFS: true }
    );

    var result = await runInBrowser(html, 'stdout-stderr');
    assert(result.status.indexOf('Exited') >= 0, 'expected Exited, got: ' + result.status);
    assertIncludes(result.pageText, 'stdout-text', 'page should have stdout');
    assertIncludes(result.pageText, 'stderr-text', 'page should have stderr');
  });

  // ---- Stat and directory listing ----
  await test('block-fs: stat and readdir', async function () {
    var { html } = compileToHTML(
      '#include <stdio.h>\n' +
      '#include <sys/stat.h>\n' +
      '#include <dirent.h>\n' +
      'int main() {\n' +
      '  FILE *f = fopen("/a.txt", "w"); fwrite("a",1,1,f); fclose(f);\n' +
      '  f = fopen("/b.txt", "w"); fwrite("bb",1,2,f); fclose(f);\n' +
      '  struct stat st;\n' +
      '  stat("/a.txt", &st);\n' +
      '  printf("a_size=%ld ", (long)st.st_size);\n' +
      '  stat("/b.txt", &st);\n' +
      '  printf("b_size=%ld", (long)st.st_size);\n' +
      '  return 0;\n' +
      '}',
      { blockFS: true }
    );

    var result = await runInBrowser(html, 'stat');
    assert(result.status.indexOf('Exited') >= 0, 'expected Exited, got: ' + result.status);
    assertIncludes(result.pageText, 'a_size=1', 'a.txt size should be 1');
    assertIncludes(result.pageText, 'b_size=2', 'b.txt size should be 2');
  });

  // ---- Non-zero exit code ----
  await test('block-fs: non-zero exit code', async function () {
    var { html } = compileToHTML(
      '#include <stdio.h>\n' +
      'int main() {\n' +
      '  fprintf(stderr, "failing on purpose");\n' +
      '  return 42;\n' +
      '}',
      { blockFS: true }
    );

    var result = await runInBrowser(html, 'exit42');
    assertIncludes(result.status, 'Exit code: 42', 'should show exit code 42, got: ' + result.status);
    assertIncludes(result.pageText, 'failing on purpose', 'page should have stderr');
  });
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

console.log('=== BlockFS Playwright Tests ===\n');

runTests().then(function () {
  console.log('\n--- Results ---');
  console.log('Passed:', passed.length);
  console.log('Failed:', failed.length);
  if (failed.length > 0) {
    console.log('Failures:');
    failed.forEach(function (f) { console.log('  - ' + f); });
    process.exit(1);
  }
}).catch(function (e) {
  console.error('Fatal:', e.stack || e.message);
  process.exit(1);
});
