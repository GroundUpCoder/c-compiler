#!/usr/bin/env node
// gucOS git NETWORK leg, headless (ticket #478): clone / fetch / pull / push
// against a real git server — the far end of every request is the HOST'S
// REAL git (tests/kernel/lib/gitserve.js drives `git upload-pack` /
// `git receive-pack --stateless-rpc`), so every green here is a
// cross-implementation statement, not self-consistency.
//
// On trial:
//   1. CLONE over smart HTTP: the advertisement, the negotiation POST, a
//      multi-MB pack streamed through the kernel's backpressured http fd,
//      the indexer writing a repo real git accepts.
//   2. FETCH + FAST-FORWARD PULL: a second remote whose tip is ahead; pull
//      moves the branch and the working tree, and a second pull says
//      "Already up to date." A DIVERGED remote is a loud fatal (this git
//      does not merge), never a silent guess.
//   3. PUSH: an in-OS commit lands on the server and the SERVER-side repo
//      passes `git fsck --strict` with the pushed sha at the ref — the same
//      cross-implementation oracle #475 used, pointed at the network. A
//      non-fast-forward push exits non-zero with the refusal printed.
//   4. AUTH: a Basic-gated server refuses a credential-less clone with a
//      loud named fatal; credentials work from BOTH sources — embedded in
//      the URL and via ~/.git-credentials (git's own credential-store
//      format, read in-process).
//   5. REDIRECT: a 301'd repo clones — the subtransport re-bases follow-up
//      POSTs onto the post-redirect URL (the github http->https shape).
//
// FAILS LOUD on the pre-#478 tree: git_smart_subtransport_http was a
// `return -1` stub, so the very first clone errors.
//
// Run: node tests/kernel/test_git_net_e2e.js
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { driveBoot, freshImage, section } = require('./lib/drive.js');
const { ROOT, ensureMinimalImage, ensurePackages, startServer } = require('./lib/gucman.js');
const { spawnGitServer } = require('./lib/gitserve.js');
const { mkdtempOwned } = require('../lib/harness-temp.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
function lines(sec) {
  return String(sec).split('\n').map((l) => l.trim()).filter((l) => l !== '');
}
function has(sec, line) { return lines(sec).includes(line); }
function grep(sec, re) { return lines(sec).some((l) => re.test(l)); }

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Host Author', GIT_AUTHOR_EMAIL: 'author@net.test',
  GIT_COMMITTER_NAME: 'Host Author', GIT_COMMITTER_EMAIL: 'author@net.test',
};
function git(cwd, args, input) {
  const r = cp.spawnSync('git', args, { cwd, input,
    env: Object.assign({}, process.env, GIT_ENV),
    encoding: input === undefined ? 'utf-8' : undefined,
    maxBuffer: 256 * 1024 * 1024, timeout: 60000 });
  if (r.status !== 0) {
    throw new Error('host git ' + args.join(' ') + ' failed:\n' + (r.stderr || ''));
  }
  return typeof r.stdout === 'string' ? r.stdout.trim() : r.stdout;
}

