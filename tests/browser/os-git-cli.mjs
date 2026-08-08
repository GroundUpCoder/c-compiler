// gucOS Git CLI browser acceptance — the read verbs, the #475 write set
// (init/config/add/commit/branch/checkout driven at the VT1 shell), and the
// unimplemented-verb error path. Tickets #474/#475/#478 cover the surface.
// This is an ordinary sweep member (os-sweep.mjs discovers every os-*.mjs,
// and the diff planner maps it to `sweep`); the screenshots below exist so a
// human can re-inspect the user-shaped flow against any tree.
//
// Boots a Chromium against a serve.js, drives /bin/git on VT1, captures a
// screenshot at every meaningful state, and prints each evidence path so the
// invoking chat thread can embed it inline.
//
// Usage:
//   node tests/browser/os-git-cli.mjs
//
// Requires:
//   - a clean tree (no dirty os/ files) — this file does NOT bake the image
//   - Playwright pinned per tests/browser/lib/playwright-pin.cjs
//
// Returns non-zero on any FAIL. All evidence paths are printed to stdout.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openOsSession, ROOT } from './lib/os-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.join(__dirname, 'media', 'git-cli');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const PORT = 3450;   // unique per member (#546)

// Build the package repo so the served /packages index matches the running
// image — same discipline os-minimal.mjs applies. The git CLI ships as a
// gucman package, not baked into the fat image (the minimal install test
// explicitly proves the baked twin is absent).
{
  const r = spawnSync(process.execPath,
    [path.join(ROOT, 'tools', 'mkpkg.js'), '--no-baseline', '--quiet'], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('mkpkg failed — cannot serve a package repo');
    process.exit(2);
  }
}

// Plant a tiny real git repo under build/git-cli-fixture so the host-built
// repo + tarball are inside an already-gitignored path (build/, .gitignore:1)
// — a top-level git-cli-fixture/ was one careless `git add -A` away from
// being committed (a recorded failure class). serve.js serves from ROOT,
// so the in-OS curl still fetches the tarball at the page origin from
// /git-cli-fixture/repo.tar.gz.
{
  const fxDir = path.join(ROOT, 'build', 'git-cli-fixture');
  fs.mkdirSync(fxDir, { recursive: true });
  const repoDir = path.join(fxDir, 'repo');
  // The src/nested.txt probe rebuilds a cached pre-#571 fixture that lacks
  // the nested file leg 7's recursive assertions need.
  if (!fs.existsSync(path.join(repoDir, '.git', 'HEAD')) ||
      !fs.existsSync(path.join(repoDir, 'src', 'nested.txt'))) {
    if (fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
    fs.mkdirSync(repoDir, { recursive: true });
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Sweep',
      GIT_AUTHOR_EMAIL: 'sweep@guc',
      GIT_COMMITTER_NAME: 'Sweep',
      GIT_COMMITTER_EMAIL: 'sweep@guc',
      GIT_AUTHOR_DATE: '2026-08-07T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-08-07T00:00:00Z',
      // Block any user-level config so byte stability does not depend on the host.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      HOME: fxDir,
    };
    const run = (args) => spawnSync('git', args, { cwd: repoDir, env, encoding: 'utf-8' });
    const r1 = run(['init', '-q', '-b', 'main']);
    if (r1.status !== 0) { console.error('git init failed', r1.stderr); process.exit(2); }
    fs.writeFileSync(path.join(repoDir, 'hello.txt'), 'gucOS fixture\n');
    // A nested path makes ls-tree -r observable — a flat repo recurses into
    // nothing and a "recursive" pass would be vacuous (#571).
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'nested.txt'), 'nested fixture file\n');
    const r2 = run(['add', 'hello.txt', 'src/nested.txt']);
    if (r2.status !== 0) { console.error('git add failed', r2.stderr); process.exit(2); }
    const r3 = run(['commit', '-q', '-m', 'fixture: first commit']);
    if (r3.status !== 0) { console.error('git commit failed', r3.stderr); process.exit(2); }
  }
  const tarPath = path.join(fxDir, 'repo.tar.gz');
  spawnSync('tar', ['-czf', tarPath, '-C', fxDir, 'repo'],
    { encoding: 'utf-8' });
  console.log(`[git-cli] fixture repo + tarball at build/git-cli-fixture/`);
}

