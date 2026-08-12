// gucOS git NETWORK leg, in-browser (ticket #478) — the configuration jku
// actually asked for: `git clone` / `push` at the VT1 shell of a Chromium
// boot, with the traffic crossing the Tier 2.5 net bridge
// (tools/net-bridge.js), because the git server lives on ANOTHER localhost
// port and the kernel worker's direct fetch is CORS-gated there.
//
// The legs prove, in order:
//   1. git installs from the page-origin package repo (bridge OFF — the
//      baked /packages repo URL is origin-relative, ticket #391's known
//      bridge limitation, so the install happens before the bridge is on).
//   2. NEGATIVE CONTROL: with the bridge OFF, a cross-origin clone FAILS —
//      the bridge is load-bearing, not decoration.
//   3. Flipping the `net` cfgstore ON retargets the NEXT transfer live (the
//      #349 watchPath choke) and the same clone SUCCEEDS; the cloned HEAD
//      equals what host git says the fixture's HEAD is.
//   4. An in-OS commit PUSHES back through the bridge and the HOST-side
//      bare repo shows the pushed sha with `git fsck --strict` clean — the
//      cross-implementation oracle, pointed through the browser.
//   5. POSITIVE CONTROLS: the bridge's /health request counter moved, and
//      the git server's request log shows upload-pack AND receive-pack.
//
// The git server's far end is the HOST's real git (gitserve.js in a child
// process — spawned, because this file blocks in Playwright waits).
//
// Usage: node tests/browser/os-git-net.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { openOsSession, ROOT, buildPackageRepo } from './lib/os-harness.mjs';
import { spawnGitServer } from '../kernel/lib/gitserve.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = path.join(__dirname, 'media', 'git-net');
fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

const PORT = 3451;   // unique per member (#546)

// ---- package repo (git ships as a gucman package; #665 merged rebuild) --
buildPackageRepo();

// ---- host-side fixture: a work repo + a bare server repo ---------------
const fxDir = path.join(ROOT, 'build', 'git-net-fixture');
fs.rmSync(fxDir, { recursive: true, force: true });
fs.mkdirSync(fxDir, { recursive: true });
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Sweep', GIT_AUTHOR_EMAIL: 'sweep@guc',
  GIT_COMMITTER_NAME: 'Sweep', GIT_COMMITTER_EMAIL: 'sweep@guc',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  HOME: fxDir,
};
function hostGit(cwd, args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf-8', timeout: 60000 });
  if (r.status !== 0) {
    console.error('host git ' + args.join(' ') + ' failed:\n' + r.stderr);
    process.exit(2);
  }
  return r.stdout.trim();
}
const workDir = path.join(fxDir, 'work');
fs.mkdirSync(workDir);
hostGit(fxDir, ['init', '-q', '-b', 'main', workDir]);
fs.writeFileSync(path.join(workDir, 'hello.txt'), 'bridge fixture\n');
hostGit(workDir, ['add', '-A']);
hostGit(workDir, ['commit', '-q', '-m', 'fixture: c1']);
const C1 = hostGit(workDir, ['rev-parse', 'HEAD']);
const serverRepo = path.join(fxDir, 'server.git');
hostGit(fxDir, ['clone', '-q', '--bare', workDir, serverRepo]);

// ---- the git server (child) + the net bridge (child) -------------------
const gitsrv = await spawnGitServer({ repos: { '/repo.git': serverRepo } });
console.log('[git-net] git server (host git far end) on ' + gitsrv.url);

const bridge = spawn(process.execPath, [path.join(ROOT, 'tools', 'net-bridge.js'), '--port=0'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
const bridgeUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const to = setTimeout(() => reject(new Error('bridge never announced: ' + buf)), 10000);
  bridge.stdout.on('data', (d) => {
    buf += d;
    const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf);
    if (m) { clearTimeout(to); resolve(m[1]); }
  });
  bridge.on('exit', (c) => { clearTimeout(to); reject(new Error('bridge exited ' + c)); });
});
process.on('exit', () => { try { bridge.kill(); } catch (e) {} try { gitsrv.kill(); } catch (e) {} });
console.log('[git-net] net bridge on ' + bridgeUrl);

const s = await openOsSession({
  port: PORT,
  serveArgs: ['--minimal'],
  serverTries: 900, serverInterval: 500,
});
const { page, check, waitOut, setVt } = s;

let cursor = 0;
async function sh(cmd, tag, ms = 60000) {
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
  await setVt(1);
  await page.waitForTimeout(400);
  const file = path.join(EVIDENCE_DIR, name + '.png');
  await page.screenshot({ path: file, fullPage: false });
  console.log('  evidence: ' + file);
  return file;
}
const trim = (seg, keep = 400) => String(seg || '').replace(/\r/g, '').slice(-keep);

