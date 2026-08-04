#!/usr/bin/env node
// libgit2 as a gucman srclib package, headless (ticket #473). The acceptance
// is jku's sentence — "gucman install libgit2, then an in-OS cc links against
// libgit2, exactly the way libpng already works today" — so the test drives
// the WHOLE loop on the MINIMAL image, not a folded fixture:
//
//   - the minimal image really is minimal: no /usr/include/git2.h, no
//     /usr/src/git2 (the package folds only into the fat image)
//   - `gucman install libgit2` plants the two srclib symlink farms:
//     /usr/local/include/{git2.h, git2, git2_srclib.h} per top-level entry of
//     the payload's include dir, and /usr/local/src/git2 for the one require
//     namespace, creating both tier dirs (absent on a virgin root)
//   - the in-OS `cc` builds a REAL git program against them with NO -I and NO
//     explicit TU list: <git2.h> resolves through the header tier, and
//     <git2_srclib.h>'s __require_source block pulls ~190 translation units
//     through /usr/local/src/git2. Every one of those TUs resolves its own
//     internal headers SAME-DIR, through the generated forwarders — the
//     package carries no compiler flags because a srclib section cannot
//     (validateSrclibShape accepts only `include` and `src`).
//   - the built binary RUNS and writes a real repository: init → config →
//     blob → index → tree → commit → revparse → revwalk, then re-opens the
//     repo from scratch and walks it again. Every write goes through
//     libgit2's lock_file, whose 64 KiB GIT_BUFSIZE_FILEIO stack buffer
//     underflows the default 1-page WASM stack — so this leg is also the
//     proof that missing_stubs.c's __minstack(1048576) survives BOTH the
//     in-OS compile path and the OS spawn path (a host build proves neither).
//   - the install persists across a reboot: the SAME binary, spawned from a
//     second boot of the same image, opens the repo written by the first
//     — and the planted tiers are still there
//   - `gucman remove libgit2` replays the DB in reverse: every include-tier
//     link, the namespace link, /opt/libgit2 and the DB record are gone, and
//     the tier dirs gucman created are rmdir'd
//
// FAILS LOUD on the unconverted tree: with no packages/libgit2.json there is
// nothing for mkpkg to build, and before the config-header fold the in-OS
// compile dies on PCRE2_CODE_UNIT_WIDTH — the flags it needed cannot ride a
// srclib package.
//
// Run: node tests/kernel/test_gucman_libgit2_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* The consumer program: two #includes, no -I, no TU list. Deliberately a
 * WRITING workload — a repo that `git` itself would accept — because the
 * write paths are the ones that need the 1 MiB stack. */
