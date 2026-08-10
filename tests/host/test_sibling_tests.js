'use strict';
// #613: sibling-owned test discovery (tests/lib/sibling-tests.js) + the
// suite-runner seams it rides. What is pinned, and why each pin exists:
//
// LOADER (fixture trees, real fs):
//   1. no sibling checkout -> status 'absent' (the caller's loud SKIP —
//      never a failure; rationale in design §3).
//   2. GUCOS_PACKAGES override naming a nonexistent path -> 'invalid', not
//      'absent': an explicit override that is wrong must fail loud, never
//      quietly demote to a skip (the cmdalt no-silent-fallback rule).
//   3. every malformed-manifest shape -> 'invalid' with a NAMED error.
//      The trap this closes: each of these would otherwise degrade to
//      "zero members", which is indistinguishable from "the sibling has no
//      tests" and prints green while its tests never run.
//   4. a valid manifest -> prefixed keys ('<repo>/<file>'), absolute src,
//      and the CLOSED option allowlist passed through.
//   5. a linked-worktree ccRoot resolves the MAIN clone's sibling (the
//      resolver contract is test_sibling_resolve.js's; this leg proves the
//      loader composes it — the naive ../<name> does not exist from a
//      worktree, and a hand-rolled resolver would report 'absent' and make
//      the skip path look perfectly correct forever).
//
// SUITE-RUNNER (real child processes, real summary.json):
//   6. a sibling and a native member with the SAME basename coexist:
//      distinct record keys, distinct logs — the summary/resume/log/filter
//      namespaces key on entry.file, so an unprefixed sibling would collide
//      in all four at once.
//   7. a failing sibling member fails the suite (the unit-level red
//      control; the live kernel-suite twin is in the #613 dev log).
//   8. evidence.extra covers the sibling dir: a sibling member that is
//      EXPECTED on disk but never ran is an EVIDENCE failure — without
//      extra, the evidence line is computed from opts.dir alone and prints
//      "N/N have logs" while the sibling tests never ran (the #314 defect
//      class, reintroduced one level up).
//   9. --resume freshness stats entry.src: an edited sibling test is
//      re-executed, never resumed (#455's contract, extended to the file's
//      real location — joining opts.dir with a prefixed key would stat a
//      path that never exists).
//
//   node tests/host/test_sibling_tests.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSiblingTests } = require('../lib/sibling-tests.js');
const { runSuite } = require('../lib/suite-runner.js');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n         ' + (e.message || e)); failures++; }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sibtests-'));
const mk = (rel) => { const p = path.join(tmp, rel); fs.mkdirSync(p, { recursive: true }); return p; };
const w = (rel, text) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
const manifest = (obj) => w('git/gucos-packages/tests/manifest.json',
  typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) + '\n');

// A fake main clone (its .git is a DIRECTORY) with a sibling checkout.
const CC = mk('git/c-compiler');
mk('git/c-compiler/.git');
const SIB = mk('git/gucos-packages');
const SIBT = mk('git/gucos-packages/tests');

// env: null everywhere below — the ambient GUCOS_PACKAGES of the box running
// this test must not reach the fixture legs.
const load = (over) => loadSiblingTests(Object.assign({ ccRoot: CC, env: null }, over));

// ---- 1. absent ----
check('no sibling checkout -> status absent', () => {
  const CC2 = mk('lonely/c-compiler');
  mk('lonely/c-compiler/.git');
  const r = loadSiblingTests({ ccRoot: CC2, env: null });
  assert.strictEqual(r.status, 'absent');
});

// ---- 2. env override pointing nowhere is INVALID, not absent ----
check('GUCOS_PACKAGES pointing nowhere -> invalid, naming the variable', () => {
  const r = loadSiblingTests({ ccRoot: CC, env: path.join(tmp, 'no-such') });
  assert.strictEqual(r.status, 'invalid');
  assert.ok(/GUCOS_PACKAGES/.test(r.errors.join('\n')), r.errors.join('\n'));
});

