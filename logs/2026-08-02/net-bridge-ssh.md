# net-bridge-ssh: running the Tier 2.5 bridge on a remote host (#380)

**2026-08-02.** `tools/net-bridge.js` (#349) performs the OS's HTTP transfers
"with the user's network identity". The unstated assumption is that the wanted
identity is the WORKSTATION's. Sometimes it isn't -- a request should look like
it came from some other machine. `node tools/net-bridge-ssh.js HOST` does that.

## Why it is a wrapper and not a feature

Nothing in `os/`, `kernel.js` or `net-bridge.js` changed, and nothing needed to.
The bridge binds loopback and the cfgstore `net` default url is
`http://127.0.0.1:8199`; an ssh `-L` forward is therefore a drop-in at exactly
the seam the design already has:

    browser -> 127.0.0.1:8199 -> [ssh] -> HOST:127.0.0.1:8199 -> upstream

The Control Panel switch stays the switch. The security posture stays Stage 1
and arguably tightens: the bridge still binds loopback, now on HOST where it is
unreachable from HOST's network either, and the tunnel is the only path in.
There is still no widen flag, and the origin allowlist is enforced remotely,
unmodified.

## Ship the source inline, never scp a stable copy

The obvious implementation -- `scp net-bridge.js host:~/` once, then forward --
is the one that rots. A persistent remote copy silently running an older wire
contract against a newer `os/os-common.js createNetFetch` is precisely the drift
class this tree keeps refusing, and it fails as a confusing protocol mismatch,
not as "your copy is stale". So the source is sent inline per run in a quoted
heredoc, lands in a per-run `/tmp/<token>.js`, and is removed on exit (plus a
detached `sleep 10; rm` backstop that survives a rude kill). Every run ships the
bytes currently in the checkout. The remote needs sshd, a POSIX shell and node
-- no repo, no npm.

## Teardown: three layers, because none of them covers every exit

The requirement was "killing it kills the holds". That is more than one failure
mode:

1. **Remote stdin-EOF watchdog (primary).** ssh's stdin is a pipe the wrapper
   holds open and never writes. Any death of the wrapper -- clean exit, Ctrl-C,
   `kill -9` -- closes the write end; the remote `cat` sees EOF and kills the
   bridge. This is the ONLY layer that works under `kill -9`, where nothing
   local gets to run. Verified: `kill -9` on the wrapper left zero remote
   processes, nothing on the remote's 8199, and the local port released.
2. **Remote shell traps** (HUP/INT/TERM/EXIT) for a channel that dies under the
   command -- dropped network, sshd teardown -- and to unlink the temp file.
3. **A bounded `pkill -f <per-run-token>` reaper** on graceful shutdown.

Plus `ServerAliveInterval=30`, so a half-open forward tears down instead of
accepting connections and answering nothing, and `ExitOnForwardFailure=yes`, so
a failed `-L` is fatal rather than a tunnel-shaped no-op.

## Two gotchas that cost real debugging time

**POSIX gives an async list's stdin `/dev/null`.** The first working-looking
build died instantly: exit 143, no output, bridge SIGTERM'd before it could
print its listening line. Cause: anything started with `&` in a shell without
job control -- every non-interactive `sh -c`, which is what ssh runs -- gets its
stdin assigned to `/dev/null` *before* explicit redirections. So the layer-1
watchdog read `/dev/null`, saw EOF in microseconds, and shot the bridge it was
supposed to be guarding. An explicit `<&0` on the async list is NOT a fix (fd 0
is already gone by then); saving the real stdin first with `exec 9<&0` and
reading `<&9` is. The symptom was maximally unhelpful -- a healthy remote, a
correct 11801-byte file, `node --check` clean, and a process that vanished --
which is why the fd trick is commented in place rather than left as folklore.

**`pkill -f PATTERN` matches its own command line.** Discovered by running
`ssh host 'pkill -f net-bridge.js'` by hand and getting exit 255: the remote
`bash -c` string contains the pattern, so pkill killed its own shell, quite
possibly before reaching the intended target. The reaper therefore brackets the
first character (`[g]uc-nbssh-...`), the old ps|grep trick: the ERE still
matches the bridge, but the literal text on the reaper's own command line does
not match the ERE. This matters more than it looks -- a remote is a real machine
with other node processes on it, so the reaper matches a per-run random token
and never `node` or a basename.

## Verified

Against a real remote: `/health` and an encapsulated `POST /fetch` both answer
through the tunnel, `x-guc-status: 200`, and the egress IP is the remote's, not
the workstation's. Teardown verified for both `kill -9` and SIGINT (zero remote
processes, remote 8199 clear, local port released each time). Preflights fail
loud with named causes and non-zero exits: busy local port (names the port and
how to find the squatter), unreachable host (surfaces ssh's own message), bad
flag (exit 2, matching net-bridge.js). The node >= 18 check reads a real remote
version but its FAILURE branch was not exercised -- no old-node host was
available to test against.

Not CI-testable end to end (needs a reachable sshd). `--dry-run` prints the
composed ssh argv plus the full remote script and starts nothing; that is the
inspectable surface, and `tests/kernel/test_netbridge_e2e.js` already covers the
bridge itself.