const PROG = [
  '#include <stdio.h>',
  '#include <string.h>',
  '#include <git2.h>',
  '#include <git2_srclib.h>',
  '',
  'static int fail(const char *what) {',
  '    const git_error *e = git_error_last();',
  '    printf("FAIL %s: %s\\n", what, e && e->message ? e->message : "(no message)");',
  '    return 1;',
  '}',
  '',
  'int main(int argc, char **argv) {',
  '    const char *dir = argc > 1 ? argv[1] : "/root/demo";',
  '    int reopen = (argc > 2 && strcmp(argv[2], "reopen") == 0);',
  '    char wt[512];',
  '    git_repository *repo = NULL;',
  '    git_oid commit_oid;',
  '    printf("LIBGIT2 %s\\n", LIBGIT2_VERSION);',
  '    if (git_libgit2_init() < 0) return fail("init");',
  '',
  '    if (reopen) {',
  '        if (git_repository_open(&repo, dir) < 0) return fail("open");',
  '    } else {',
  '        if (git_repository_init(&repo, dir, 0) < 0) return fail("repo_init");',
  '        git_config *cfg = NULL;',
  '        if (git_repository_config(&cfg, repo) < 0) return fail("config");',
  '        git_config_set_string(cfg, "user.name", "gucOS");',
  '        git_config_set_string(cfg, "user.email", "gucos@example.com");',
  '        git_config_free(cfg);',
  '',
  '        snprintf(wt, sizeof wt, "%s/hello.txt", dir);',
  '        FILE *f = fopen(wt, "w");',
  '        if (!f) { printf("FAIL fopen\\n"); return 1; }',
  '        fputs("hello from gucOS\\n", f);',
  '        fclose(f);',
  '',
  '        git_index *idx = NULL;',
  '        if (git_repository_index(&idx, repo) < 0) return fail("index");',
  '        if (git_index_add_bypath(idx, "hello.txt") < 0) return fail("index_add");',
  '        if (git_index_write(idx) < 0) return fail("index_write");',
  '        git_oid tree_oid;',
  '        if (git_index_write_tree(&tree_oid, idx) < 0) return fail("write_tree");',
  '        git_index_free(idx);',
  '',
  '        git_tree *tree = NULL;',
  '        if (git_tree_lookup(&tree, repo, &tree_oid) < 0) return fail("tree_lookup");',
  '        git_signature *sig = NULL;',
  '        if (git_signature_new(&sig, "gucOS", "gucos@example.com", 1234567890, 0) < 0)',
  '            return fail("signature");',
  '        if (git_commit_create(&commit_oid, repo, "HEAD", sig, sig, NULL,',
  '                              "first commit\\n", tree, 0, NULL) < 0)',
  '            return fail("commit_create");',
  '        git_signature_free(sig);',
  '        git_tree_free(tree);',
  '    }',
  '',
  '    git_object *head = NULL;',
  '    if (git_revparse_single(&head, repo, "HEAD") < 0) return fail("revparse");',
  '    char oidstr[GIT_OID_SHA1_HEXSIZE + 1];',
  '    git_oid_tostr(oidstr, sizeof oidstr, git_object_id(head));',
  '    git_object_free(head);',
  '',
  '    git_revwalk *walk = NULL;',
  '    if (git_revwalk_new(&walk, repo) < 0) return fail("revwalk");',
  '    if (git_revwalk_push_head(walk) < 0) return fail("push_head");',
  '    git_oid step;',
  '    int n = 0;',
  '    while (git_revwalk_next(&step, walk) == 0) n++;',
  '    git_revwalk_free(walk);',
  '',
  '    printf("HEAD %s\\n", oidstr);',
  '    printf("WALKED %d\\n", n);',
  '    git_repository_free(repo);',
  '    git_libgit2_shutdown();',
  '    printf("GITDEMO-DONE\\n");',
  '    return 0;',
  '}',
];

