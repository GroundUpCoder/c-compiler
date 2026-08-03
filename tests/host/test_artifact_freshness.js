'use strict';
// The build-artifact FRESHNESS guard (ticket #171).
//
// tests/browser/quake-renders.mjs used to guard its inputs with an
// `fs.existsSync` loop under the comment "Build artifacts must exist — refuse
// to test stale state". Existence is not freshness: a quake.wasm emitted by an
// older compiler.js passed that guard, and the suite then reported the OLD
// compiler's behaviour under the NEW compiler's name. The comment was the tell
// — it promised more than the code delivered, so the next reader stopped
// looking.
//
// Pinned here, against a real tmpdir fixture with real mtimes:
//   1. an artifact newer than every input is FRESH (the guard is not a
//      permanent red — a clean build must pass unchanged)
//   2. an artifact older than one input is STALE, and the message names BOTH
//      the artifact and the specific input that outran it
//   3. a missing artifact still reports the old "run <rebuild> first" message
//   4. a missing INPUT is an error, not a pass — an input that is not on disk
//      cannot establish freshness, and waving it through would be the same lie
//   5. the directory walk is recursive and honours `match`, so a newer file the
//      build does not consume does not raise a false stale
//   6. quake-renders.mjs actually CALLS it, and no existence-only artifact loop
//      survives there — a guard that is correct but unwired is still the bug
//
//   node tests/host/test_artifact_freshness.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n         ' + (e.message || e)); failures++; }
};

const REPO = path.resolve(__dirname, '..', '..');
const MODULE = path.join(REPO, 'tests', 'browser', 'lib', 'fresh-artifacts.mjs');
const DRIVER = path.join(REPO, 'tests', 'browser', 'quake-renders.mjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-artifact-fresh-'));
const srcDir = path.join(root, 'src', 'nested');
fs.mkdirSync(srcDir, { recursive: true });
const wwwDir = path.join(root, 'www');
fs.mkdirSync(wwwDir);

// Exact stamps, not wall-clock ordering: the whole relation under test IS an
// mtime comparison, so letting the clock decide the inputs would be measuring
// the clock. T0 is in the past, so a real write during the test never lands
// before a stamp.
const T0 = Date.now() - 120_000;
const setMtime = (p, ms) => fs.utimesSync(p, ms / 1000, ms / 1000);
const write = (p, body, ms) => { fs.writeFileSync(p, body); setMtime(p, ms); };

const compiler = path.join(root, 'compiler.js');
const srcA = path.join(root, 'src', 'a.c');
const srcNested = path.join(srcDir, 'b.c');
const note = path.join(root, 'src', 'NOTES.md');   // NOT an input of the build
const artifact = path.join(wwwDir, 'thing.wasm');

write(compiler, '// compiler\n', T0);
write(srcA, 'int a;\n', T0);
write(srcNested, 'int b;\n', T0);
write(note, 'not compiled\n', T0);
write(artifact, 'wasm bytes\n', T0 + 30_000);

const SPEC = () => ([{
  artifact,
  inputs: [compiler, { dir: path.join(root, 'src'), match: /\.[ch]$/ }],
  rebuild: 'pnpm run build:thing',
}]);

(async () => {
  const { checkArtifactFreshness } = await import(pathToFileURL(MODULE).href);
  const problemsFor = specs => checkArtifactFreshness(specs, { cwd: root });

  // ---- 1: clean build passes ----
  check('an artifact newer than every input reports no problem', () => {
    assert.deepStrictEqual(problemsFor(SPEC()), []);
  });

  // ---- 5: the unconsumed file must not raise a false stale ----
  setMtime(note, T0 + 60_000);
  check('a newer file that `match` excludes does not raise a false stale', () => {
    assert.deepStrictEqual(problemsFor(SPEC()), [],
      'NOTES.md is not an input; flagging it would train readers to ignore the guard');
  });
  setMtime(note, T0);

  // ---- 2: a real stale input, named ----
  setMtime(srcNested, T0 + 60_000);
  const stale = problemsFor(SPEC());
  check('an input newer than the artifact is reported STALE', () => {
    assert.strictEqual(stale.length, 1, 'expected exactly one problem, got: ' + JSON.stringify(stale));
    assert.ok(/^STALE /.test(stale[0]), 'the message must lead with STALE: ' + stale[0]);
  });
  check('the message names WHICH artifact and WHICH input outran it', () => {
    assert.ok(stale[0].includes('www/thing.wasm'), 'must name the artifact: ' + stale[0]);
    assert.ok(stale[0].includes(path.join('src', 'nested', 'b.c')),
      'must name the specific newer input, not just "an input": ' + stale[0]);
    assert.ok(stale[0].includes('pnpm run build:thing'), 'must name the rebuild command: ' + stale[0]);
  });
  check('the recursive walk finds an input in a SUBdirectory', () => {
    // b.c only ever reaches the comparison via the nested walk; if the walk were
    // one level deep this case would read as fresh.
    assert.ok(stale[0].includes('nested'));
  });
  setMtime(srcNested, T0);

  // ---- 3: missing artifact ----
  const artifactBody = fs.readFileSync(artifact);
  fs.rmSync(artifact);
  check('a missing artifact reports the rebuild command, as before', () => {
    const p = problemsFor(SPEC());
    assert.strictEqual(p.length, 1);
    assert.ok(p[0].startsWith('Missing '), p[0]);
    assert.ok(p[0].includes('pnpm run build:thing'), p[0]);
  });
  write(artifact, artifactBody, T0 + 30_000);

  // ---- 4: a missing INPUT is an error, not a silent pass ----
  check('an input that is not on disk is an ERROR, never a pass', () => {
    const p = checkArtifactFreshness([{
      artifact, inputs: [path.join(root, 'gone.c')], rebuild: 'pnpm run build:thing',
    }], { cwd: root });
    assert.strictEqual(p.length, 1, 'a missing input must not read as fresh: ' + JSON.stringify(p));
    assert.ok(p[0].includes('gone.c'), p[0]);
    assert.ok(/freshness cannot be established/.test(p[0]), p[0]);
  });

  // ---- 6: the driver is actually WIRED to it ----
  const driver = fs.readFileSync(DRIVER, 'utf-8');
  check('quake-renders.mjs imports and calls the freshness guard', () => {
    assert.ok(/from '\.\/lib\/fresh-artifacts\.mjs'/.test(driver),
      'quake-renders.mjs must import lib/fresh-artifacts.mjs');
    assert.ok(/requireFreshArtifacts\(\[/.test(driver),
      'quake-renders.mjs must CALL requireFreshArtifacts — a correct but unwired guard is still the bug');
  });
  check('all three build artifacts are covered by the call', () => {
    for (const f of ['quake.wasm', 'pak0.pak', 'host.js']) {
      assert.ok(driver.includes(`'${f}'`), `${f} must still be guarded`);
    }
  });
  check('no existence-only artifact loop survives in quake-renders.mjs', () => {
    assert.ok(!/existsSync/.test(driver),
      'the existence-only guard is what this ticket removed; it must not come back');
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nartifact-freshness: all checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