async function main() {
  const repoIdx = ensurePackages(['git']);
  const idx = repoIdx.index;
  const MIN = ensureMinimalImage();
  const { image } = freshImage('os-gitnet-');
  fs.copyFileSync(MIN, image);

  // ---- host-side world ----
  const tmp = mkdtempOwned('os-gitnet-');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  git(tmp, ['init', '-q', '-b', 'main', work]);
  fs.writeFileSync(path.join(work, 'readme.txt'), 'hello from the host\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'c1: seed']);
  const c1 = git(work, ['rev-parse', 'HEAD']);

  // old.git: a bare at C1 — the clone origin AND the push target.
  const oldRepo = path.join(tmp, 'old.git');
  git(tmp, ['clone', '-q', '--bare', work, oldRepo]);

  // C2 adds a ~2 MiB random blob: the clone/pull of repo.git moves a real
  // multi-MB pack through the kernel http fd's backpressure.
  fs.writeFileSync(path.join(work, 'big.bin'), crypto.randomBytes(2 * 1024 * 1024));
  fs.writeFileSync(path.join(work, 'second.txt'), 'ahead of the clone\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'c2: ahead']);
  const c2 = git(work, ['rev-parse', 'HEAD']);
  const upRepo = path.join(tmp, 'repo.git');
  git(tmp, ['clone', '-q', '--bare', work, upRepo]);

  // diverged.git: an UNRELATED root commit on main — any push to it is
  // non-fast-forward by construction.
  const divWork = path.join(tmp, 'divwork');
  fs.mkdirSync(divWork);
  git(tmp, ['init', '-q', '-b', 'main', divWork]);
  fs.writeFileSync(path.join(divWork, 'other.txt'), 'unrelated history\n');
  git(divWork, ['add', '-A']);
  git(divWork, ['commit', '-q', '-m', 'd1: unrelated']);
  const divRepo = path.join(tmp, 'diverged.git');
  git(tmp, ['clone', '-q', '--bare', divWork, divRepo]);
  git(divRepo, ['config', 'receive.denyNonFastForwards', 'true']);

  // auth.git: a bare at C1 behind Basic auth (its own server below).
  const authRepo = path.join(tmp, 'auth.git');
  git(tmp, ['clone', '-q', '--bare', oldRepo, authRepo]);

  // 🔴 CHILD processes, not in-process servers: driveBoot is spawnSync, so
  // this test's own event loop is dead for the whole boot — an in-process
  // server would answer nothing and every clone would ride the headers
  // deadline into ETIMEDOUT (measured on the first cut of this test).
  const gs = await spawnGitServer({
    repos: { '/old.git': oldRepo, '/repo.git': upRepo, '/diverged.git': divRepo },
    redirects: { '/moved.git': '/repo.git' },
  });
  const AUTH = { user: 'gucdev', pass: 'tok-secret-478' };
  const ags = await spawnGitServer({ repos: { '/auth.git': authRepo }, auth: AUTH });
  const pkgPort = await startServer(repoIdx.dir);
  console.log(`[gitnet] git server :${gs.port}, auth server :${ags.port}, packages :${pkgPort}`
    + ` (c1 ${c1.slice(0, 12)}, c2 ${c2.slice(0, 12)})`);

  const U = `http://127.0.0.1:${gs.port}`;
  const AU = `http://127.0.0.1:${ags.port}`;

  const script = [
    'echo ==install',
    'mkdir -p /etc/gucman',
    `echo http://127.0.0.1:${pkgPort} > /etc/gucman/repos`,
    'gucman install git; echo RC=$?',

    // ---- 1. clone ----
    'echo ==clone',
    'cd /root',
    `git clone ${U}/old.git; echo RC=$?`,
    'cd /root/old && git rev-parse HEAD',
    'cat readme.txt',
    'git remote -v',

    // ---- 2. fetch + fast-forward pull from a second, ahead remote ----
    'echo ==pull',
    `git remote add upstream ${U}/repo.git; echo RC=$?`,
    'git fetch upstream; echo RC=$?',
    'git rev-parse upstream/main',
    'git pull upstream; echo RC=$?',
    'git rev-parse HEAD',
    'cat second.txt',
    'sha256sum big.bin',
    'echo ==pull2',
    'git pull upstream; echo RC=$?',

    // ---- 3. push: an in-OS commit lands on the server ----
    'echo ==push',
    'git config user.name "GucOS Dev"',
    'git config user.email dev@gucos.test',
    'echo pushed-from-gucos > pushed.txt',
    'git add pushed.txt',
    'git commit -m "c3: pushed from inside gucOS"; echo RC=$?',
    'git rev-parse HEAD',
    'git push origin main; echo RC=$?',

    // non-fast-forward: loud refusal, nonzero exit
    'echo ==pushreject',
    `git remote add div ${U}/diverged.git`,
    'git push div refs/heads/main:refs/heads/main; echo RC=$?',

    // ---- 4. auth ----
    'echo ==noauth',
    'cd /root',
    `git clone ${AU}/auth.git noauth; echo RC=$?`,
    'echo ==authurl',
    `git clone http://${AUTH.user}:${AUTH.pass}@127.0.0.1:${ags.port}/auth.git byurl; echo RC=$?`,
    'git -C byurl rev-parse HEAD',
    'echo ==authstore',
    `echo http://${AUTH.user}:${AUTH.pass}@127.0.0.1:${ags.port} > /root/.git-credentials`,
    `git clone ${AU}/auth.git bystore; echo RC=$?`,
    'cd /root/bystore',
    'git config user.name "GucOS Dev"',
    'git config user.email dev@gucos.test',
    'echo authed-push > authed.txt',
    'git add authed.txt && git commit -q -m "c4: authed push" && git rev-parse HEAD',
    'git push origin main; echo RC=$?',

    // ---- 5. redirect ----
    'echo ==redirect',
    'cd /root',
    `git clone ${U}/moved.git redirected; echo RC=$?`,
    'git -C redirected rev-parse HEAD',

    'echo ==done',
  ];

  const r = driveBoot(script, { image, args: ['--packages=none'], timeout: 900000 });
  const out = String(r.stdout || '');
  // In-OS fd 2 comes back on boot.js's stderr, so error TEXT lives here while
  // the ==section markers (stdout) order the run — message assertions below
  // grep this whole stream for substrings unique to their leg.
  const errOut = String(r.stderr || '');
  if (process.env.GIT_NET_E2E_DEBUG) {
    fs.writeFileSync('/tmp/git-net-e2e-debug.log', out + '\n===STDERR===\n' + errOut);
  }

  const inst = section(out, 'install');
  check('gucman install git succeeds', has(inst, 'RC=0'), inst);

  // ---- clone ----
  const cl = section(out, 'clone');
  check('clone prints Cloning into and exits 0',
    grep(cl, /^Cloning into 'old'/) && has(cl, 'RC=0'), cl);
  check('cloned HEAD == host c1', has(cl, c1), cl);
  check('cloned working tree has the file content', has(cl, 'hello from the host'), cl);
  check('clone recorded origin', grep(cl, new RegExp('^origin\\s+' + U.replace(/[.:/]/g, '\\$&') + '/old\\.git \\(fetch\\)')), cl);

  // ---- fetch + pull ----
  const pull = section(out, 'pull');
  check('remote add + fetch upstream exit 0',
    lines(pull).filter((l) => l === 'RC=0').length >= 3, pull);
  check('fetch created refs/remotes/upstream/main at host c2', has(pull, c2), pull);
  check('pull fast-forwarded HEAD to c2',
    lines(pull).filter((l) => l === c2).length >= 2, pull);
  check('pull said Fast-forward', has(pull, 'Fast-forward'), pull);
  check('pulled working tree updated', has(pull, 'ahead of the clone'), pull);
  const hostBigSha = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(work, 'big.bin'))).digest('hex');
  check('multi-MB blob byte-exact after pull (in-OS sha256 == host sha256)',
    pull.includes(hostBigSha), pull.split('\n').filter((l) => /^[0-9a-f]{16}/.test(l)).join(','));
  const pull2 = section(out, 'pull2');
  check('second pull says Already up to date', has(pull2, 'Already up to date.') && has(pull2, 'RC=0'), pull2);

  // ---- push ----
  const push = section(out, 'push');
  check('in-OS commit + push exit 0',
    lines(push).filter((l) => l === 'RC=0').length >= 2, push);
  const c3 = lines(push).find((l) => /^[0-9a-f]{40}$/.test(l));
  check('in-OS commit produced a sha', !!c3, push);
  // The cross-implementation oracle: the SERVER-side bare repo, judged by
  // the HOST's real git.
  const landed = git(oldRepo, ['rev-parse', 'refs/heads/main']);
  check('SERVER-side main == the in-OS pushed sha', c3 && landed === c3,
    'server=' + landed + ' in-OS=' + c3);
  check('SERVER-side repo passes git fsck --strict',
    cp.spawnSync('git', ['-C', oldRepo, 'fsck', '--strict'], { timeout: 60000 }).status === 0);
  check('SERVER-side log subject is the in-OS message',
    git(oldRepo, ['log', '-n', '1', '--format=%s']) === 'c3: pushed from inside gucOS');
  check('SERVER-side blob content round-tripped',
    git(oldRepo, ['show', 'main:pushed.txt']) === 'pushed-from-gucos');

  const rej = section(out, 'pushreject');
  check('non-fast-forward push exits nonzero', has(rej, 'RC=1'), rej);
  // libgit2's client-side refusal: "cannot push because a reference that you
  // are trying to update on the remote contains commits that are not present
  // locally." (a server-side denial would surface as "! [rejected]").
  check('non-fast-forward push names the refusal',
    /cannot push|not present locally|reject/i.test(errOut),
    errOut.split('\n').filter((l) => /push/i.test(l)).join(' | '));
  check('diverged server was NOT moved',
    git(divRepo, ['log', '-n', '1', '--format=%s']) === 'd1: unrelated');

  // ---- auth ----
  const noauth = section(out, 'noauth');
  check('credential-less clone of the auth server fails (exit 1)', has(noauth, 'RC=1'), noauth);
  check('the failure names the missing credentials',
    /authentication required but no credentials are available/.test(errOut),
    errOut.split('\n').filter((l) => /auth/i.test(l)).join(' | '));
  const byurl = section(out, 'authurl');
  check('URL-embedded credentials clone works', has(byurl, 'RC=0') && has(byurl, c1), byurl);
  const bystore = section(out, 'authstore');
  check('~/.git-credentials clone works', has(bystore, 'RC=0'), bystore);
  const c4 = lines(bystore).find((l) => /^[0-9a-f]{40}$/.test(l));
  check('authed push exits 0', lines(bystore).filter((l) => l === 'RC=0').length >= 2, bystore);
  check('authed push landed SERVER-side',
    c4 && git(authRepo, ['rev-parse', 'refs/heads/main']) === c4,
    'server=' + git(authRepo, ['rev-parse', 'refs/heads/main']) + ' in-OS=' + c4);

  // ---- redirect ----
  const redir = section(out, 'redirect');
  check('clone through a 301 works', has(redir, 'RC=0') && has(redir, c2), redir);
  const reqs = await gs.requests();
  check('the negotiation POST followed the redirect (server saw POST on the REAL path)',
    reqs.some((q) => q === 'POST /repo.git/git-upload-pack')
    && !reqs.some((q) => q.startsWith('POST /moved.git/')),
    JSON.stringify(reqs));

  // The positive control that traffic flowed through the smart server at
  // all (not through some other path): the clone/pull/push legs above.
  check('git server saw upload-pack AND receive-pack traffic',
    reqs.some((q) => q.includes('git-upload-pack'))
    && reqs.some((q) => q.includes('git-receive-pack')),
    JSON.stringify(reqs));

  gs.kill();
  ags.kill();

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL OK');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
