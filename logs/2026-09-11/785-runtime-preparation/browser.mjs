// Prepared only; real browser/OS launch needs a serialized coordinator grant.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import common from './common.cjs';
const { c, record } = common.setup('browser');
assert(Object.keys(c.fixtures).length > 0, 'pin actual served image/package fixtures before browser launch');
assert.equal(common.hashFile(c.browser.executable), c.browser.sha256, 'browser executable drift');
const h = await import(pathToFileURL(path.join(c.root, 'tests/browser/lib/os-harness.mjs')));
// Coordinator supplies a separately approved, pinned server. This instrument
// cannot start serve.js and silently trigger an image/package rebuild.
const base = c.browser.origin;
const identity = await (await fetch(base + '/__serve-id')).json();
assert.deepEqual(identity, c.browser.serverIdentity, 'approved server identity');
const paths = ['/usr/share/os-release', '/usr/bin/cmdalt', '/dev/null'];
const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'file-identity.c'), 'utf8');
const served = [];
const browser = await h.launchBrowser(c.browser.args, { executablePath: c.browser.executable });
let context, page;
try {
  record('browser-engine.json', { version: browser.version(), executable: c.browser.executable, sha256: common.hashFile(c.browser.executable), args: c.browser.args });
  context = await browser.newContext({ viewport: { width: 1100, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const file = url.pathname.slice(1);
    if (!['os/kernel-worker.js', 'os/process-worker.js', 'host.js', 'kernel.js'].includes(file)) return route.continue();
    const response = await route.fetch();
    const original = await response.text();
    assert.equal(common.sha(Buffer.from(original)), c.sources[file], 'served source ' + file);
    let body = original;
    function insert(anchor, text) {
      assert.equal(body.split(anchor).length, 2, 'unique instrumentation anchor ' + file);
      body = body.replace(anchor, text);
    }
    if (file === 'os/kernel-worker.js') {
      insert('TRACE_PENDING[procSpec.pid] = {', `TRACE_PENDING[procSpec.pid] = {
      identity785Owner: (function () {
        var backends = [kernel._fs].concat(kernel._fs._mounts.map(function (m) { return m.fs; }));
        var errors = backends.map(function (f) { return f._lastError; });
        try { return { ro: procSpec.ro ? { prefix: procSpec.ro.prefix, dev: procSpec.ro.dev, leaf: procSpec.ro.leaf } : null,
          files: ${JSON.stringify(paths)}.map(function (p) { return { path:p, stat:kernel._fs.stat(p), lstat:kernel._fs.lstat(p) }; }) }; }
        finally { backends.forEach(function (f, i) { f._lastError = errors[i]; }); }
      })(),`);
    }
    if (file === 'os/process-worker.js') {
      const anchor = '  if (TR) {\n    // (d) first output';
      insert(anchor, `  if (TR) TR.identity785Worker = { ro: wd.ro ? { prefix:wd.ro.prefix, dev:wd.ro.dev, leaf:wd.ro.leaf } : null,
    admitted: !!rfs._ro, admittedDev: rfs._ro ? rfs._ro.dev : null };
${anchor}`);
    }
    served.push({ file, originalSha256: common.sha(Buffer.from(original)), instrumentedSha256: common.sha(Buffer.from(body)) });
    // Keep exact served instrumentation bytes; never change staged sources.
    const name = file.replaceAll('/', '_');
    if (!fs.existsSync(path.join(c.output, name))) fs.writeFileSync(path.join(c.output, name), body, { flag: 'wx' });
    return route.fulfill({ response, body });
  });
  page = await context.newPage();
  await page.goto(base + '/os/os.html?hostkeys=off&spawntrace=1&pooldepth=3');
  await h.waitFor(page, () => window.__osState === 'ready', { timeout: 180000 });
  const helpers = h.osHelpers(page); await helpers.setVt(1);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(s => navigator.clipboard.writeText(s), source);
  const command = 'pbpaste > /root/identity785.c && cc /root/identity785.c -o /root/identity785 && sha256sum /root/identity785 && /root/identity785 path ' + paths.join(' ') + ' && /root/identity785 inherit /usr/share/os-release; echo IDENTITY785-RESULT=$?';
  await page.keyboard.type(command + '\r');
  await h.waitFor(page, () => /IDENTITY785-RESULT=\d+/.test(window.__osOut || ''), { timeout: 180000 });
  const snapshot = await page.evaluate(() => ({ out: window.__osOut, traces: window.__spawnTraces || [] }));
  record('browser-result.json', { ...snapshot, served, command });
  assert.match(snapshot.out, /IDENTITY785-RESULT=0/);
  assert.match(snapshot.out, /[0-9a-f]{64}\s+\/root\/identity785/, 'actual guest module SHA256');
  const traces = snapshot.traces.filter(t => t.path === '/root/identity785');
  assert.equal(traces.length, 3, 'path parent, inherit parent, inherited child');
  assert(traces.some(t => t.warm === true), 'actual prewarmed single-use pool take');
  assert.equal(new Set(traces.map(t => t.pid)).size, traces.length);
  for (const t of traces) {
    assert(t.identity785Owner && t.identity785Worker, 'both actual descriptor witnesses');
    assert.deepEqual(t.identity785Worker.ro, t.identity785Owner.ro);
    assert.equal(t.identity785Worker.admitted, !!t.identity785Owner.ro);
    if (t.identity785Owner.ro) assert.equal(t.identity785Worker.admittedDev, t.identity785Owner.ro.dev);
  }
  const oracle = Object.fromEntries(traces[0].identity785Owner.files.map(r => [r.path, r]));
  const rows = snapshot.out.split(/\r?\n/).filter(r => /^IDENTITY785 (stat|lstat|fstat|dup-fstat|parent-fd|child-path|child-fd0) /.test(r));
  assert.equal(rows.length, paths.length * 4 + 3, 'all metadata rows present');
  for (const row of rows) {
    const [label, op, p, ...values] = row.split(' '), st = oracle[p][op === 'lstat' ? 'lstat' : 'stat'];
    assert.deepEqual(values.map(Number), [st.dev, st.ino, st.mode, st.rdev || 0], row);
  }
  record('outcome.json', { status: 'pass' });
} catch (error) {
  if (page) record('failure-page.json', await page.evaluate(() => ({ out: window.__osOut, traces: window.__spawnTraces || [] })).catch(() => ({})));
  record('failure.json', { error: error.stack, served }); process.exitCode = 1;
} finally { await browser.close(); }
