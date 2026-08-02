#!/usr/bin/env node
// net-bridge-ssh.js -- run the Tier 2.5 HTTP bridge on a REMOTE host
// (ticket #380; todos/NETWORK.md Tier 2.5, which landed tools/net-bridge.js
// itself as #349).
//
//   node tools/net-bridge-ssh.js HOST [--port=8199] [--remote-port=PORT]
//                                     [--allow-origin=ORIGIN[,ORIGIN...]]
//                                     [--quiet] [--dry-run]
//
// HOST is any ssh destination: an alias from ~/.ssh/config, user@host, etc.
//
// Why this exists: net-bridge.js performs the OS's HTTP transfers with
// "the user's network identity". Sometimes the wanted identity is NOT the
// workstation's -- a request should look like it came from some other
// machine. The bridge binds loopback and the cfgstore `net` default url is
// http://127.0.0.1:8199, so an ssh -L forward is a drop-in: the browser
// still fetches localhost, the real request leaves from HOST. Nothing in
// os/ changes, net-bridge.js is not modified, and the `net` setting is the
// same switch it always was.
//
//   browser -> 127.0.0.1:PORT -> [ssh tunnel] -> HOST:127.0.0.1:REMOTE_PORT
//                                             -> net-bridge.js -> upstream
//
// Security posture: UNCHANGED from #349's Stage 1, and arguably tighter.
// The bridge still binds 127.0.0.1 -- now on HOST, where it is not
// reachable from HOST's network either; the ssh tunnel is the only way in.
// There is still no widen flag. The origin allowlist is enforced remotely
// and is untouched (localhost/127.0.0.1 any port + the shipped deploy, plus
// --allow-origin additions forwarded verbatim).
//
// The remote needs ONLY: sshd, a POSIX shell, and node >= 18 (the bridge
// calls global fetch). No repo, no npm, no write access beyond /tmp.
//
// SHIPPING THE SCRIPT: net-bridge.js is sent inline, per run, in a quoted
// heredoc, and lands in a per-run /tmp file that is removed on exit. It is
// deliberately NOT scp'd to a stable path: a persistent remote copy silently
// running an older wire contract against a newer os/os-common.js
// createNetFetch is exactly the drift class this repo refuses. Every run
// ships the bytes currently in this checkout.
//
// KILL PROPAGATION -- three layers, because no single one covers every exit:
//   1. stdin-EOF watchdog (PRIMARY). ssh's stdin is a pipe this process
//      holds open and never writes. Any death of THIS process -- clean exit,
//      Ctrl-C, even SIGKILL -- closes the write end, the remote's `cat`
//      sees EOF and kills the bridge. This is the layer that survives
//      `kill -9`, where nothing local gets to run.
//   2. Remote shell traps (HUP/INT/TERM/EXIT). Covers the ssh channel
//      closing under the remote command -- a dropped network, sshd
//      teardown -- and removes the temp file.
//   3. A one-shot `pkill -f <token>` reaper sent on graceful shutdown.
//      Belt and braces for a remote that somehow outlived 1 and 2; the
//      token is unique per run, so it can only ever match this run.
//      NB the pattern is bracketed ("[g]uc-nbssh-...") so it cannot match
//      the reaper's OWN command line: an unbracketed pkill -f kills the
//      shell running it, often before it reaches the real target. Remotes
//      routinely run other node processes -- this reaper must be surgical,
//      and it never matches on "node" or on the script's basename.
// A ServerAliveInterval also tears down a half-open forward rather than
// leaving a tunnel that accepts connections and answers nothing.
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_PORT = 8199;               // must match net-bridge.js / the `net` store default
const MIN_NODE = 18;                     // global fetch
const READY_LINE = '[net-bridge] listening';   // net-bridge.js documents this as its spawn barrier
const BRIDGE = path.join(__dirname, 'net-bridge.js');

function usage() {
  console.error('usage: node tools/net-bridge-ssh.js HOST [--port=N] [--remote-port=N]');
  console.error('                                        [--allow-origin=ORIGIN[,ORIGIN...]]');
  console.error('                                        [--quiet] [--dry-run]');
  console.error('');
  console.error('Runs tools/net-bridge.js on HOST and forwards it to 127.0.0.1:PORT here,');
  console.error('so the OS\'s HTTP egress leaves from HOST. HOST is any ssh destination.');
}

