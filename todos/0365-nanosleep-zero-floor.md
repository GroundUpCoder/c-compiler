# 0365 — nanosleep(0) floors to 1 ms on the JSPI backend but not on block-FS

- **Status**: open
- **Design**: —
- **Found by**: todos/0361, while building `tests/host/test_sleep_clamp.js`

## Goal

The two sleep backends in `host.js` disagree about a **zero-length**
`nanosleep`, and one of them is POSIX-wrong. Make them agree.

`host.js` native-fs / CLI flavor (JSPI):

```js
__nanosleep: new WebAssembly.Suspending(async function (sec, nsec) {
  const ms = sec * 1000 + nsec / 1e6;
  await new Promise(resolve => setTimeout(resolve, Math.max(1, ms)));
```

`host.js` block-FS flavor (the `Atomics.wait` primitive) has no such floor —
`blockingSleepMs` is a documented no-op for a non-positive duration:

```js
__nanosleep: function (sec, nsec) {
  if (!_canBlock) { setErrnoName('ENOSYS'); return -1; }
  blockingSleepMs(sec * 1000 + nsec / 1e6);
```

So `nanosleep(&(struct timespec){0,0}, 0)` returns immediately under `--block-fs`
and sleeps a full millisecond under the CLI. POSIX: a zero request "shall return
immediately". The sibling `usleep` has no floor on **either** backend, which is
what makes this look like a slip rather than a decision — nothing in the tree
states a reason for the `Math.max(1, ...)`.

**Priority note.** Filed **P0** because CLAUDE.md says so without qualification
("any bug found from anywhere — a report, a manual UX sweep, an incidental
discovery — is filed P0 unless the user explicitly says otherwise"), and
declining to follow that on my own read of the magnitude is the silent-demotion
the policy forbids. It is nonetheless a long-standing wrongness of tiny
magnitude with no known consumer, not a regression: `node todos/queue.js
set-priority 0365 1` if that is the better call.

**MASTER RULING (cont-122, 2026-07-28) — DEMOTED P0 → P1.** The lane did the
right thing: it filed P0 per the unqualified rule and **flagged rather than
demoting silently**, which is what makes this ruling reviewable at all. The
demotion, and the reasons, on the record:

1. It is **not a regression** and has **no known consumer** — no code in the
   tree requests a zero-length `nanosleep` and cares.
2. The P0 band in this queue currently means *miscompile* (`0362` selector
   gap, `0367` bit-field unary). Seating a 1 ms sleep floor beside a bit-field
   miscompile **devalues the band**, which costs more than this ticket is
   worth.
3. It is nonetheless a **real backend divergence**, which is the shape that
   manufactures false-green tests later — precisely what `0361` found. So it
   does **not** drop to P2 either. P1 is the honest seat.

⚠️ This is a MASTER ruling, not a jku ruling. Do not let it launder into
"jku decided." If jku says otherwise, jku wins.

## Why it was not caught

The wall-clock unit tests (`stdlib/nanosleep`, `blockfs_nanosleep`) only ever
requested 50 ms, and a 1 ms floor is invisible at 50 ms. `tests/host/`
`test_sleep_clamp.js` (0361) is the first thing in the tree that can see a floor
at all — it records the millisecond value handed to the primitive — and it
deliberately asserts **neither** answer for the zero input, because pinning the
floor would bless it as correct.

## Plan

1. Decide the contract. Almost certainly: no floor on either backend (match
   `usleep`, match POSIX). If the floor IS load-bearing on the JSPI path —
   e.g. some caller depends on nanosleep yielding the event loop — say so in a
   comment and give block-FS the same floor, so the two agree either way.
2. Implement in `host.js`.
3. Add the `nanosleep(0, 0)` assertions to `tests/host/test_sleep_clamp.js`
   (its `KNOWN GAP` block names this ticket) on both backends.
4. Retire register entry **L53**.

## Acceptance

- `nanosleep(0, 0)` behaves identically on both `host.js` backends, and the
  behaviour is asserted in `tests/host/test_sleep_clamp.js` for each.
- The `KNOWN GAP (todos/0365)` block in that test is gone, and L53 is retired
  from `todos/LIABILITIES.md`.
- `node tests/run.js host blockfs unit` green.
