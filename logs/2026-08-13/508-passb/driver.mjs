#!/usr/bin/env node
// #508 Pass B round 2 driver — boots gucOS headless and drives the tty like a
// human at the keyboard. The DeepSeek key is read HERE and every byte that
// reaches a log or stdout is scrubbed first; the key itself is injected by
// replacing the literal placeholder ${KEY} in step "send" strings.
//
// usage: node passb/driver.mjs steps.json [logfile]
// steps.json: [ {"send": "text\n"}, {"waitFor": "regex", "timeoutMs": 60000},
//               {"sleep": 1500}, {"note": "..."} ... ]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const KEY = fs.readFileSync(path.join(HOME, '.guc/creds/deepseek-api-key'), 'utf8').trim();
// The tty echoes what we type, and the echo (a) arrives in arbitrary chunks
// and (b) may wrap mid-key with \r\n. Scrub with a wrap-tolerant regex, and
// only ever flush log bytes through a holdback window bigger than any
// possible key occurrence, so a key can never straddle a flush boundary.
const KEYRE = new RegExp(
  KEY.split('').map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(?:\\r?\\n)?'), 'g');
const scrub = (s) => s.split(KEY).join('***KEY***').replace(KEYRE, '***KEY***');

const stepsFile = process.argv[2];
const steps = JSON.parse(fs.readFileSync(stepsFile, 'utf8'));
const logFile = process.argv[3] || stepsFile.replace(/\.json$/, '') + '.log';
const log = fs.createWriteStream(logFile, { flags: 'a' });
const HOLD = KEY.length * 2 + 32;
let hold = '';
const logWrite = (s) => {
  hold = scrub(hold + s);
  if (hold.length > HOLD) {
    log.write(hold.slice(0, hold.length - HOLD));
    hold = hold.slice(hold.length - HOLD);
  }
};
const logFlush = () => { log.write(scrub(hold)); hold = ''; };
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(7);
const note = (line) => {
  const s = `\n[${stamp()}s] ${line}\n`;
  logWrite(s);
  process.stdout.write(scrub(s));
};

note(`RUN ${stepsFile} @ ${new Date().toISOString()}`);
const boot = spawn('node', ['os/boot.js', '--image=build/passb/os-system.img',
  '--tty-out', '--wait-lock=900'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
boot.stdout.on('data', (d) => { const s = d.toString('utf8'); buf += s; logWrite(s); });
boot.stderr.on('data', (d) => { const s = d.toString('utf8'); buf += s; logWrite(s); });
let exited = false;
boot.on('exit', (c, sig) => { exited = true; note(`BOOT EXIT code=${c} sig=${sig}`); });

function waitFor(re, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (re.test(buf)) { clearInterval(iv); resolve((Date.now() - started) / 1000); }
      else if (exited) { clearInterval(iv); reject(new Error('boot exited')); }
      else if (Date.now() - started > timeoutMs) { clearInterval(iv); reject(new Error('timeout')); }
    }, 100);
  });
}

let aborted = false;
for (const st of steps) {
  if (aborted) break;
  if (st.note) note(`NOTE: ${st.note}`);
  if (st.send !== undefined) {
    note(`SEND: ${JSON.stringify(st.send)}`);
    buf = '';
    boot.stdin.write(st.send.replaceAll('${KEY}', KEY));
  }
  if (st.waitFor) {
    try {
      const secs = await waitFor(new RegExp(st.waitFor, 's'), st.timeoutMs || 60000);
      note(`MATCHED /${st.waitFor}/ after ${secs.toFixed(1)}s`);
    } catch (e) {
      note(`FAILED waiting for /${st.waitFor}/ (${e.message}) after ${(st.timeoutMs || 60000) / 1000}s — aborting remaining steps`);
      aborted = true;
    }
  }
  if (st.sleep) await new Promise((r) => setTimeout(r, st.sleep));
}
if (aborted) {
  // graceful: ^C the in-flight turn, then /quit the REPL, then let EOF halt
  note('abort path: sending ^C then /quit');
  boot.stdin.write('\x03');
  await new Promise((r) => setTimeout(r, 5000));
  boot.stdin.write('/quit\n');
  await new Promise((r) => setTimeout(r, 3000));
}
note('steps done — closing stdin (EOF halts the boot)');
try { boot.stdin.end(); } catch {}
const killer = setTimeout(() => { try { boot.kill('SIGKILL'); } catch {} }, 20000);
killer.unref();
if (!exited) await new Promise((r) => boot.on('close', r));
note(`run complete, aborted=${aborted}`);
logFlush();
log.end();
process.exit(aborted ? 1 : 0);