function parseArgs(argv) {
  const opts = {
    host: null, port: DEFAULT_PORT, remotePort: null,
    allow: [], quiet: false, dryRun: false,
  };
  for (const a of argv) {
    let m;
    if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if ((m = /^--port=(\d+)$/.exec(a))) opts.port = parseInt(m[1], 10);
    else if ((m = /^--remote-port=(\d+)$/.exec(a))) opts.remotePort = parseInt(m[1], 10);
    else if ((m = /^--allow-origin=(.+)$/.exec(a))) opts.allow.push(...m[1].split(',').filter(Boolean));
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a.startsWith('-')) { console.error('net-bridge-ssh: unknown argument ' + a); usage(); process.exit(2); }
    else if (opts.host === null) opts.host = a;
    else { console.error('net-bridge-ssh: unexpected extra argument ' + a); usage(); process.exit(2); }
  }
  if (opts.host === null) { console.error('net-bridge-ssh: HOST is required'); usage(); process.exit(2); }
  if (opts.remotePort === null) opts.remotePort = opts.port;
  return opts;
}

/* Single-quote a value for a POSIX shell command line. */
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

/* Preflight: the local forward port must be free. A busy port would make
 * ssh's -L fail; with ExitOnForwardFailure that is a hard exit, but the
 * message ("cannot listen to port") does not say WHO holds it, so say it
 * here where we can point at the likely culprit. */
function checkLocalPort(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        reject(new Error('local port ' + port + ' is already in use -- another bridge or tunnel is '
          + 'running.\n  find it with: lsof -nP -iTCP:' + port + ' -sTCP:LISTEN'));
      } else reject(e);
    });
    s.once('listening', () => s.close(() => resolve()));
    s.listen(port, '127.0.0.1');
  });
}

/* Preflight: HOST is reachable AND has a new enough node. Without this the
 * failure lands at the FIRST proxied request as a bare `fetch is not
 * defined` from inside the bridge -- a confusing runtime symptom for a
 * static, knowable precondition. One ssh round trip checks both. */
function checkRemote(host) {
  const r = spawnSync('ssh', [
    '-o', 'ConnectTimeout=10',
    host, 'command -v node >/dev/null 2>&1 && node -v || echo NONODE',
  ], { encoding: 'utf8' });
  if (r.error) throw new Error('could not run ssh: ' + r.error.message);
  if (r.status !== 0) {
    throw new Error('ssh ' + host + ' failed (exit ' + r.status + ')'
      + (r.stderr ? ':\n  ' + r.stderr.trim().split('\n').join('\n  ') : ''));
  }
  const out = (r.stdout || '').trim();
  if (out === 'NONODE' || !out) throw new Error('no node on ' + host + ' (need node >= ' + MIN_NODE + ')');
  const m = /^v?(\d+)\./.exec(out);
  if (!m) throw new Error('could not read node version on ' + host + ': ' + JSON.stringify(out));
  const major = parseInt(m[1], 10);
  if (major < MIN_NODE) {
    throw new Error('node ' + out + ' on ' + host + ' is too old: the bridge needs global fetch, '
      + 'so node >= ' + MIN_NODE + '.');
  }
  return out;
}

/* The remote command: materialize the bridge, run it, and make damn sure it
 * dies with us (layers 1 and 2 of the kill design in the header). */
