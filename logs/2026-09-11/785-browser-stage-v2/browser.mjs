// Prepared only; real browser/OS launch needs a serialized coordinator grant.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import common from './common.cjs';
const { c, record, finalize } = common.setup('browser');
import cp from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require(path.join(c.root,'tests/lib/heavy-lock.js')).joinHeavyLock({ name:'#785 browser fixture and identity witness' });
assert(!process.env.DEBUG, 'declare existing DEBUG before combining');
process.env.DEBUG = 'pw:browser'; // retained native PID/exit/temp-cleanup diagnostics in outer stderr
import native from './native.cjs';
const { bounded, watch, stop, instrumentSpawns } = native;
const cleanupErrors = [], nativeAudit = instrumentSpawns();
let primaryError = null, stagePassed = false, fixture, server, serverWatch, browser;
const paths = ['/usr/share/os-release', '/usr/bin/cmdalt', '/bin/cmdalt', 'usr/bin/cmdalt', '/dev/null'];
const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'file-identity.c'), 'utf8');
const served = [], routeErrors = [];
let context, page;
const serverStreams = [];
try {
  // Explicit fixture preparation inside a future separately granted browser window.
  // One minimal bake, no folded/default package installation; never performed at preparation time.
  const imagePath = path.join(c.output, 'browser-system.img');
  const bakeArgv = ['-r', path.join(c.root, 'tests/lib/parent-watch.js'), path.join(c.root, 'tools/mkimage.js'), '--out=' + imagePath, '--quiet', '--no-default-packages'];
  const baked = cp.spawnSync(process.execPath, bakeArgv, { cwd: c.root, encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL', maxBuffer: 64 << 20, env: { ...process.env, CC_HARNESS_GROUP_LEADER: '0' } });
  record('fixture-bake.json', { pid: baked.pid, argv: [process.execPath, ...bakeArgv], status: baked.status, signal: baked.signal, error: baked.error && String(baked.error), stdout: baked.stdout, stderr: baked.stderr });
  assert.equal(baked.status, 0, 'explicit minimal fixture bake');
  fixture = { image: { path: imagePath, sha256: common.hashFile(imagePath) }, metadata: { path: imagePath + '.small.json', sha256: common.hashFile(imagePath + '.small.json') }, packages: [], defaultPackages: [] };
  record('fixture-inventory.json', fixture);
  const publication = { '/os/os-system.img': fixture.image, '/os/os-system.img.small.json': fixture.metadata };
  const serverConfig = path.join(c.output, 'server-config.json');
  fs.writeFileSync(serverConfig, JSON.stringify({ root: c.root, sources: c.sources, publication, output: c.output }));
  server = cp.spawn(process.execPath, ['-r', path.join(c.root, 'tests/lib/parent-watch.js'), path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-server.cjs'), serverConfig], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, CC_HARNESS_GROUP_LEADER: '0' } });
  serverWatch = nativeAudit.children.find(w => w.child === server);
  assert(serverWatch, 'actual server native child captured');
  for (const [stream,name] of [[server.stdout,'server.stdout'],[server.stderr,'server.stderr']]) {
    const target=fs.createWriteStream(path.join(c.output,name)); target.on('error',e=>cleanupErrors.push(String(e)));
    serverStreams.push(target); stream.pipe(target);
  }
  const ready = await bounded(new Promise((resolve, reject) => { server.once('message', resolve); server.once('error', reject); server.once('exit', () => reject(new Error('server exited before ready'))); }), 15000, 'owned server listen');
  const base = 'http://127.0.0.1:' + ready.port;
  const identity = await (await fetch(base + '/__serve-id')).json();
  assert.equal(identity.pid, server.pid); assert.equal(identity.root, c.root);
  assert.equal(identity.configSha256, common.hashFile(serverConfig));
  record('server-identity.json', { ...identity, origin: base });
  assert.equal(common.hashFile(c.browser.executable), c.browser.sha256, 'browser executable drift');
  const h = await import(pathToFileURL(path.join(c.root, 'tests/browser/lib/os-harness.mjs')));
  browser = await h.launchBrowser(c.browser.args, { executablePath: c.browser.executable, timeout: 60000 });
  record('browser-engine.json', { version: browser.version(), executable: c.browser.executable, sha256: common.hashFile(c.browser.executable), args: c.browser.args });
  context = await browser.newContext({ viewport: { width: 1100, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    try {
    const url = new URL(route.request().url());
    assert.equal(url.origin, base, 'same-origin request only');
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
        if (procSpec.path !== '/root/identity785') return null;
        var backends = [kernel._fs].concat(kernel._fs._mounts.map(function (m) { return m.fs; }));
        var errors = backends.map(function (f) { return f._lastError; });
        try { return { ro: procSpec.ro ? { prefix: procSpec.ro.prefix, dev: procSpec.ro.dev, leaf: procSpec.ro.leaf } : null,
          files: ${JSON.stringify(paths)}.map(function (p) {
            var abs = p.charAt(0) === '/' ? p : '/' + p;
            var row = { path:p, stat:kernel._fs.stat(abs), lstat:kernel._fs.lstat(abs) };
            if (p === '/dev/null') { row.data = [0,0]; row.dataBasis = 'null device EOF contract, not raw backing-file contents'; }
            else {
              var fd = kernel._fs.open(abs, 0, 0), buf = new Uint8Array(1);
              if (fd === null || fd < 0) throw new Error('owner oracle open failed: ' + abs);
              try { row.data = [kernel._fs.read(fd, buf, 1), buf[0]]; } finally { kernel._fs.close(fd); }
              row.dataBasis = 'independent owner read';
            }
            return row;
          }) }; }
        finally { backends.forEach(function (f, i) { f._lastError = errors[i]; }); }
      })(),`);
    }
    if (file === 'os/kernel-worker.js') {
      insert('  w.__pwServedPid = procSpec.pid;', `  w.__pwServedPid = procSpec.pid;
  if (w.__identity785Use !== undefined) throw new Error('identity witness worker reused');
  w.__identity785Use = procSpec.pid;`);
      insert('      warm: !!ent,', '      identity785SingleUsePid: w.__identity785Use,\n      warm: !!ent,');
    }
    if (file === 'kernel.js') {
      insert('  pcb.state = STATE_ZOMBIE;\n  pcb.exit = status;', `  if (typeof globalThis.postMessage === 'function') globalThis.postMessage({ type:'spawn-trace', trace:{ pid:pcb.pid, identity785GuestWaitStatus:status } });
  pcb.state = STATE_ZOMBIE;
  pcb.exit = status;`);
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
    return await route.fulfill({ response, body });
    } catch(error) { routeErrors.push(error.stack); await route.abort(); }
  });
  page = await context.newPage();
  await page.goto(base + '/os/os.html?hostkeys=off&spawntrace=1&pooldepth=3');
  await h.waitFor(page, () => window.__osState === 'ready', { timeout: 180000 });
  const helpers = h.osHelpers(page); await helpers.setVt(1);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(s => navigator.clipboard.writeText(s), source);
  const command = 'cd / && pbpaste > /root/identity785.c && cc /root/identity785.c -o /root/identity785 && sha256sum /root/identity785 && /root/identity785 path ' + paths.join(' ') + ' && /root/identity785 inherit /usr/share/os-release; echo IDENTITY785-RES' + '""' + 'ULT=$?';
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
    const ro = t.identity785Owner.ro;
    assert(ro && ro.prefix === '/usr' && ro.leaf === true && Number.isInteger(ro.dev) && ro.dev > 0 && ro.dev <= 0xffffffff, 'positively eligible leaf /usr descriptor required');
    assert.deepEqual(t.identity785Worker.ro, ro);
    assert.equal(t.identity785Worker.admitted, true, 'actual positive worker RO admission');
    assert.equal(t.identity785Worker.admittedDev, ro.dev);
    assert.equal(t.identity785GuestWaitStatus, 0, 'actual kernel guest wait status');
    assert.equal(t.identity785SingleUsePid, t.pid, 'single-use identity matches process');
  }
  assert(traces.some(t => t.warm === true && t.identity785Worker.admitted === true && Number.isFinite(t.t1) && Number.isFinite(t.k0) && t.t1 <= t.k0), 'positively admitted warm single-use identity process');
  const oracle = Object.fromEntries(traces[0].identity785Owner.files.map(r => [r.path, r]));
  const rows = snapshot.out.split(/\r?\n/).filter(r => /^IDENTITY785 /.test(r));
  const expected = paths.flatMap(p => ['stat','lstat','fstat','dup-fstat','DATA'].map(op => op + ' ' + p));
  expected.push(...['parent-fd','child-path','child-fd0'].map(op => op + ' /usr/share/os-release'));
  assert.deepEqual(rows.map(r => r.split(' ').slice(1,3).join(' ')).sort(), expected.sort(), 'exact metadata/DATA multiset');
  for (const row of rows) {
    const [,op,p,...values] = row.split(' '); assert(oracle[p], row);
    const st = oracle[p][op === 'lstat' ? 'lstat' : 'stat'];
    assert.deepEqual(values.map(Number), op === 'DATA' ? oracle[p].data : [st.dev,st.ino,st.mode,st.rdev || 0], row);
  }
  for (const p of ['/bin/cmdalt','usr/bin/cmdalt']) assert.deepEqual([oracle[p].stat.dev,oracle[p].stat.ino], [oracle['/usr/bin/cmdalt'].stat.dev,oracle['/usr/bin/cmdalt'].stat.ino], 'alias/relative same file');
  assert.equal(routeErrors.length,0,'source instrumentation route failures');
  stagePassed = true;
} catch (error) {
  primaryError = error;
  if (page) {
    try { record('failure-page.json', await bounded(page.evaluate(() => ({ out: window.__osOut, traces: window.__spawnTraces || [] })),5000,'failure snapshot')); }
    catch (e) { cleanupErrors.push(String(e)); }
  }
} finally {
  if (browser) try { await bounded(browser.close(),15000,'browser close'); } catch (e) { cleanupErrors.push(String(e)); }
  // Browser worker native exits are unavailable. These are native Node child handles.
  for (const w of nativeAudit.children) await stop(w, cleanupErrors);
  for (const stream of serverStreams) if (!stream.closed) {
    try { await bounded(new Promise((resolve,reject)=>{stream.once('close',resolve);stream.once('error',reject);}),5000,'server log flush'); } catch(e) { cleanupErrors.push(String(e)); }
  }
  if (fixture) for (const f of [fixture.image,fixture.metadata]) {
    try { assert.equal(common.hashFile(f.path),f.sha256,'final generated fixture hash'); } catch(e) { cleanupErrors.push(String(e)); }
  }
  nativeAudit.restore();
  record('native-cleanup.json', { children: nativeAudit.children.map(w => w.row), cleanupErrors, browserWorkerNativeExit: 'unavailable in browser Worker API; no invented exit code' });
  const browserChild = nativeAudit.children.find(w => w.row.command[0] === c.browser.executable);
  const cleanupComplete = !!serverWatch && serverWatch.row.exitObserved && serverWatch.row.closeObserved && !!browserChild && browserChild.row.exitObserved && browserChild.row.closeObserved && browserChild.row.code === 0 && browserChild.row.signal === null && serverWatch.row.code === 0 && serverWatch.row.signal === null && cleanupErrors.length === 0;
  if (primaryError) record('failure.json', { primaryError: primaryError.stack, cleanupErrors, served, routeErrors });
  finalize(primaryError, { stagePassed, cleanupComplete, artifactErrors: cleanupErrors, native: nativeAudit.children.map(w => w.row), workerNativeExitCoverage: 'unavailable; only guest command status and trace admission observed' });
  if (process.exitCode) process.exit(1);
}
