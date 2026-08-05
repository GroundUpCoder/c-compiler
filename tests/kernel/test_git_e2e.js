#!/usr/bin/env node
// gucOS git acceptance, headless (ticket #474): `gucman install git` plants a
// WORKING git CLI, and the CLI behaves like git rather than like the fixture
// it grew out of.
//
// Two things are on trial here and they fail independently:
//
//   1. THE PACKAGE. On the MINIMAL image (boot.js --packages=none) there is
//      no git at all; install plants /opt/git + the /usr/local/bin
//      symlink + the DB record; the install survives a REBOOT (it lives on
//      the writable root volume, not in the sealed blob); remove replays the
//      record in reverse and leaves nothing behind.
//
//   2. THE CLI. libgit2 has to actually work inside gucOS — zlib-inflating
//      loose objects, hashing them, walking a real commit graph off BlockFS
//      — and the repository has to be DISCOVERED from the current directory
//      the way git discovers it. The old fixture took the repo path as
//      argv[1], which is the one thing guaranteed to feel wrong to every
//      human and every agent that has ever used git.
//
// The repo under test is the deterministic fixture the `fakegit` category
// already uses (tests/fakegit/make-fixture.sh — fixed author/committer/date/
// tz, host git config masked, so its object ids are byte-stable anywhere).
// It reaches gucOS as a tarball over a second serve.js, fetched in-OS with
// /bin/curl and unpacked with /bin/tar — i.e. through the shipped tools, not
// through a test-only seam.
//
// The strong assertion is DIFFERENTIAL, not a hand-written golden: the
// in-OS `git status` output must equal tests/fakegit/status/expected.txt
// byte-for-byte, and the in-OS object ids must equal what the HOST's real
// git reports for the same fixture. A same-bytes answer from a wasm binary
// on BlockFS and from /usr/bin/git on APFS is what "git works" means.
//
// FAILS LOUD on the unconverted tree: pre-#474 there is no packages/git.json
// for mkpkg to build, and the CLI would need a repo-path argument the script
// never passes.
//
// Run: node tests/kernel/test_git_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');
const { mkdtempOwned } = require('../lib/harness-temp.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// Lines come back through a tty line discipline, so compare trimmed.
function lines(sec) {
  return String(sec).split('\n').map((l) => l.trim()).filter((l) => l !== '');
}
function has(sec, line) { return lines(sec).includes(line); }

// The fixture repo, tarred for delivery. Built with the SAME script the
// fakegit category uses — one fixture definition, two consumers.
function buildFixtureTarball(dir) {
  const repo = path.join(dir, 'repo');
  const mk = cp.spawnSync('sh', [path.join(ROOT, 'tests', 'fakegit', 'make-fixture.sh'), repo],
    { encoding: 'utf-8', timeout: 60000 });
  if (mk.status !== 0) throw new Error('make-fixture.sh failed:\n' + (mk.stderr || ''));
  const tgz = path.join(dir, 'repo.tar.gz');
  const tar = cp.spawnSync('tar', ['-czf', tgz, '-C', dir, 'repo'],
    { encoding: 'utf-8', timeout: 60000 });
  if (tar.status !== 0) throw new Error('tar failed:\n' + (tar.stderr || ''));
  return { repo, tgz, sha: crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex') };
}

// What the HOST's real git says about the fixture — the differential oracle.
function hostGit(repo, args) {
  const r = cp.spawnSync('git', ['-C', repo, ...args], { encoding: 'utf-8', timeout: 30000 });
  if (r.status !== 0) throw new Error('host git ' + args.join(' ') + ' failed:\n' + (r.stderr || ''));
  return r.stdout.trim();
}

async function main() {
  const repoIdx = ensurePackages(['git']);
  const idx = repoIdx.index;
  const MIN = ensureMinimalImage();
  const { dir: tmp, image } = freshImage('os-git-');
  fs.copyFileSync(MIN, image);   // copy mtime = now -> input-fresh at boot

  // The fixture + its host-side truth.
  const fxDir = mkdtempOwned('os-git-fixture-');
  const fx = buildFixtureTarball(fxDir);
  const headSha = hostGit(fx.repo, ['rev-parse', 'HEAD']);
  const parentSha = hostGit(fx.repo, ['rev-parse', 'HEAD^']);
  const treeSha = hostGit(fx.repo, ['rev-parse', 'HEAD^{tree}']);
  const headRef = hostGit(fx.repo, ['symbolic-ref', 'HEAD']);   // refs/heads/main
  const statusGolden = fs.readFileSync(
    path.join(ROOT, 'tests', 'fakegit', 'status', 'expected.txt'), 'utf-8');

  const pkgPort = await startServer(repoIdx.dir);
  const fxPort = await startServer(fxDir);
  console.log(`[git] package repo :${pkgPort}, fixture repo :${fxPort} ` +
    `(payload ${(idx.packages.git.payload.size / (1 << 20)).toFixed(1)} MiB, HEAD ${headSha.slice(0, 12)})`);

  /* ---------------- session 1: install, then use it ---------------- */
  const script = [
    'echo ==minimal',
    'test ! -e /usr/local/bin/git && echo NO-BAKED-BIN',
    'test ! -e /opt/git && echo NO-BAKED-OPT',
    'which git || echo NOT-ON-PATH',

    'echo ==install',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${pkgPort} > /etc/gucman/repos`,
    'gucman install git; echo RC=$?',
    'readlink /usr/local/bin/git',
    'test -x /opt/git/git && echo OPT-BINARY-OK',
    'test ! -e /opt/.staging.git && echo NO-STAGING',

    'echo ==db',
    'cat /var/lib/gucman/git.json',
    'gucman list',

    // The CLI is on PATH and runs before any repo exists — `--version` must
    // not need one (git's own behaviour).
    'echo ==version',
    'cd /',
    'git --version; echo RC=$?',

    'echo ==fetch',
    `curl -sfL -o /root/repo.tar.gz http://127.0.0.1:${fxPort}/repo.tar.gz; echo RC=$?`,
    'sha256sum /root/repo.tar.gz',
    'tar -xzf /root/repo.tar.gz -C /root; echo RC=$?',
    'test -d /root/repo/.git && echo REPO-OK',

    // Discovery, depth 0: no path argument at all.
    'echo ==root',
    'cd /root/repo',
    'git rev-parse HEAD; echo RC=$?',
    'git ls-tree',

    // Discovery from a SUBDIRECTORY — the acceptance criterion. `status`
    // doubles as proof the discovered WORKDIR ROOT (not the cwd) anchors the
    // output paths: from src/ the untracked file still prints as notes.txt.
    'echo ==subdir',
    'cd /root/repo/src',
    'git rev-parse HEAD',
    'git rev-parse HEAD^',
    'echo ==subdir-status',
    'git status',
    'echo ==subdir-end',

    // Two levels down, and a real object read: log inflates the commit
    // objects out of .git/objects through zlib on BlockFS.
    'echo ==deep',
    'mkdir -p /root/repo/src/deep/deeper',
    'cd /root/repo/src/deep/deeper',
    'git log -n 1',

    // -C, git's own spelling, from somewhere else entirely.
    'echo ==dashC',
    'cd /',
    'git -C /root/repo/docs rev-parse HEAD',
    'echo ==cattree',
    `git -C /root/repo cat-file -p ${treeSha}`,
    'echo ==cattree-end',

    // LINKED-WORKTREE discovery (#480): `.git` as a regular FILE containing a
    // `gitdir:` pointer, the layout `git worktree add` produces. The shipped
    // git is read-only, so the worktree is constructed by hand with exactly
    // the files libgit2's is_valid_repository_path demands (HEAD + commondir
    // in the private dir; objects/ + refs/ reached through commondir), plus
    // the gitdir back-pointer real git writes. commondir holds the canonical
    // relative `../..` — libgit2 normalises that join in its own path math,
    // so kfs's lexical `..` collapse is never in the loop (and would agree
    // anyway: no symlinks are involved). HEAD is the `ref:` form, so
    // resolving it exercises the commondir hop for refs, and HEAD^ inflates
    // the commit object out of the COMMON object store.
    'echo ==worktree',
    'mkdir -p /root/wt/a/b',
    'echo "gitdir: /root/repo/.git/worktrees/wt" > /root/wt/.git',
    'mkdir -p /root/repo/.git/worktrees/wt',
    'echo "../.." > /root/repo/.git/worktrees/wt/commondir',
    `echo "ref: ${headRef}" > /root/repo/.git/worktrees/wt/HEAD`,
    'echo "/root/wt/.git" > /root/repo/.git/worktrees/wt/gitdir',
    'test -f /root/wt/.git && test ! -d /root/wt/.git && echo GITFILE-IS-FILE',
    'cd /root/wt/a/b',
    'git rev-parse HEAD; echo RC=$?',
    'git rev-parse HEAD^',
    'git log -n 1',
    'echo ==worktree-end',

    // Outside any repo: git's exact fatal, and a non-zero status. `cd /`,
    // not /tmp: a cd that FAILS leaves the cwd inside the repo and turns
    // this leg green for the wrong reason.
    'echo ==norepo',
    'cd /',
    'git log; echo RC=$?',

    // Read-only honesty: a real git command that is not implemented must say
    // so, not read as "git is broken".
    'echo ==readonly',
    'cd /root/repo',
    'git commit -m x; echo RC=$?',
    'git wibble; echo RC=$?',
    'echo ==done',
  ];
  const r = driveBoot(script, { image, args: ['--packages=none'], timeout: 600000 });
  const out = String(r.stdout || '');
  const err = String(r.stderr || '');
  if (process.env.GIT_E2E_DEBUG) {
    fs.writeFileSync('/tmp/git-e2e-debug.log', out + '\n===STDERR===\n' + err);
  }

  const minimal = section(out, 'minimal');
  check('minimal image ships no git binary', has(minimal, 'NO-BAKED-BIN'), minimal);
  check('minimal image ships no /opt/git', has(minimal, 'NO-BAKED-OPT'), minimal);
  check('git is not on PATH before install', has(minimal, 'NOT-ON-PATH'), minimal);

  const inst = section(out, 'install');
  check('install succeeds (exit 0)', has(inst, 'RC=0'), inst);
  check('installed banner names the version',
    inst.includes(`installed git ${idx.packages.git.version}`), inst);
  check('/usr/local/bin/git -> /opt/git/git',
    has(inst, '/opt/git/git'), inst);
  check('/opt/git/git is executable', has(inst, 'OPT-BINARY-OK'), inst);
  check('staging dir cleaned after install', has(inst, 'NO-STAGING'), inst);

  const db = section(out, 'db');
  check('DB records the payload sha256', db.includes(idx.packages.git.payload.sha256), db.slice(0, 400));
  check('gucman list shows git (aligned human row)',
    new RegExp('^git\\s+' + idx.packages.git.version.replace(/\./g, '\\.') + '\\s', 'm').test(db), db);

  const ver = section(out, 'version');
  check('git --version works outside any repository',
    /git version \S+ \(libgit2 \S+\)/.test(ver) && has(ver, 'RC=0'), ver);

  const fetch = section(out, 'fetch');
  check('fixture tarball fetched in-OS with curl', fetch.includes('RC=0'), fetch);
  check('fetched tarball is byte-exact (in-OS sha256 == host sha256)',
    fetch.includes(fx.sha), fetch);
  check('tarball unpacked and .git present', has(fetch, 'REPO-OK'), fetch);

  // ---- the CLI, against the host's real git ----
  const root = section(out, 'root');
  check('DISCOVERY at the repo root: bare `git rev-parse HEAD` resolves HEAD',
    has(root, headSha), root);
  check('rev-parse exits 0 with no path argument', has(root, 'RC=0'), root);
  check('ls-tree at the root lists the HEAD tree entries',
    lines(root).some((l) => /^\d{6} blob [0-9a-f]{40}\s+README\.md$/.test(l)) &&
    lines(root).some((l) => /^\d{6} tree [0-9a-f]{40}\s+src$/.test(l)), root);

  const sub = section(out, 'subdir');
  check('DISCOVERY from a SUBDIRECTORY: HEAD resolves to the same id as host git',
    has(sub, headSha), sub);
  check('DISCOVERY from a subdirectory: HEAD^ resolves to the same id as host git',
    has(sub, parentSha), sub);

  // Byte-for-byte against the committed golden — the same bytes the
  // host-built binary produces in the `fakegit` category, produced here from
  // a subdirectory inside gucOS. Only the tty's CR and the surrounding blank
  // lines are normalised; the LINES themselves are compared verbatim, so a
  // changed status letter or path still fails.
  const gotStatus = String(section(out, 'subdir-status')).replace(/\r/g, '')
    .split('\n').filter((l) => l !== '');
  const wantStatus = statusGolden.split('\n').filter((l) => l !== '');
  check('status from a subdirectory matches tests/fakegit/status/expected.txt verbatim',
    gotStatus.length === wantStatus.length && gotStatus.every((l, k) => l === wantStatus[k]),
    JSON.stringify(gotStatus) + ' vs ' + JSON.stringify(wantStatus));

  const deep = section(out, 'deep');
  check('DISCOVERY three levels down: log reads real objects off BlockFS',
    deep.includes('commit ' + headSha), deep);
  check('log renders the fixture commit message', deep.includes('c5: final README touch'), deep);

  const dashC = section(out, 'dashC');
  check('-C <subdir> resolves the same HEAD', has(dashC, headSha), dashC);

  // The second differential: `cat-file -p <tree>` on the HEAD tree must print
  // exactly what the host's real git prints for the same object id. This is
  // the one that exercises the object store end to end — zlib inflate, the
  // tree parser, and the id the entries name.
  const cattree = lines(section(out, 'cattree')).filter((l) => l !== '==cattree-end');
  const hostTree = hostGit(fx.repo, ['cat-file', '-p', treeSha])
    .split('\n').map((l) => l.trim()).filter(Boolean);
  check('cat-file -p <HEAD tree> matches host git line-for-line',
    cattree.length === hostTree.length && cattree.every((l, k) => l === hostTree[k]),
    JSON.stringify(cattree) + ' vs ' + JSON.stringify(hostTree));

  const wt = section(out, 'worktree');
  check('linked-worktree fixture: .git is a regular file, not a directory',
    has(wt, 'GITFILE-IS-FILE'), wt);
  check('LINKED-WORKTREE DISCOVERY two levels down: the gitdir: file resolves HEAD to the host id',
    has(wt, headSha) && has(wt, 'RC=0'), wt);
  check('linked worktree reads refs and objects through commondir: HEAD^ matches host git',
    has(wt, parentSha), wt);
  check('linked worktree log inflates the commit from the common object store',
    wt.includes('commit ' + headSha) && wt.includes('c5: final README touch'), wt);

  const norepo = section(out, 'norepo');
  check('outside a repository git exits non-zero', has(norepo, 'RC=1'), norepo);
  check("outside a repository git prints git's own fatal",
    (norepo + err).includes('fatal: not a git repository'), norepo);

  const ro = section(out, 'readonly');
  check('an unimplemented WRITE command says git is read-only, not "unknown"',
    (ro + err).includes("'commit' is a git command, but this build is read-only"), ro);
  check('a nonsense command is reported as not a git command',
    (ro + err).includes("'wibble' is not a git command"), ro);
  check('both refusals exit non-zero', lines(ro).filter((l) => l === 'RC=1').length === 2, ro);

  /* ---------------- session 2: reboot, then remove ---------------- */
  const script2 = [
    'echo ==persist',
    'test -x /opt/git/git && echo OPT-SURVIVED',
    'cd /root/repo/src',
    'git rev-parse HEAD; echo RC=$?',
    'echo ==remove',
    'gucman remove git; echo RC=$?',
    'test ! -e /opt/git && echo OPT-GONE',
    'test ! -e /usr/local/bin/git && echo LINK-GONE',
    'test ! -e /var/lib/gucman/git.json && echo DB-GONE',
    'which git || echo NOT-ON-PATH',
    'test -d /root/repo/.git && echo REPO-UNTOUCHED',
    'echo ==done',
  ];
  const r2 = driveBoot(script2, { image, args: ['--packages=none'], timeout: 420000 });
  const out2 = String(r2.stdout || '');
  if (process.env.GIT_E2E_DEBUG) {
    fs.appendFileSync('/tmp/git-e2e-debug.log', '\n===SESSION2===\n' + out2);
  }

  const persist = section(out2, 'persist');
  check('the install survives a reboot (root volume, not the blob)',
    has(persist, 'OPT-SURVIVED'), persist);
  check('git still discovers the repo from a subdirectory after reboot',
    has(persist, headSha) && has(persist, 'RC=0'), persist);

  const rem = section(out2, 'remove');
  check('remove succeeds (exit 0)', has(rem, 'RC=0'), rem);
  check('/opt/git removed', has(rem, 'OPT-GONE'), rem);
  check('bin symlink removed', has(rem, 'LINK-GONE'), rem);
  check('DB record removed', has(rem, 'DB-GONE'), rem);
  check('git really gone from PATH', has(rem, 'NOT-ON-PATH'), rem);
  check('removing the package leaves the user\'s repository alone',
    has(rem, 'REPO-UNTOUCHED'), rem);

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(fxDir, { recursive: true, force: true });
  console.log(failures ? `\ngit e2e: ${failures} FAILED` : '\ngit e2e: PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