try {
  await setVt(1);

  // ---- leg 1: install git (bridge OFF — origin-relative package repo) --
  console.log('\nleg 1 — install git from the page-origin package repo');
  {
    const r = await sh('mkdir -p /etc/gucman && echo /packages > /etc/gucman/repos '
      + '&& gucman install git', 'INSTALL', 180000);
    check('gucman install git succeeded', r.rc === 0, trim(r.seg, 800));
  }

  // ---- leg 2: NEGATIVE CONTROL — cross-origin clone, bridge OFF --------
  console.log('\nleg 2 — negative control: bridge OFF, cross-origin clone fails');
  {
    const r = await sh(`git clone ${gitsrv.url}/repo.git /root/direct`, 'DIRECT', 120000);
    check('bridge OFF: the cross-origin clone FAILS (CORS gate is real)',
      r.rc !== 0 && r.rc !== null, 'rc=' + r.rc + ' ' + trim(r.seg));
  }
  await shot('01-direct-clone-refused');

  // ---- leg 3: bridge ON — the same clone succeeds ----------------------
  console.log('\nleg 3 — bridge ON: clone through the localhost bridge');
  {
    const r = await sh(`printf 'bridge on\\nurl ${bridgeUrl}\\n' > /etc/net && cat /etc/net`,
      'NETCFG');
    check('net cfgstore written (live watchPath retarget, no reboot)',
      r.rc === 0 && /bridge on/.test(r.seg), trim(r.seg));
  }
  {
    const r = await sh(`git clone ${gitsrv.url}/repo.git /root/r`, 'CLONE', 180000);
    check('bridge ON: clone succeeds', r.rc === 0, trim(r.seg, 800));
  }
  {
    const r = await sh('git -C /root/r rev-parse HEAD && cat /root/r/hello.txt', 'HEAD');
    check('cloned HEAD == host fixture c1', r.seg.includes(C1), trim(r.seg));
    check('cloned working tree content is right', /bridge fixture/.test(r.seg), trim(r.seg));
  }
  await shot('02-bridged-clone');

  // ---- leg 4: push back through the bridge, judged host-side -----------
  console.log('\nleg 4 — push through the bridge, verified by host git server-side');
  let pushedSha = null;
  {
    const r = await sh('cd /root/r && git config user.name "GucOS Dev" '
      + '&& git config user.email dev@gucos.test '
      + '&& echo pushed-via-bridge > pushed.txt '
      + '&& git add pushed.txt && git commit -q -m "browser: pushed via bridge" '
      + '&& git rev-parse HEAD', 'COMMIT', 60000);
    check('in-OS commit succeeds', r.rc === 0, trim(r.seg));
    const m = /\b([0-9a-f]{40})\b/.exec(r.seg.replace(/\r/g, ''));
    pushedSha = m ? m[1] : null;
    check('commit printed a sha', !!pushedSha, trim(r.seg));
  }
  {
    const r = await sh('cd /root/r && git push origin main', 'PUSH', 120000);
    check('push exits 0', r.rc === 0, trim(r.seg, 800));
  }
  await shot('03-bridged-push');
  {
    const landed = hostGit(serverRepo, ['rev-parse', 'refs/heads/main']);
    check('HOST-side server repo main == the pushed sha',
      pushedSha && landed === pushedSha, 'server=' + landed + ' pushed=' + pushedSha);
    const fsck = spawnSync('git', ['-C', serverRepo, 'fsck', '--strict'],
      { encoding: 'utf-8', timeout: 60000 });
    check('HOST-side server repo passes git fsck --strict', fsck.status === 0, fsck.stderr);
    check('HOST-side pushed blob content round-tripped',
      hostGit(serverRepo, ['show', 'main:pushed.txt']) === 'pushed-via-bridge');
  }

  // ---- leg 5: positive controls — the traffic really crossed the bridge -
  console.log('\nleg 5 — positive controls');
  {
    const health = await (await fetch(bridgeUrl + '/health')).json();
    check('bridge /health shows proxied requests', health.requests > 0,
      JSON.stringify(health));
    const reqs = await gitsrv.requests();
    check('git server log shows upload-pack AND receive-pack',
      reqs.some((q) => q.includes('git-upload-pack'))
      && reqs.some((q) => q.includes('git-receive-pack')),
      JSON.stringify(reqs));
  }
} catch (e) {
  s.fail(e);
} finally {
  try { bridge.kill(); } catch (e) {}
  try { gitsrv.kill(); } catch (e) {}
  await s.close();
}
s.finish('os git network leg via the net bridge (browser)');
