# #421 — tools/os-drive-headless.mjs: the headless session driver

Lane: ticket-421 (worktree off origin/main @804b452b). Implemented under an
explicit heavy-lock STAND-DOWN (#487 held the machine lock), so everything
here was written and committed **without a single boot** — the verification
plan below runs verbatim at release.

## What landed

`tools/os-drive-headless.mjs` — the headless sibling of `tools/os-drive.mjs`
(the headless-node report's Stage 1, `meta/gucos/notes/
headless-node-architecture-2026-08-02.md` §3). Same "driving layer, not a
test tier" contract: no assertions, no runner integration. Where
`tests/kernel/lib/drive.js driveBoot` is a BATCH driver (one script in, one
transcript out), this is a SESSION driver: one live `os/boot.js` child,
commands interleaved with reads on the running OS.

Key mechanics, each verified against the tree before use:

- **Byte-clean transport.** Under piped stdin without `--tty-out`, program
  stdout bypasses tty processing entirely (`kernel.js:2370-2386` — only the
  OFD kind differs) and input echo goes through the tty `output` callback,
  which boot.js no-ops under pipes (`os/boot.js:399`). So `readFile` uses raw
  `cat` between a start marker and a **byte-count-computed, verified-not-
  searched** end marker — binary content cannot fake it. This improves on the
  spike's "second session cats the PPM back" pattern: no reboot per read.
- **`--tty-out` mode is honestly different, not broken.** fd 1 becomes
  tty-kind → ONLCR mangles binary, so `readFile` switches to `base64`
  transport (applet baked, `CONFIG_BASE64=y`), whitespace-stripped, still
  byte-count verified. Marker anchoring tolerates `\r\n`.
- **`putFile`** appends base64 in 4096-char lines via hush's **builtin**
  printf (`CONFIG_HUSH_PRINTF=y` — the standalone applet is NOT baked,
  `# CONFIG_PRINTF is not set`), decodes in-OS, verifies the landed byte
  count. This is the transport the #487 dogfood script hand-rolled at 900
  chars/line; every future round gets it for free.
- **run() carries the exit status** (`; echo <split-marker>$?`) and the
  split-needle trick keeps markers self-match-proof if echo ever appears.
- **Loud-symptom parity with driveBoot**: any `wmctl: wait … timed out` on
  stderr throws after the enclosing run() (todos/0171 class), opt-out
  `allowWaitTimeout` per call; boot.js's heavy-lock refusal (exit 3 +
  `[heavy-lock]`) surfaces verbatim, CLI exits 3.
- **Screenshots**: `shot(file)` = `wmctl shot <target> <tmp>` + readFile +
  `tests/lib/png.js` encode (`.ppm` extension writes raw P6); `screen()` /
  `sample(x,y)` expose the parsed composite. Each call is a fresh
  `wmScreenshotScreen` — bit-exact, no compositor furniture (standing scope).
- **Image lifecycle**: default a fresh throwaway in a `mkdtempOwned` dir
  (the 49 GB-leak-proof owner, `tests/lib/harness-temp.js`), `--keep-image`
  to keep it, `--image=PATH` for the ~150 ms warm-reuse path.
- Deliberately ABSENT (API honesty): `vt(n)` — headless has no VTs, the tty
  IS stdio; page/waitPixel/waitScreen — no live canvas exists. Documented in
  the header rather than stubbed.

## RULES fix (tests/run.js)

The old `/^tools\/os-drive/` prefix rule mapped the NEW file to `sweep` with
a false rationale ("drives os.html via os-harness") — a gate that cannot
observe it. Split per the net-bridge-ssh reasoning: `os-drive.mjs` keeps
`sweep`; `os-drive-headless.mjs` → `kernel`, the suite that proves the
boot.js/wmctl seam it rides. Verified: `--diff origin/main --dry-run` now
plans `todos, host` (the run.js edit) + `kernel` (the tool) and no sweep.

## Release-time verification plan (exact commands + predictions)

Run from `~/worktree/c-compiler/ticket-421`, foreground, in this order,
ONLY after @master's release from the heavy-lock stand-down.

1. **Green smoke (scripted mode).** Materialize `/tmp/osdrive421/smoke.mjs`:

   ```js
   import fs from 'node:fs';
   import crypto from 'node:crypto';
   export default async (drive) => {
     const r = await drive.run('echo hello');
     if (!r.out.includes('hello') || r.status !== 0) throw new Error('run: ' + JSON.stringify(r));
     if ((await drive.run('false')).status !== 1) throw new Error('status propagation');
     const blob = crypto.randomBytes(100000);
     await drive.putFile('/root/rt.bin', blob);
     const back = await drive.readFile('/root/rt.bin');
     if (!back.equals(blob)) throw new Error('round-trip mismatch');
     console.log('RT-OK 100000 bytes');
     await drive.sh('winbox &');
     const w = await drive.wmctl('wait win winbox');
     if (w.status !== 0) throw new Error('wmctl wait: ' + JSON.stringify(w));
     const { w: sw, h: sh } = await drive.shot('/tmp/osdrive421/desk.png');
     console.log('SHOT-OK', sw, sh, fs.statSync('/tmp/osdrive421/desk.png').size, 'bytes');
     console.log('SAMPLE', await drive.sample(512, 400));
   };
   ```

   `node tools/os-drive-headless.mjs /tmp/osdrive421/smoke.mjs`
   **Green looks like**: `RT-OK 100000 bytes`, `SHOT-OK 1024 768 <PNG >10KB>`,
   a SAMPLE rgb line, exit 0, and the PNG opens as a real desktop.

2. **Red control A — run timeout (predicted before running).** Script body:
   `await drive.run('sleep 5', { timeout: 1500 })`.
   **Prediction**: throws `run("sleep 5"): timed out after 1500ms` with
   stdout/stderr tails attached; CLI exits 1. Anything quieter is a driver bug.

3. **Red control B — the 0171 wait-timeout gate.** Script body:
   `await drive.wmctl('wait win nosuchwin 2000')`.
   **Prediction**: the run completes status 1, then the driver THROWS
   `wmctl wait timed out (a wait on an unreachable condition …)` naming
   `wmctl: wait win nosuchwin timed out after 2000ms`; CLI exits 1. A
   status-1-and-carry-on is a REJECTION of the driver.

4. **Red control C — transfer honesty.** Script body:
   `await drive.readFile('/root/does-not-exist')`.
   **Prediction**: throws `readFile(/root/does-not-exist): wc failed
   (status 1): …` (hush's can't-open text in the message); CLI exits 1.

5. **Red control D — heavy-lock refusal.** One foreground node -e that joins
   the heavy lock in-process (`tests/lib/heavy-lock.js`), then spawnSyncs
   `node tools/os-drive-headless.mjs /tmp/osdrive421/smoke.mjs` and prints
   its status/stderr.
   **Prediction**: the driver exits 3; stderr carries `[heavy-lock]` and
   `boot refused — heavy-test lock held` naming the fake holder.

6. **Restored-tree green**: re-run step 1 unchanged after the red controls
   (same tree — the controls are separate scripts, not edits) to close the
   red/green pair.

7. **The mandated gate**: `node tests/run.js --diff origin/main` → suites
   `todos, host, kernel`. **Green looks like**: `build/test-run/summary.json`
   written by THIS invocation, every result `pass`;
   `build/test-kernel/summary.json` `done: true, filter: null,
   files.recorded === files.total` (157 on current main), zero non-pass.

## Deviations / notes for @master

- The kickoff's NM-2 correction held: exactly one `node_modules` at the main
  tree; the single symlink sufficed.
- `tests/run.js` RULES edit is part of this diff — without it the tool's own
  rule pulled the sweep on a false rationale. It is a selection-table edit,
  not a member-registry edit (batching rule 3a.3 does not bite).
- No smoke/red-control script is committed — the ticket's "no test tier"
  contract; this log carries them verbatim instead.