function remoteScript(source, token, bridgeArgs) {
  const f = '/tmp/' + token + '.js';
  const eof = token + '_EOF';
  return [
    'set -u',
    'f=' + f,
    // Quoted delimiter: the shell performs NO expansion, so the source
    // crosses verbatim. The token makes a delimiter collision impossible.
    "cat > \"$f\" <<'" + eof + "'",
    source.replace(/\n$/, ''),
    eof,
    // Backstop unlink: survives even a rude kill of this shell, so a
    // crashed run cannot leave the file behind for more than 10s. The
    // normal path is the cleanup trap below.
    '( sleep 10; rm -f "$f" ) >/dev/null 2>&1 &',
    'bpid=',
    'cleanup() { rm -f "$f"; if [ -n "$bpid" ]; then kill "$bpid" 2>/dev/null || true; fi; }',
    "trap 'cleanup; exit 143' HUP INT TERM",
    "trap 'cleanup' EXIT",
    // Preserve the REAL stdin (the ssh channel) on a spare fd. POSIX gives
    // an asynchronous list -- anything started with `&` -- a stdin assigned
    // to /dev/null when job control is off, which every non-interactive
    // `sh -c` is. Without this the watchdog below reads /dev/null, sees EOF
    // immediately, and kills the bridge milliseconds after it starts.
    // (Observed exactly that: the bridge died on SIGTERM before it could
    // even print its listening line.) An explicit `<&0` on the async list
    // is NOT a fix -- the implicit /dev/null is applied first, so fd 0 is
    // already gone by the time it would be duplicated.
    'exec 9<&0',
    'node "$f" ' + bridgeArgs.map(shq).join(' ') + ' &',
    'bpid=$!',
    // Layer 1: fd 9 is the ssh channel. When the local wrapper dies by ANY
    // means its pipe write end closes, cat sees EOF, and the bridge is
    // killed. This is the only layer that works when the wrapper is SIGKILLed.
    '( cat <&9 > /dev/null; kill "$bpid" 2>/dev/null ) &',
    'wait "$bpid"',
  ].join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const log = (m) => console.log('[net-bridge-ssh] ' + m);

  let source;
  try {
    source = fs.readFileSync(BRIDGE, 'utf8');
  } catch (e) {
    console.error('[net-bridge-ssh] cannot read ' + BRIDGE + ': ' + e.message);
    process.exit(1);
  }

  const token = 'guc-nbssh-' + crypto.randomBytes(8).toString('hex');
  const bridgeArgs = ['--port=' + opts.remotePort];
  if (opts.allow.length) bridgeArgs.push('--allow-origin=' + opts.allow.join(','));
  if (opts.quiet) bridgeArgs.push('--quiet');

  const sshArgs = [
    '-o', 'ExitOnForwardFailure=yes',   // a failed -L must be fatal, never a tunnel-shaped no-op
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-L', opts.port + ':127.0.0.1:' + opts.remotePort,
    opts.host,
    remoteScript(source, token, bridgeArgs),
  ];

  if (opts.dryRun) {
    console.log('ssh \\');
    for (let i = 0; i < sshArgs.length - 1; i++) console.log('  ' + sshArgs[i] + ' \\');
    console.log('  <<remote script, ' + source.length + ' bytes of net-bridge.js, token ' + token + '>>');
    console.log('');
    console.log('--- remote script ---');
    console.log(sshArgs[sshArgs.length - 1]);
    process.exit(0);
  }

  (async () => {
    try {
      await checkLocalPort(opts.port);
      const ver = checkRemote(opts.host);
      log(opts.host + ': node ' + ver);
    } catch (e) {
      console.error('[net-bridge-ssh] ' + e.message);
      process.exit(1);
    }

    log('starting bridge on ' + opts.host + ' ...');
    const child = spawn('ssh', sshArgs, {
      // stdin is a pipe we hold open and never write: it IS the layer-1
      // watchdog. It must not be 'ignore' (nothing to EOF) or 'inherit'
      // (ssh would put the local terminal in raw mode and swallow Ctrl-C).
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    let ready = false;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        console.log(line);
        if (!ready && line.indexOf(READY_LINE) >= 0) {
          ready = true;
          log('ready: http://127.0.0.1:' + opts.port + ' -> ' + opts.host
            + ' (127.0.0.1:' + opts.remotePort + ')');
          log('HTTP egress now leaves from ' + opts.host + '. Ctrl-C to stop.');
        }
      }
    });

    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log('stopping ...');
      try { child.stdin.end(); } catch (e) { /* already gone: layer 1 has fired */ }
      try { child.kill('SIGTERM'); } catch (e) { /* already dead */ }
      // Layer 3: a short, bounded reaper. The token is unique per run, so
      // this can never match another user's or another run's bridge. The
      // leading character is bracketed so the ERE does not match the
      // reaper's own command line (see the header note) -- without that,
      // pkill kills its own shell instead of the bridge.
      const selfSafe = '[' + token[0] + ']' + token.slice(1);
      const reap = spawnSync('ssh', [
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
        opts.host, 'pkill -f ' + shq(selfSafe) + ' 2>/dev/null; exit 0',
      ], { encoding: 'utf8', timeout: 10000 });
      if (reap.error && reap.error.code !== 'ETIMEDOUT') {
        // Not fatal: layers 1 and 2 have almost certainly already won.
        log('note: cleanup ssh did not run (' + reap.error.message + ')');
      }
      process.exit(signal === 'SIGINT' ? 130 : 0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    child.on('error', (e) => {
      console.error('[net-bridge-ssh] ssh failed to start: ' + e.message);
      process.exit(1);
    });
    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      if (buf) console.log(buf.replace(/\r$/, ''));
      if (!ready) {
        console.error('[net-bridge-ssh] the bridge never reported "' + READY_LINE + '" -- it did not '
          + 'come up on ' + opts.host + '.');
      }
      log('ssh exited' + (signal ? ' on ' + signal : ' with code ' + code));
      process.exit(code === null ? 1 : code);
    });
  })();
}

main();