// ---- 3. the malformed-manifest matrix — every shape a NAMED invalid ----
const invalid = (name, setup, re) => check(name, () => {
  setup();
  const r = load();
  assert.strictEqual(r.status, 'invalid', 'expected invalid, got ' + r.status);
  assert.ok(re.test(r.errors.join('\n')), 'errors did not match ' + re + ':\n' + r.errors.join('\n'));
});
invalid('missing tests/ dir -> invalid', () => {
  fs.rmSync(SIBT, { recursive: true, force: true });
}, /tests.*missing/i);
invalid('missing manifest.json -> invalid', () => { mk('git/gucos-packages/tests'); }, /manifest\.json.*missing|unreadable/i);
invalid('unparseable JSON -> invalid', () => manifest('{nope'), /does not parse/);
invalid('non-object manifest -> invalid', () => manifest('[1,2]\n'), /must be a JSON object/);
invalid('missing pattern -> invalid', () => manifest({ members: [], exclude: [] }), /"pattern" must be/);
invalid('uncompilable pattern -> invalid', () => manifest({ pattern: '([', members: [] }), /does not compile/);
invalid('members not an array -> invalid', () => manifest({ pattern: '^test_.*\\.js$', members: {} }), /"members" must be an array/);
invalid('member with a path separator -> invalid', () => manifest({
  pattern: '^test_.*\\.js$', members: [{ file: 'sub/test_a.js' }],
}), /no path separators/);
invalid('member not matching the pattern -> invalid', () => manifest({
  pattern: '^test_.*\\.js$', members: [{ file: 'probe.js' }],
}), /does not match the manifest's own pattern/);
invalid('member with an UNKNOWN key -> invalid naming it (never ignored)', () => manifest({
  pattern: '^test_.*\\.js$', members: [{ file: 'test_a.js', timeoutMS: 5 }],
}), /unknown key "timeoutMS"/);
invalid('member with a bad timeoutMs -> invalid', () => manifest({
  pattern: '^test_.*\\.js$', members: [{ file: 'test_a.js', timeoutMs: -1 }],
}), /"timeoutMs" must be a positive integer/);
invalid('RAM-class tag (light) refused — weights are local measurements', () => manifest({
  pattern: '^test_.*\\.js$', members: [{ file: 'test_a.js', light: true }],
}), /unknown key "light"/);
invalid('exclude entry without an owner -> invalid', () => manifest({
  pattern: '^test_.*\\.js$', members: [], exclude: [{ file: 'test_b.js' }],
}), /"owner" must name the live ticket/);
invalid('unknown TOP-LEVEL key -> invalid', () => manifest({
  pattern: '^test_.*\\.js$', members: [], extra: 1,
}), /unknown top-level key "extra"/);

// ---- 4. a valid manifest -> runner-shaped entries ----
check('valid manifest -> prefixed keys, absolute src, allowlisted opts through', () => {
  manifest({
    pattern: '^test_.*\\.js$',
    members: [
      { file: 'test_a.js', timeoutMs: 12345, serial: true },
      { file: 'test_b.js', image: true },
    ],
    exclude: [],
  });
  const r = load();
  assert.strictEqual(r.status, 'ok', JSON.stringify(r.errors || r));
  assert.strictEqual(r.prefix, 'gucos-packages');
  assert.deepStrictEqual(r.members, [{ file: 'test_a.js' }, { file: 'test_b.js' }]);
  const [a, b] = r.entries;
  assert.strictEqual(a.file, 'gucos-packages/test_a.js');
  assert.strictEqual(a.src, path.join(SIBT, 'test_a.js'));
  assert.strictEqual(a.timeoutMs, 12345);
  assert.strictEqual(a.serial, true);
  assert.strictEqual(b.image, true);
  assert.ok(r.pattern instanceof RegExp);
});

// ---- 5. worktree ccRoot resolves the MAIN clone's sibling ----
check('a linked-worktree ccRoot resolves the main clone\'s sibling', () => {
  mk('git/c-compiler/.git/worktrees/lane-t');
  const WT = mk('worktree/c-compiler/lane-t');
  w('worktree/c-compiler/lane-t/.git',
    'gitdir: ' + path.join(CC, '.git', 'worktrees', 'lane-t') + '\n');
  const r = loadSiblingTests({ ccRoot: WT, env: null });
  assert.strictEqual(r.status, 'ok', JSON.stringify(r));
  assert.strictEqual(r.root, SIB);
  assert.strictEqual(r.via, 'main-clone sibling');
});

// ---- suite-runner integration: real children, real summary ----
(async () => {
  const suiteDir = mk('suite/native');
  const sibDir = mk('suite/sibling');
  const artifactDir = path.join(tmp, 'suite/artifacts');
  const PATTERN = /^test_.*\.js$/;
  // The SAME basename on both sides — the collision the prefix exists to kill.
  w('suite/native/test_same.js', 'console.log("native");process.exit(0);\n');
  w('suite/sibling/test_same.js', 'console.log("sibling");process.exit(0);\n');
  const entryOf = (f) => ({ file: 'sib/' + f, src: path.join(sibDir, f) });
  const baseOpts = {
    name: 'sib-int', dir: suiteDir, artifactDir, jobs: 2, timeoutMs: 30000,
    evidence: { pattern: PATTERN, exclude: [], extra: [{ dir: sibDir, pattern: PATTERN, exclude: [], prefix: 'sib' }] },
  };

  await (async () => {
    const r = await runSuite([{ file: 'test_same.js' }, entryOf('test_same.js')], baseOpts);
    const sum = JSON.parse(fs.readFileSync(path.join(artifactDir, 'summary.json'), 'utf-8'));
    check('6. same-basename members coexist: two records, distinct keys', () => {
      assert.strictEqual(r.failed, 0, 'failed=' + r.failed);
      const keys = sum.results.map((x) => x.file).sort();
      assert.deepStrictEqual(keys, ['sib/test_same.js', 'test_same.js']);
    });
    check('6a. …and distinct per-file logs, each holding its own output', () => {
      const nat = fs.readFileSync(path.join(artifactDir, 'test_same.js.log'), 'utf-8');
      const sib = fs.readFileSync(path.join(artifactDir, 'sib_test_same.js.log'), 'utf-8');
      assert.ok(/native/.test(nat) && /sibling/.test(sib), 'logs crossed: ' + nat + ' / ' + sib);
    });
    check('8a. evidence covers BOTH sources when both ran', () => {
      assert.strictEqual(sum.evidence.expected, 2, JSON.stringify(sum.evidence));
      assert.strictEqual(sum.evidence.fresh, 2);
    });
  })();

  await (async () => {
    w('suite/sibling/test_red.js', 'process.exit(1);\n');
    const r = await runSuite([{ file: 'test_same.js' }, entryOf('test_same.js'), entryOf('test_red.js')], baseOpts);
    check('7. a failing sibling member fails the suite', () => {
      assert.ok(r.failed >= 1, 'failed=' + r.failed);
    });
    fs.rmSync(path.join(sibDir, 'test_red.js'));
  })();

  await (async () => {
    // The H3 trap control: the sibling file exists on disk (so evidence
    // EXPECTS it) but its entry is withheld (so it never runs). Fresh
    // artifact dir: a carried result must not satisfy the evidence check.
    const art2 = path.join(tmp, 'suite/artifacts2');
    const r = await runSuite([{ file: 'test_same.js' }],
      Object.assign({}, baseOpts, { artifactDir: art2 }));
    const sum = JSON.parse(fs.readFileSync(path.join(art2, 'summary.json'), 'utf-8'));
    check('8. an expected-but-never-run sibling member is an EVIDENCE failure', () => {
      assert.ok(r.failed >= 1, 'failed=' + r.failed + ' — the run was green while the sibling test never ran');
      assert.ok((sum.evidence.problems || []).some((p) => /sib\/test_same\.js.*NO per-file log/.test(p)),
        JSON.stringify(sum.evidence));
    });
  })();

  await (async () => {
    // Resume freshness stats entry.src (#455 extended): green pass, then
    // touch the sibling SOURCE newer than its log -> NOT resumed.
    const art3 = path.join(tmp, 'suite/artifacts3');
    const opts3 = Object.assign({}, baseOpts, { artifactDir: art3 });
    await runSuite([entryOf('test_same.js')], opts3);
    const logP = path.join(art3, 'sib_test_same.js.log');
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(logP, past, past);   // age the log so the fresh source wins
    fs.utimesSync(path.join(sibDir, 'test_same.js'), new Date(), new Date());
    const r = await runSuite([entryOf('test_same.js')], Object.assign({}, opts3, { resume: true }));
    const sum = JSON.parse(fs.readFileSync(path.join(art3, 'summary.json'), 'utf-8'));
    check('9. an edited sibling source is re-executed under --resume, never resumed', () => {
      assert.strictEqual(r.resumed, 0, 'resumed=' + r.resumed);
      const rec = sum.results.find((x) => x.file === 'sib/test_same.js');
      assert.ok(rec && !rec.resumed, JSON.stringify(rec));
      assert.strictEqual(sum.runs[sum.runs.length - 1].executed, 1);
    });
  })();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
