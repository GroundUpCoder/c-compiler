# Batch H — the silent-failure cluster: #394, #177, #460, #184 (+#376 findings)

One Fable lane, sequential, one full-weight gate. Epic justification: all five
tickets remove a place where gucOS fails without telling anyone — the platform
property a game developer debugs against. Base: origin/main `f14bc9e0`.

## #394 — minesweeper sample names its own cause (os/image.json + os-common.js)

The baked sample fetched 24 files with bare `curl -sL`: bridge-off in a browser
every fetch is a CORS failure, `-s` silenced it, `set -e` killed the script with
no message. Worse, without `-f` a 404 saved the error page INTO a `.c` file and
sailed on at exit 0 — a second silent failure the ticket didn't name.

Fix: one checked `fetch()` wrapper (`-sfL` + an `||` arm printing the curl exit
code, the URL, and the cause — HTTP bridge / CORS — then `exit 1`). Verified
in-OS: the verbatim wrapper against an unreachable host prints the named cause
(curl exit 7) and stops; the success path continues under `set -e`.

**The #434 bake linter rejected the fix**, which is a finding of its own: it
flagged shell functions and `>&2` (tokenized as `>` + `&` + word `2`, so `2`
was command-checked) — both legitimate POSIX. `2>&1` had the same bug. The
tokenizer now folds redirections into `redir`/`redir-fd` tokens and
scanShellText prescans function definitions (whole-text, so forward references
resolve). test_manifest_refs.js grew one green + two red legs; 19/19.

No image.json version bump: the sample is a **user-section seed** (applies only
to a freshly created root volume, no version gate) and the system blob's bytes
are unchanged — a bump would re-fetch an identical blob. Existing user
territories keep the old script by platform design (upgrades never write user
territory).

## #177 — netsurf uncaught exceptions reach the console (dukky.c)

Measured surface first, per the batch kickoff's mis-weight suspicion: the real
emission surface is exactly the ticket's four sites — `dukky_dump_error` (which
covers js_exec compile+exec failures and every `dukky_pcall` user) plus three
raw `duk_pcall_method` listener/handler sites. Weight stays light; the ticket
was NOT mis-weighted.

`dukky_report_exception`: error object stays on the stack, window read via the
global object's PRIVATE_MAGIC (console.c's write_log_entry pattern), stack
trace out as `browser_window_console_log(BW_CS_SCRIPT_ERROR,
FOLDABLE|LEVEL_ERROR)`. NSLOG lines stay — that is the developer surface, the
console is the user-visible one. gucOS frontend needed nothing: it already
printed the source as `exception`.

Patch record regenerated for the dukky.c section (pristine residual
byte-identical; patchcheck 69/69). Smoke: the 592-TU netsurf link builds.

e2e: new legs in test_netsurf_console_e2e.js (23/23) — click listener restyles
a div THEN throws; the repaint is polled off wmctl shots (the pointer-test
pattern), so a lost click cannot masquerade as a missing emission. The no-throw
console page is the negative control (zero `js: exception:` lines).

**Trap worth recording**: the first control waited on a `document.title`
change. The duktape title setter updates the DOM only — nothing propagates a
dynamic title to the window — so that wait is an unreachable condition. Now in
the test header. driveBoot's timeout-fails-loud discipline (0171) caught it.

Liability L63 retired with its gap (41 → 40 entries).

## #460 — netbridge e2e temp leak (mkdtempOwned)

Ticket verified including its own correction (`kernel-` dirs were never
invisible to the reaper — untagged-age reaping at 2h; the defect was no cleanup
plus that window). Control: 107 `*netbridge*` dirs already littered TMPDIR;
the pre-change run made 108; the fixed run added zero. `mkdtempOwned
('os-netbridge-')` per the #451 ticketbridge precedent. Suite: 1 passed, no
`--resume`.

## #184 — host.js CLI wall-clock ceiling (design call: bound, not reaper)

Chose the in-process ceiling over an orphan reaper: the choke point is host.js
itself, so coverage is 100% of CLI invocations by construction, and the guard
is structurally incapable of killing any other process — a reaper's
kill-the-live-gate failure mode cannot exist here.

Mechanism: `runModule({maxWallMs})` wraps env + wasi imports (the
deliverSignals wrap is the in-file precedent, same Math.* exclusion) with a
throttled deadline check — the import choke is the only place a synchronously
spinning module hands the host control; a JS timer never fires while wasm holds
the thread. unref'd CLI setTimeout backstops event-loop-alive hangs. Expiry =
exit 124 naming elapsed, limit, module, and the flag.

Policy: `--max-seconds=N`; default 3600s when stdin is NOT a TTY (the 0332
orphans ran exactly this shape), no ceiling at a TTY, 0 disables. Embedders
never set it — byte-identical behavior. Pure-compute no-import loops stay
uninterruptible: the same documented boundary as cooperative signals.

Census: in-tree CLI spawn sites are tests/run.py (19 uses, all also under the
runner's 30s per-test timeout), tests/bench/run.js:182 (the sameboy bench), and
tests/host legs; mkimage/mkpkg only `require()` BLOCK_FS. All inherit the
non-TTY default. test_host_ceiling.js: kill / spare / disable / usage legs,
11/11, registered in the guarded member list.

## #376 — ship probe: found, and already superseded (findings only, no commit)

The probe **is not a tree artifact** — not in c-compiler, comguc, or netguc.
"The package-index probe" was a coordinator ship-verification practice carried
in kickoff/state prose (meta repo). The defect was real and was **already
diagnosed and replaced on 2026-08-02** (cont-316): the discriminating
instrument is `~/git/meta/meta/scripts/img-file-hashes.js` — a per-file sha256
map of the baked image — measured on ship 215 (3 changed / 114 unchanged / 0
added / 0 removed, prediction recorded before measurement). The correction in
the meta state file even shows the ticket's premise mechanism is inverted
today: all 26 index entries differ on EVERY version bump (minBase), so the
index probe is non-discriminating in the opposite direction from "26/26
unchanged". Recommendation to the master: close as dropped-superseded, and
point ship kickoffs at img-file-hashes.js (a meta-repo edit).
