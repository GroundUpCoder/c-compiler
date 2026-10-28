'use strict';
// Prepared only. Real guest compile/worker execution requires coordinator grant.
const fs = require('fs'), path = require('path'), cp = require('child_process'), assert = require('assert');
const { setup, sha } = require('./common.cjs');
const { c, record, finalize } = setup('node-worker');
require(path.join(c.root, 'tests/lib/heavy-lock.js')).joinHeavyLock({ name: '#785 Node worker witness' });
const K = require(path.join(c.root, 'kernel.js')), { BLOCK_FS: B } = require(path.join(c.root, 'host.js'));
const wasm = path.join(c.output, 'file-identity.wasm');
let image;
const cases = [], artifactErrors = [];
const errorText = error => error && (error.stack || String(error));
function retain(name, value) {
  try { record(name, value); }
  catch (error) { artifactErrors.push({ name, error: errorText(error) }); }
}
// Every wait owns and clears its timer on either resolution or rejection.
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' deadline ' + ms + 'ms')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function compileWitness() {
  const compile = cp.spawnSync(process.execPath, [path.join(c.root, 'compiler.js'), path.join(__dirname, 'file-identity.c'), '-o', wasm], { encoding: 'utf8', timeout: 120000 });
  record('compile.json', { pid: compile.pid, command: [process.execPath, path.join(c.root, 'compiler.js'), path.join(__dirname, 'file-identity.c'), '-o', wasm], status: compile.status, signal: compile.signal, error: compile.error && String(compile.error), stdout: compile.stdout, stderr: compile.stderr });
  assert.strictEqual(compile.status, 0, 'witness compilation');
  image = fs.readFileSync(wasm); record('module.json', { sha256: sha(image), bytes: image.length });
}
function makeWorld(nested) {
  const rwStore = new B.MemoryByteStore(1 << 20), roStore = new B.MemoryByteStore(1 << 20);
  const rw = B.createV4(rwStore), ro = B.createV4(roStore);
  function put(f, p, n) { const fd = f.open(p, 0x42, 0o644); assert.notStrictEqual(fd, null); f.write(fd, new Uint8Array([n]), 1); f.close(fd); }
  put(ro, '/f', 65); ro.link('/f', '/hard'); ro.symlink('/usr/f', '/alias');
  ro.mkdir('/nested', 0o755); put(ro, '/nested/f', 66); ro.symlink('/usr/nested/f', '/into');
  put(rw, '/f', 90); put(rw, '/only', 89);
  const sab = B.storeToSab(roStore), reader = B.createV4(new B.SabByteStore(sab), { readonly: true });
  const stores = { root: rwStore, usr: roStore };
  const mounts = [{ prefix: '/', fs: rw }, { prefix: '/usr', fs: reader }];
  if (nested) {
    const nestedStore = new B.MemoryByteStore(1 << 20), n = B.createV4(nestedStore);
    stores.nested = nestedStore; put(n, '/f', 88); put(n, '/only', 87); mounts.push({ prefix: '/usr/nested', fs: n });
  }
  return { fs: new B.MountFS(mounts), sab, stores };
}
const metadata = s => [s.dev, s.ino, s.mode, s.rdev || 0];
async function run(name, local, nested, inherit) {
  const world = makeWorld(nested);
  const paths = inherit ? ['/usr/f'] : nested ? ['/usr/nested/f', '/usr/nested/only', '/usr/into'] : ['/usr/f', '/usr/hard', '/usr/alias'];
  const oracle = {};
  for (const p of paths) {
    const fd = world.fs.open(p, 0, 0), buf = new Uint8Array(1);
    assert.notStrictEqual(fd, null); const n = world.fs.read(fd, buf, 1); world.fs.close(fd);
    oracle[p] = { stat: metadata(world.fs.stat(p)), lstat: metadata(world.fs.lstat(p)), data: [n, buf[0]] };
  }
  // Pin actual generated fixture bytes before any guest starts.
  const fixturePins = {};
  for (const [volume, store] of Object.entries(world.stores)) {
    const bytes = Buffer.from(B.storeToSab(store)); fixturePins[volume] = sha(bytes);
    fs.writeFileSync(path.join(c.output, name + '.' + volume + '.img'), bytes, { flag: 'wx' });
  }
  record(name + '.fixture.json', { fixturePins, oracle, paths, localRequested: local, nested });
  let out = '', err = '', kernel, resolveHalt, exit = null;
  let bootPid = null, bootSettled = false, guestHaltObserved = false, admissionClosed = false;
  let primaryError = null;
  const cleanup = { attempted: false, errors: [], terminationRequests: [] };
  const state = { name, completed: false }; cases.push(state);
  const ended = new Promise(resolve => { resolveHalt = resolve; });
  const specs = [], rpc = [], nativeWorkers = [], nativeDone = [], handles = [];
  const factory = K.nodeCreateWorker({ hostPath: path.join(c.root, 'host.js'), kernelPath: path.join(c.root, 'kernel.js') });
  kernel = new K.Kernel({ fs: world.fs, roImage: local ? { prefix: '/usr', sab: world.sab } : null,
    createWorker(spec) {
      if (admissionClosed) throw new Error(name + ': worker creation after failure cleanup began');
      specs.push({ pid: spec.pid, path: spec.path, ro: spec.ro && { prefix: spec.ro.prefix, dev: spec.ro.dev, leaf: spec.ro.leaf } });
      const handle = factory(spec);
      const native = { guestPid: spec.pid, kernelTerminationRequested: false, cleanupTerminationRequested: false, exitObserved: false };
      nativeWorkers.push(native);
      const terminate = handle.terminate;
      handles.push({ handle, terminate, native });
      handle.terminate = function () { native.kernelTerminationRequested = true; return terminate.apply(this, arguments); };
      nativeDone.push(new Promise(resolve => handle.onExit(code => {
        native.exitCode = code; native.exitObserved = true; native.exitObservedAt = new Date().toISOString(); resolve();
      })));
      return handle;
    },
    loadImage: p => p === '/bin/identity785' ? image : null,
    onOutput(pid, fd, bytes) { if (fd === 2) err += Buffer.from(bytes); else out += Buffer.from(bytes); },
    onHalt: status => { exit = status; guestHaltObserved = true; resolveHalt(); }, log: text => { err += text + '\n'; } });
  kernel.createTty({ cols: 80, rows: 24, output() {} });
  const original = kernel._fsRpc;
  kernel._fsRpc = function (pcb, op, req) { rpc.push({ pid: pcb.pid, op, req }); return original.call(this, pcb, op, req); };
  const snapshot = () => ({ out, err, rpc, specs, bootPid, bootSettled, exit, guestHaltObserved, nativeWorkers,
    nativeCompletionObserved: nativeWorkers.length > 0 && nativeWorkers.every(w => w.exitObserved),
    primaryError: errorText(primaryError), cleanup });
  // boot() resolves a numeric init PID (kernel.js:2576-2595), not a spawn result object.
  const lifecycle = (async () => {
    try {
      bootPid = await kernel.boot({ path: '/bin/identity785', argv: ['/bin/identity785', inherit ? 'inherit' : 'path', ...paths], envp: [], cwd: '/' });
    } finally { bootSettled = true; }
    assert(Number.isInteger(bootPid) && bootPid > 0, 'numeric Kernel.boot PID: ' + JSON.stringify(bootPid));
    await ended;
    await Promise.all(nativeDone);
  })();
  try {
    await bounded(lifecycle, 90000, name + ' guest/native completion');
    assert(nativeWorkers.length === specs.length && nativeWorkers.every(w => w.exitObserved && Number.isInteger(w.exitCode)), 'actual native worker exits');
    // Kernel-induced worker termination is separate from guest wait status.
    assert(nativeWorkers.every(w => w.kernelTerminationRequested), 'kernel termination path recorded');
    assert.strictEqual(exit, 0, name + ' guest exit'); assert(!err, err);
    const rows = out.trim().split('\n').filter(x => x.startsWith('IDENTITY785 '));
    for (const row of rows) {
      const words = row.split(' '), op = words[1], p = words[2], values = words.slice(3).map(Number);
      assert(oracle[p], row);
      assert.deepStrictEqual(values, op === 'DATA' ? oracle[p].data : oracle[p][op === 'lstat' ? 'lstat' : 'stat'], row);
    }
    const expectedKeys = inherit ? ['parent-fd', 'child-path', 'child-fd0'].map(op => op + ' ' + paths[0])
      : paths.flatMap(p => ['stat', 'lstat', 'fstat', 'dup-fstat', 'DATA'].map(op => op + ' ' + p));
    assert.deepStrictEqual(rows.map(row => row.split(' ').slice(1, 3).join(' ')).sort(), expectedKeys.sort(), 'exact record multiset; no missing/duplicate/unexpected keys');
    const fsOps = [K.OP.FS_STAT, K.OP.FS_LSTAT, K.OP.FS_FSTAT, K.OP.FS_OPEN, K.OP.FS_CLOSE, K.OP.FS_READ, K.OP.FS_DUP];
    const reads = rpc.filter(r => fsOps.includes(r.op));
    if (local && !nested && !inherit) assert.strictEqual(reads.length, 0, 'leaf zero-RPC');
    else assert(reads.length > 0, 'broker/promotion actually exercised');
    if (nested) assert(specs.every(s => s.ro === null), 'whole nested fallback');
    if (inherit) assert(specs.length === 2, 'actual child worker');
    state.completed = true;
    return { oracle, rows };
  } catch (error) {
    primaryError = error;
    retain(name + '.failure-before-cleanup.json', snapshot());
    throw error;
  } finally {
    if (primaryError) {
      cleanup.attempted = true;
      admissionClosed = true; // prevent a pending boot/spawn from starting a late worker
      try {
        await bounded(lifecycle, 5000, name + ' graceful failure observation');
        cleanup.gracefulLifecycleObserved = true;
      } catch (error) {
        cleanup.errors.push({ phase: 'graceful-observation', error: errorText(error) });
      }
      // Termination requests are not exits. Use the captured existing handle method;
      // do not alter the product kernel's termination policy or label these as kernel requests.
      for (const { handle, terminate, native } of handles) {
        if (native.exitObserved) continue;
        native.cleanupTerminationRequested = true;
        cleanup.terminationRequests.push(native.guestPid);
        try { terminate.call(handle); }
        catch (error) { cleanup.errors.push({ phase: 'terminate', guestPid: native.guestPid, error: errorText(error) }); }
      }
      try {
        await bounded(Promise.all(nativeDone), 5000, name + ' native failure observation');
      } catch (error) {
        cleanup.errors.push({ phase: 'native-observation', error: errorText(error) });
      }
      cleanup.bootSettled = bootSettled;
      cleanup.allCreatedWorkersExited = nativeWorkers.every(w => w.exitObserved);
      cleanup.guestHaltObserved = guestHaltObserved;
    }
    Object.assign(state, { guestHaltObserved, bootSettled, nativeCount: nativeWorkers.length,
      nativeCompletionObserved: nativeWorkers.length > 0 && nativeWorkers.every(w => w.exitObserved),
      primaryError: errorText(primaryError), cleanup });
    retain(name + '.result.json', snapshot());
    if (!primaryError && artifactErrors.length) {
      state.completed = false;
      throw new Error(name + ': artifact retention failed: ' + JSON.stringify(artifactErrors));
    }
  }
}
(async () => {
  let primaryError = null;
  try {
    compileWitness();
    const local = await run('leaf-local', true, false, false);
    const broker = await run('leaf-broker', false, false, false);
    assert.deepStrictEqual(local, broker, 'identical namespace fixture through local and broker');
    await run('leaf-inherit', true, false, true);
    await run('nested-broker', true, true, false);
    assert.strictEqual(cases.length, 4, 'all four cases');
    assert(cases.every(x => x.completed), 'all four obligations completed');
    assert.strictEqual(artifactErrors.length, 0, 'artifact retention failures');
  } catch (error) { primaryError = error; }
  if (primaryError) retain('failure.json', { error: errorText(primaryError), cases, artifactErrors });
  const evidence = { cases, artifactErrors,
    allFourCasesCompleted: cases.length === 4 && cases.every(x => x.completed),
    nativeCompletionObserved: cases.length > 0 && cases.every(x => x.nativeCompletionObserved),
    guestCompletionObserved: cases.length > 0 && cases.every(x => x.guestHaltObserved),
    failureExitPolicy: primaryError ? 'exit 1 after bounded cleanup and synchronous finalization; any unobserved worker exit remains unknown' : null };
  try { finalize(primaryError, evidence); }
  catch (error) {
    retain('finalization-error.json', { primaryError: errorText(primaryError), finalizationError: errorText(error), evidence });
    process.stderr.write('785 finalization failure: ' + errorText(error) + '\nprimary: ' + errorText(primaryError) + '\n');
    process.exit(1);
  }
  // Do not let a failed guest, pending boot or other retained handle keep Node alive.
  // This is a native parent exit, never substituted for missing worker onExit evidence.
  if (primaryError || process.exitCode || artifactErrors.length) process.exit(1);
})();