async function main() {
  /* Host-side, before any bake: the require block in git2_srclib.h is
   * GENERATED from vendor/libgit2/bin.json's source list, and a TU added to
   * one but not the other links silently short. `--check` is the cheap guard
   * that the two agree; it costs no build. */
  {
    const cp = require('child_process');
    const r = cp.spawnSync(process.execPath,
      [path.join(ROOT, 'tools', 'mkgit2srclib.js'), '--check'],
      { encoding: 'utf8' });
    check('git2_srclib.h is in sync with vendor/libgit2/bin.json',
      r.status === 0, (r.stdout || '') + (r.stderr || ''));
  }

  const repo = ensurePackages(['libgit2']);
  const idx = repo.index;
  const MIN = ensureMinimalImage();
  const { dir: tmp, image } = freshImage('os-gucman-libgit2-');
  fs.copyFileSync(MIN, image);   // copy mtime = now -> input-fresh at boot

  const port = await startServer(repo.dir);
  console.log(`[libgit2] repo :${port} (payload ${(idx.packages.libgit2.payload.size / (1 << 20)).toFixed(1)} MiB)`);

  const BOOT = { image, args: ['--packages=none'], timeout: 1800000 };

  /* ---- session A: minimal proof, install, compile, run ---- */
  const scriptA = [
    'echo ==minimal',
    'test ! -e /usr/include/git2.h && echo NO-BAKED-HEADER',
    'test ! -e /usr/src/git2 && echo NO-BAKED-SRC',
    'test ! -e /usr/local/include/git2.h && echo NO-LOCAL-HEADER',
    'echo ==install',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${port} > /etc/gucman/repos`,
    'gucman install libgit2; echo RC=$?',
    'readlink /usr/local/include/git2.h',
    'readlink /usr/local/include/git2',
    'readlink /usr/local/include/git2_srclib.h',
    'readlink /usr/local/src/git2',
    'test -f /usr/local/src/git2/src/libgit2/commit.c && echo SRC-TREE-OK',
    'test -f /usr/local/src/git2/deps/pcre2/config.h && echo PCRE2-CONFIG-OK',
    'test ! -e /opt/.staging.libgit2 && echo NO-STAGING',
    'echo ==info',
    'gucman info libgit2',
    'echo ==compile',
    "cat > /root/gitdemo.c << 'EOF'",
    ...PROG,
    'EOF',
    'cd /root && cc gitdemo.c -o gitdemo; echo CCRC=$?',
    'test -f /root/gitdemo && echo BINARY-OK',
    'echo ==run',
    'cd /root && ./gitdemo /root/demo; echo RUNRC=$?',
    'echo ==repo',
    'test -d /root/demo/.git && echo GIT-DIR-OK',
    'test -f /root/demo/.git/HEAD && echo HEAD-FILE-OK',
    'cat /root/demo/.git/HEAD',
    'find /root/demo/.git/objects -type f | wc -l',
    'echo ==done',
    'exit',
  ];
  const a = driveBoot(scriptA, BOOT);
  const outA = String(a.stdout || '');
  if (process.env.GUCMAN_DEBUG)
    fs.writeFileSync('/tmp/libgit2-e2e-A.log', outA + '\n===STDERR===\n' + String(a.stderr || ''));

  const minimal = section(outA, 'minimal');
  check('minimal image has no baked /usr/include/git2.h', minimal.includes('NO-BAKED-HEADER'), minimal);
  check('minimal image has no baked /usr/src/git2 namespace', minimal.includes('NO-BAKED-SRC'), minimal);
  check('virgin root has no /usr/local/include/git2.h', minimal.includes('NO-LOCAL-HEADER'), minimal);

  const inst = section(outA, 'install');
  check('install succeeds (exit 0)', inst.includes('RC=0'), inst);
  check('installed banner names the version',
    inst.includes(`installed libgit2 ${idx.packages.libgit2.version}`), inst);
  check('/usr/local/include/git2.h -> the payload header',
    inst.split('\n').some((l) => l.trim() === '/opt/libgit2/include/git2.h'), inst);
  check('/usr/local/include/git2 -> the payload header TREE (one link, whole dir)',
    inst.split('\n').some((l) => l.trim() === '/opt/libgit2/include/git2'), inst);
  check('/usr/local/include/git2_srclib.h -> the generated require block',
    inst.split('\n').some((l) => l.trim() === '/opt/libgit2/include/git2_srclib.h'), inst);
  check('/usr/local/src/git2 -> the payload source root',
    inst.split('\n').some((l) => l.trim() === '/opt/libgit2/src'), inst);
  check('the source tree really landed (src/libgit2/commit.c)', inst.includes('SRC-TREE-OK'), inst);
  check('the PCRE2 config header rode the payload (no compilerArgs needed)',
    inst.includes('PCRE2-CONFIG-OK'), inst);
  check('staging dir cleaned after install', inst.includes('NO-STAGING'), inst);

  const info = section(outA, 'info');
  check('gucman info lists the include entries', /include entries:/.test(info), info);
  check('gucman info lists the git2 source namespace',
    /source namespaces:/.test(info) && info.includes('/usr/local/src/git2'), info);

  const comp = section(outA, 'compile');
  check('in-OS cc compiles + links libgit2 with NO -I and NO TU list',
    comp.includes('CCRC=0'), comp.slice(-2000));
  check('the linked binary exists', comp.includes('BINARY-OK'), comp.slice(-500));

  const run = section(outA, 'run');
  check('the binary runs to completion (exit 0)', run.includes('RUNRC=0'), run);
  check('it reports the vendored libgit2 version', run.includes('LIBGIT2 1.9.0'), run);
  check('it wrote a commit and walked it (1 commit)', run.includes('WALKED 1'), run);
  check('no libgit2 call failed', !run.includes('FAIL '), run);
  check('the program finished after the write paths (the 1 MiB __minstack held)',
    run.includes('GITDEMO-DONE'), run);
  const headOid = (/^HEAD ([0-9a-f]{40})$/m.exec(run) || [])[1];
  check('HEAD resolves to a full sha1 oid', !!headOid, run);

  const rep = section(outA, 'repo');
  check('a real .git directory landed on the OS filesystem', rep.includes('GIT-DIR-OK'), rep);
  check('.git/HEAD exists', rep.includes('HEAD-FILE-OK'), rep);
  check('.git/HEAD names the default branch',
    /ref: refs\/heads\/(main|master)/.test(rep), rep);
  // blob + tree + commit, each a loose object: the ODB really wrote through.
  const objs = parseInt((/^(\d+)$/m.exec(rep.split('\n').map((l) => l.trim()).join('\n')) || [])[1], 10);
  check('the ODB wrote at least 3 loose objects (blob, tree, commit)',
    objs >= 3, rep);

  /* ---- session B: persistence across reboot, then exact removal ---- */
  const scriptB = [
    'echo ==persist',
    'test -e /var/lib/gucman/libgit2.json && echo DB-PERSISTS',
    'test -e /opt/libgit2/src/src/util/str.c && echo OPT-PERSISTS',
    'readlink /usr/local/src/git2',
    'echo ==rerun',
    // The SAME binary from session A, spawned fresh: it re-opens the repo the
    // first boot wrote. Nothing recompiles — this is the OS spawn path.
    'cd /root && ./gitdemo /root/demo reopen; echo RC=$?',
    'echo ==remove',
    'gucman remove libgit2; echo RC=$?',
    'test ! -e /opt/libgit2 && echo OPT-GONE',
    'test ! -e /usr/local/include/git2.h && echo HDR-GONE',
    'test ! -e /usr/local/include/git2 && echo TREE-GONE',
    'test ! -e /usr/local/include/git2_srclib.h && echo SRCLIB-GONE',
    'test ! -e /usr/local/src/git2 && echo NS-GONE',
    'test ! -e /var/lib/gucman/libgit2.json && echo DB-GONE',
    'test ! -e /usr/local/src && echo SRCDIR-RMDIRD',
    'echo ==aftermath',
    // The library is gone, so the SAME compile must now fail loudly on the
    // missing header — the red control for the whole plant.
    // NOT a pipeline: `cc ... | head` would report head's status, so a
    // failing compile would read as CCRC=0. Redirect, then print.
    'cd /root && cc gitdemo.c -o gitdemo2 > /root/cc.err 2>&1; echo CCRC=$?',
    'head -3 /root/cc.err',
    'echo ==done',
    'exit',
  ];
  const b = driveBoot(scriptB, BOOT);
  const outB = String(b.stdout || '');
  if (process.env.GUCMAN_DEBUG)
    fs.writeFileSync('/tmp/libgit2-e2e-B.log', outB + '\n===STDERR===\n' + String(b.stderr || ''));

  const persist = section(outB, 'persist');
  check('install persists across reboot (DB record)', persist.includes('DB-PERSISTS'), persist);
  check('install persists across reboot (/opt payload)', persist.includes('OPT-PERSISTS'), persist);
  check('the source namespace link survives the reboot',
    persist.split('\n').some((l) => l.trim() === '/opt/libgit2/src'), persist);

  const rerun = section(outB, 'rerun');
  check('the already-built binary re-opens the repo after a reboot',
    rerun.includes('RC=0') && rerun.includes('GITDEMO-DONE'), rerun);
  check('the reopened repo still walks to the same HEAD',
    !!headOid && rerun.includes('HEAD ' + headOid), rerun);

  const rem = section(outB, 'remove');
  check('remove succeeds (exit 0)', rem.includes('RC=0'), rem);
  check('/opt/libgit2 fully removed', rem.includes('OPT-GONE'), rem);
  check('include-tier link removed (git2.h)', rem.includes('HDR-GONE'), rem);
  check('include-tier link removed (git2/ tree)', rem.includes('TREE-GONE'), rem);
  check('include-tier link removed (git2_srclib.h)', rem.includes('SRCLIB-GONE'), rem);
  check('source-namespace link removed', rem.includes('NS-GONE'), rem);
  check('DB record removed', rem.includes('DB-GONE'), rem);
  check('the /usr/local/src tier dir gucman created is rmdir\'d', rem.includes('SRCDIR-RMDIRD'), rem);

  const after = section(outB, 'aftermath');
  check('after removal the same compile FAILS on the missing header (red control)',
    after.includes('CCRC=1') && /git2\.h/.test(after), after);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\nlibgit2 srclib e2e: ${failures} FAILED` : '\nlibgit2 srclib e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