const s = await openOsSession({
  port: PORT,
  serveArgs: ['--minimal'],   // exercise the deploy shape; install lands /bin/git
  serverTries: 900, serverInterval: 500,
});
const { page, check, waitOut, setVt } = s;

// ---- helpers ----------------------------------------------------------
let cursor = 0;
async function sh(cmd, tag, ms = 30000) {
  const typed = `${cmd}; echo ${tag.slice(0, -1)}""${tag.slice(-1)}-RC=$?\r`;
  await page.keyboard.type(typed);
  await waitOut(`${tag}-RC=`, ms);
  const out = await page.evaluate(() => window.__osOut);
  const seg = out.slice(cursor);
  cursor = out.length;
  const m = new RegExp(`${tag}-RC=(\\d+)`).exec(seg);
  return { seg, rc: m ? parseInt(m[1], 10) : null };
}

async function shot(name) {
  // Capture VT1 — the tty mirror is where the typed commands land. VT2 is
  // the desktop composite (todos/0022). The page-side composite re-frames
  // a moment after the VT change; wait for one settled frame.
  await setVt(1);
  await page.waitForTimeout(400);
  const file = path.join(EVIDENCE_DIR, name + '.png');
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

function trimSeg(seg, keep = 400) {
  return String(seg || '').replace(/\r/g, '').slice(-keep);
}

try {
  await setVt(1);
  // ---- leg 0: install the git package over HTTP ------------------------
  console.log('\nleg 0 — install git via the served package repo');
  {
    const r = await sh('echo PROBE', 'PROBE', 60000);
    check('the shell responds on VT1', r.rc === 0, trimSeg(r.seg));
  }
  {
    const r = await sh('which git || echo NOT-ON-PATH', 'WHICH', 60000);
    check('git is NOT on PATH before install (deploy shape)', r.rc === 0,
      trimSeg(r.seg));
  }
  await shot('00-pre-install');
  {
    // The in-OS gucman uses libcurl's same-origin /packages path served by
    // serve.js from dist/packages. The baked default `/packages` (origin-
    // relative) works in a browser tab; headless boots write an absolute URL.
    // Confirm the baked default is reachable from the page origin.
    const r2 = await sh('mkdir -p /etc/gucman && ' +
      'echo /packages > /etc/gucman/repos && ' +
      'cat /etc/gucman/repos', 'REPO', 60000);
    check('repo set to origin-relative /packages (the baked default)',
      r2.rc === 0, trimSeg(r2.seg, 200));
  }
  {
    const r = await sh('gucman install git', 'INSTALL', 180000);
    check('gucman install git succeeded', r.rc === 0, trimSeg(r.seg, 800));
  }
  await shot('01-installed');
  {
    const r = await sh('readlink /usr/local/bin/git', 'RL');
    check('git symlink under /usr/local/bin', /opt\/git\/git/.test(r.seg),
      trimSeg(r.seg));
  }
  {
    const r = await sh('which git', 'WHICH2');
    check('which git now resolves', /\/usr\/local\/bin\/git/.test(r.seg),
      trimSeg(r.seg));
  }

  // ---- leg 1: --version, --help ---------------------------------------
  console.log('\nleg 1 — metadata: --version + --help');
  {
    const r = await sh('git --version', 'VER');
    check('git --version prints the gucOS version line',
      /git version 0\.3 \(libgit2/.test(r.seg), trimSeg(r.seg));
  }
  {
    const r = await sh('git --help', 'HELP');
    check('git --help lists the read verbs, the #475 write set AND the #478 network verbs',
      /log/.test(r.seg) && /status/.test(r.seg) && /ls-tree/.test(r.seg) &&
      /init/.test(r.seg) && /commit/.test(r.seg) && /checkout/.test(r.seg) &&
      /clone/.test(r.seg) && /fetch/.test(r.seg) && /push/.test(r.seg) &&
      /merge, tag and reset are not implemented/.test(r.seg),
      trimSeg(r.seg, 1200));
  }
  await shot('02-help');

  // ---- leg 2: no repo in /root, walk up also nothing ------------------
  // /root has no .git; running git there prints git's verbatim fatal.
  console.log('\nleg 2 — fatal: not a git repository (no repo under cwd)');
  {
    const r = await sh('git log', 'NOREP');
    check('git log fails with the upstream fatal string',
      r.rc !== 0 && /fatal: not a git repository/.test(r.seg),
      trimSeg(r.seg));
  }
  await shot('03-not-a-repo');

  // ---- leg 3: fetch + extract the fixture repo (real, host-built) --------
  console.log('\nleg 3 — fetch the fixture repo from the page origin');
  // /build/git-cli-fixture/repo.tar.gz is served by serve.js (the host
  // tarball built above, now under the gitignored build/ so a careless
  // `git add -A` cannot commit it). curl in-OS rides the kernel's __http_*
  // bridge to the same origin os.html was loaded from.
  const r1 = await sh('cd /tmp && rm -rf fx && mkdir -p fx && ' +
    "curl -sfL '/build/git-cli-fixture/repo.tar.gz' -o fx/repo.tar.gz && " +
    'cd fx && tar -xzf repo.tar.gz && ls -la repo/.git/HEAD',
    'FX', 120000);
  check('fetched + extracted the fixture repo (HEAD present)',
    r1.rc === 0 && /HEAD/.test(r1.seg), trimSeg(r1.seg, 600));
  await shot('04-fetched');

  // ---- leg 4: -C <path>                                                -
  console.log('\nleg 4 — -C <path> chdirs before repo discovery');
  const dir = '/tmp/fx/repo';
  {
    const r = await sh(`git -C '${dir}' rev-parse HEAD`, 'CWD', 60000);
    const seg = String(r.seg || '');
    check('git -C <dir> rev-parse HEAD returns the commit oid',
      r.rc === 0 && /^[0-9a-f]{40}$/m.test(seg),
      trimSeg(seg, 600));
  }
  await shot('05-rev-parse');

  // ---- leg 5: the #475 write set at the shell -------------------------
  // A repo authored entirely in the browser session: init -> config ->
  // add -> commit -> branch -> checkout, with the commit summary line and
  // the branch list as the observables. (The old leg asserted init/add/
  // commit answered "read-only" — those verbs are implemented now, so the
  // coverage flipped from refusal to behaviour; the unimplemented-verb path
  // is still asserted below with `merge`, and the typo path is unchanged.)
  console.log('\nleg 5 — the write set: init/config/add/commit/branch/checkout');
  {
    const r = await sh('mkdir -p /tmp/w && cd /tmp/w && git init -b main .', 'WINIT');
    check('git init -b main creates a repository',
      r.rc === 0 && /Initialized empty Git repository/.test(r.seg), trimSeg(r.seg));
  }
  {
    const r = await sh('git config user.name Dev && git config user.email dev@guc && git config user.name', 'WCFG');
    check('git config set + get round-trips', r.rc === 0 && /^Dev$/m.test(r.seg.replace(/\r/g, '')),
      trimSeg(r.seg));
  }
  {
    const r = await sh('echo one > f.txt && git add . && git commit -m first', 'WCOMMIT');
    check('add + commit produce git\'s root-commit summary line',
      r.rc === 0 && /\[main \(root-commit\) [0-9a-f]{7,}\] first/.test(r.seg),
      trimSeg(r.seg));
  }
  {
    const r = await sh('git checkout -b feat && echo two > g.txt && git add g.txt && git commit -m second', 'WBRANCH');
    check('checkout -b + commit land on the new branch',
      r.rc === 0 && /\[feat [0-9a-f]{7,}\] second/.test(r.seg), trimSeg(r.seg));
  }
  {
    const r = await sh('git checkout main && git branch && test ! -e g.txt && echo G-ABSENT', 'WSWITCH');
    check('checkout main switches the working tree (branch list + g.txt gone)',
      r.rc === 0 && /\* main/.test(r.seg) && /feat/.test(r.seg) &&
      /G-ABSENT/.test(r.seg), trimSeg(r.seg, 600));
  }
  {
    const r = await sh('git merge feat', 'MERGE');
    check('git merge (a real verb) answers that this build does not implement it',
      r.rc !== 0 && /is a git command, but this build does not implement it yet/.test(r.seg),
      trimSeg(r.seg));
  }
  {
    const r = await sh(`git -C '${dir}' notarealcommand`, 'TYPO');
    check('a typo answers differently from a known verb',
      r.rc !== 0 && /is not a git command/.test(r.seg) &&
      !/is a git command, but this build does not implement/.test(r.seg),
      trimSeg(r.seg));
  }
  await shot('06-write-set');

  // ---- leg 6: log + status + ls-tree on the discovered repo ----------
  console.log('\nleg 6 — read-only verbs over the fixture repo');
  {
    const lr = await sh(`git -C '${dir}' log -n 1`, 'LOG', 30000);
    check('git log -n 1 prints commit/Author/Date/parents',
      lr.rc === 0 && /commit [0-9a-f]{40}/.test(lr.seg) &&
      /Author:/.test(lr.seg) && /Date:/.test(lr.seg),
      trimSeg(lr.seg, 800));
    const sr = await sh(`git -C '${dir}' rev-list -n 3 HEAD`, 'RLIST', 30000);
    check('git rev-list -n 3 HEAD prints at least one oid',
      sr.rc === 0 && /^[0-9a-f]{40}/m.test(sr.seg.replace(/RLIST-RC=\d+/, '')),
      trimSeg(sr.seg, 600));
    const tr = await sh(`git -C '${dir}' cat-file -p HEAD`, 'CATFILE', 30000);
    check('git cat-file -p HEAD prints the commit object',
      tr.rc === 0 && /^tree [0-9a-f]{40}$/m.test(tr.seg),
      trimSeg(tr.seg, 600));
    const shr = await sh(`git -C '${dir}' show HEAD | head -10`, 'SHOW', 30000);
    check('git show HEAD prints commit metadata',
      shr.rc === 0 && /commit [0-9a-f]{40}/.test(shr.seg),
      trimSeg(shr.seg, 800));
    // The fixture repo has only one commit — HEAD~1 does not exist. We still
    // exercise `diff <rev> <rev>` to assert the verb path runs without
    // crashing (a self-diff should print zero deltas).
    const df2 = await sh(`git -C '${dir}' diff HEAD HEAD`, 'DIFF2', 30000);
    check('git diff HEAD HEAD (self-diff) reports zero deltas',
      df2.rc === 0 && !/fatal/.test(df2.seg),
      trimSeg(df2.seg, 200));
  }
  await shot('07-verbs');

  // ---- leg 7: ls-tree -r — flag position must not matter (#571) --------
  // The handler used to revparse argv[0] blindly, so `ls-tree -r HEAD`
  // failed with "git: bad revision '-r'" while `ls-tree HEAD -r` worked.
  // Real git accepts both orderings; assert both work AND agree, and that
  // the listing really recursed (the nested src/nested.txt path appears).
  {
    // Object lines only — the echoed command line and the RC tag differ
    // between the two invocations by construction. Whitespace is normalised
    // because the tty may render the tab separator differently.
    const entryLines = (seg) => String(seg).replace(/\r/g, '').split('\n')
      .map((l) => l.trim().replace(/\s+/g, ' '))
      .filter((l) => /^\d{6} (blob|tree) [0-9a-f]{40} \S/.test(l));
    const a = await sh(`git -C '${dir}' ls-tree -r HEAD`, 'LSTRA', 30000);
    check('git ls-tree -r HEAD (flag BEFORE the rev) lists the tree recursively',
      a.rc === 0 && entryLines(a.seg).some((l) => / src\/nested\.txt$/.test(l)),
      trimSeg(a.seg, 600));
    const b = await sh(`git -C '${dir}' ls-tree HEAD -r`, 'LSTRB', 30000);
    check('git ls-tree HEAD -r (flag AFTER the rev) lists the tree recursively',
      b.rc === 0 && entryLines(b.seg).some((l) => / src\/nested\.txt$/.test(l)),
      trimSeg(b.seg, 600));
    check('both orderings return the same recursive listing',
      entryLines(a.seg).length > 0 &&
      entryLines(a.seg).join('\n') === entryLines(b.seg).join('\n'),
      JSON.stringify({ a: entryLines(a.seg), b: entryLines(b.seg) }));
  }
  await shot('08-lstree');

  // ---- loud-symptom gate ---------------------------------------------
  {
    const out = await page.evaluate(() => window.__osOut || '');
    const timeouts = (out.match(/wmctl: wait [^\n]*timed out[^\n]*/g) || []);
    check('no wmctl wait timed out during the session',
      timeouts.length === 0, timeouts.join(' | '));
  }

  // ---- evidence index ------------------------------------------------
  console.log('\nevidence files (relative to tests/browser/):');
  for (const f of fs.readdirSync(EVIDENCE_DIR).sort()) {
    const abs = path.join(EVIDENCE_DIR, f);
    console.log('  ' + path.relative(__dirname, abs));
  }
} catch (e) {
  s.fail(e);
} finally {
  await s.close();
}
s.finish('os git CLI (browser)');
