# #433 — tty: ^C flushes queued cooked input (POSIX INTR input-queue flush)

## The bug

VINTR cleared only the in-progress EDIT buffer (`this._line.length = 0`).
COMPLETED type-ahead lines — typed + Entered while a command was running — were
already pushed into the cooked queue (brokered `_cooked`, or the SAB input
ring) at their Enter, and the ISIG branch flushed neither. With no
tcflush/TCFLSH anywhere, no app could flush it either. Visible symptom: ^C
during a gcode turn, then the queued type-ahead auto-submits as the next user
message at the fresh prompt (gcode.c read_input_line). Same class for any tty
app, hush included. POSIX 11.1.9: INTR/QUIT/SUSP flush the input AND output
queues unless NOFLSH.

## The fix (kernel.js)

One helper, `Tty.prototype._flushInput` — the tcflush(TCIFLUSH) core — shared
by the ISIG signal chars (new) and TCSAFLUSH (moved onto it):

- brokered: `_cooked.length = 0`
- ring: `AVAIL = 0` first, then `READPOS = WRITEPOS`

In the ISIG branch, a signal char now discards the un-pushed raw burst, the
edit buffer AND the cooked queue — unless **NOFLSH** (0x80000000, already in
libc's termios.h; the kernel just never read it) is set, in which case nothing
is discarded (Linux n_tty isig semantics: NOFLSH also preserves the edit
buffer, which the old code cleared unconditionally — a behavior change only
for a bit nobody could previously set).

## Concurrency reasoning (the ticket asked for this explicitly)

- **Brokered (the OS proper): trivially safe.** `_cooked` lives on the kernel
  thread; a parked FS_READ waiter holds no snapshot of it — it gets served
  later from whatever the queue then contains, or EINTR from the signal that
  the same keystroke posted.
- **Ring, parked reader: safe.** A reader parked on the SI_SEQ futex re-loads
  SI_AVAIL fresh after every wake (`host.js _readStdinSab`). Zeroing AVAIL
  FIRST, then moving READPOS, means a reader arriving mid-flush sees "empty"
  and parks — it never reads through a torn index pair. (The old TCSAFLUSH
  order was READPOS-then-AVAIL; unifying on the helper tightens that too.)
- **Ring, reader INSIDE an avail>0 consume at the flush instant:** its
  unconditional `Atomics.sub` can drive AVAIL negative. This is the same
  few-instruction race the TCSAFLUSH comment has accepted since Phase 3
  ("flush during concurrent reads is undefined" — POSIX agrees), it is NOT
  widened by this change, and it is unreachable in the OS proper (brokered).
  Closing it fully would need a CAS-retry consume in host.js's reader — not
  worth touching every process's stdin path for a window that requires the
  user's ^C to land inside another thread's four-instruction consume.

## Descopes (recorded, not silent)

- **Output-queue flush** (pty slave→master buffer): out of scope per the
  ticket; noted in the Tty header comment. No observed symptom.
- **tcflush(3)/TCFLSH as an API**: still absent; this ticket only wires the
  ISIG-char flush. (The helper is shaped to serve a future TCFLSH RPC.)

## Tests (red-first; all three shown failing on unmodified kernel.js)

- `test_tty.js` (ring): type-ahead queued (avail 12) → ^C → avail 0, next
  read sees only post-^C bytes; NOFLSH legs (queue AND edit buffer survive,
  SIGINT still fires). Pre-fix: 3 FAIL (avail stayed 12; queued line
  delivered; NOFLSH edit buffer was cleared). Post-fix: 46/46.
- `test_pty.js` (brokered): queued line + ^C + fresh line → FS_READ returns
  `fresh\n` only. Pre-fix: read returned `queued line\nfresh\n`. Post-fix
  68/68.
- `test_gcode_intr_flush_e2e.js` (NEW, registered in tests/kernel/run.js):
  the user symptom end-to-end — paced interactive Session (jobctl machinery)
  + the stalling fake SSE server; type-ahead mid-stream, ^C, /quit.
  Instruments: bodies.jsonl POST count 2 → 1; 'SHOULD-NOT-HAPPEN.' sentinel
  streamed → absent.

## Blast-radius check

Audited every existing ^C/^Z sender: test_jobctl_tty_e2e paces with
expect-before-send (queue provably empty at each signal char — passes
unchanged); no driveBoot script embeds \x03/\x1a (a piped script IS cooked
type-ahead under boot.js, so an embedded ^C would now discard queued script
lines — none exist); no browser test types raw ^C into the tty.
