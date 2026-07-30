# 0440 — WebSockets as a first-class gucOS capability (ws OFD kind + curl_ws veneer)

- **Status**: open
- **Blocked by**: `todos/0417` (HTTP transfers become OFDs) — hard.
- **Design**: `~/git/meta/gucos/notes/websockets-and-platform-limits.md` Part 1.
  🔴 **That memo is the authority. Read Part 1 in full before you plan.**
- **Provenance**: jku asked on 2026-07-30 whether gucOS must get first-class
  WebSockets, and what the platform loses without raw TCP. A read-only design
  pass answered both questions. This ticket is the first half of its output.

## 🔴 READ FIRST — why this ticket exists, and why it is NOT urgent

**This capability is NOT a prerequisite for the codex work.** An earlier
conclusion said codex forces WebSockets, and that only a code change avoids them.
**That conclusion is refuted.** `supports_websockets` is a configuration key on a
model provider (`model-provider-info/src/lib.rs:138-140`), and codex also has an
automatic, tested, sticky HTTP fallback (`core/src/client.rs:508-527`).
⚠️ **The refutation is narrow. It kills a conclusion about transport selection,
and nothing else.** `disable_websockets` really is a private atomic latch, and
the built-in OpenAI provider really does hardcode `true`. See `todos/0418` scope
fact (a), which carries the full correction and says which original observations
survive.

**So this ticket stands on the platform case alone**, and the platform case is
good: `todos/NETWORK.md:15-19` names the four transports the browser gives —
fetch, WebSocket, WebTransport and WebRTC. Tier 2 (fetch) landed. WebSocket is
the **only** one of the remaining three that is bidirectional **and**
zero-install. Tier 4 (`todos/0054`, the relay) recovers arbitrary TCP, but only
when the user runs a local relay process, so "an OS in a tab" loses its
zero-install property. WebSockets keep it.

Consumers this unlocks with no local process: realtime model APIs, MCP over
WebSocket, the Language Server Protocol, and `websockify`.

## Goal

Give a gucOS program a WebSocket connection as an ordinary file descriptor, so
that it works with `select`, `poll` and the rest of the existing fabric.

## Design — the shape is already settled, and it has two precedents

POSIX has no WebSocket API. The estate crossed this same bridge twice.
`todos/KERNEL.md:806-809` reserves the seam, and it says WebSockets become **new
op kinds beside** the 0x06xx HTTP family, not changes to the existing ones.
Follow these decisions:

1. **A `ws` OFD kind.** `WS_OPEN(url, protocols, deadlines) → fd`, in a new op
   block beside 0x06xx. `close(2)` releases the fd. The last release closes the
   socket — the `todos/0417:88-92` pattern.
2. **The fd is readable when a consumable is pending**: a completed handshake
   that nobody consumed, a queued message, a received remote close, or an error.
   🔴 **Write an explicit `_selectScan` branch.** The default arm reports
   always-readable (`todos/0417:119-122`, precedent `kernel.js:6766`). The
   `statusConsumed` lesson (`todos/0417:102-108`) applies to the open event
   without change.
3. **The fd never parks. It gives `EAGAIN` when it is dry.** `todos/0417`
   settled this for the whole fabric, and the reason is the same here: `__wait`
   does not name the ready fd, so the consumer reads until `EAGAIN`. The kernel
   has no `O_NONBLOCK` machinery (`todos/0417:136-138`). Do not add one.
4. 🔴 **Message boundaries are the one genuinely new contract.** WebSocket is
   message-framed. A byte-stream `read()` that splits a frame destroys the
   boundary silently. **Use length-prefixed records through `FS_READ`**: the
   kernel queues each message behind a small fixed header (opcode, fin,
   length), and `FS_READ` drains bytes. The boundaries then live in the bytes,
   so every buffer size works, and a split header reassembles in the veneer.
   This is the watch-fd precedent (`todos/done/0264:28-29`). The alternative —
   one whole message for each `FS_READ`, with `EMSGSIZE` — forces worst-case
   buffers on every caller. **Take the record form.**
5. **Send with an explicit `WS_SEND(fd, opcode, payload)` op.** Framing flags do
   not fit the byte contract of `FS_WRITE`.
6. **Deadlines: reuse the two-deadline shape of `todos/0417:161-180`** — a
   handshake deadline and an optional idle deadline, kernel defaults, and
   `ETIMEDOUT`. 🔴 **The idle deadline must be disableable**, because a quiet
   open connection is legitimate. `todos/0417:171-173` already provides this
   for streams.
7. **TLS**: `wss://` rides the browser and Node WebSocket stack, which owns TLS.
   This agrees with the settled boundary at `todos/NETWORK.md:88-89`.
8. **The C veneer extends `os/curl/`.** libcurl 7.86 and later ship a WebSocket
   easy API: `curl_ws_send` and `curl_ws_recv`, with a `curl_ws_frame`
   descriptor that expresses partial delivery through `bytesleft`. The same
   reasoning that chose the curl easy interface for Tier 2
   (`todos/NETWORK.md:34-37`) chooses `curl_ws_*` here.
   ⚠️ **This is the main open design choice** — `curl_ws_*` against a small
   bespoke `os/websocket.h`. Make the choice, write the reason, and do not leave
   it implicit.

### The Rust seam costs nothing. Do not open a second namespace.

`wasm32-unknown-unknown` has no input and no output, so every host call is
already an import. On the host side a capability is more named functions merged
into the ONE import object: `host.js:11243` is
`Object.assign(imports[ENV_KEY], createHttp(ctx, …)[ENV_KEY])` over
`ENV_KEY = "c"`. A `createWs(ctx)` factory adds its names in the same way that
`createHttp` added `__http_open` … `__http_close`
(`host.js:6014-6019, 6022`). On the Rust side,
`#[link(wasm_import_module = "c")]` in `gucos-sys` (`todos/0414`) declares them.
That attribute is stable: no nightly, and no custom target.
🔴 **`todos/RUST.md` §3 rule 1 (one ABI) is preserved, not tested.** The only
place a second namespace genuinely appears is `todos/0418` option (b), the
`wasip1` shim. **Do not blur the two questions.**

### Two things this ticket must record honestly

- ⚠️ **Send backpressure is a wart.** The browser `WebSocket` API exposes
  `bufferedAmount`, but it gives **no drain event**. So the kernel must either
  cap the buffer and give `EAGAIN` with a timer-polled drain, or buffer without
  a limit behind a hard cap error. (`WebSocketStream` has native backpressure
  and is Chromium-only — the same status as `duplex:'half'`. Note it and skip
  it.) **This wart is the one place the estimate can grow.** Ping and pong
  belong to the browser stack. The close code and the reason surface on the
  close leg of the fd.
- ⚠️ **UNMEASURED**: whether this estate's Node has the global `WebSocket`.
  Node 22 and later ship it through undici. **Run one `node -e` check when you
  start.** The `ws` package is the fallback, and Tier 4 already assumes Node
  WebSocket plumbing for the relay.

### The kernel already dials `ws://` today

It does so as a private Tier 4 relay transport. That code is **kernel-internal
plumbing, and it is a separate surface**. Share the plumbing if it helps. Do not
merge the two surfaces, and do not make the relay depend on this fd.

### Do NOT change the shape of 0417 to anticipate this ticket

Everything this ticket needs from 0417 is the **pattern** — the OFD kind, the
`_selectScan` branch, the `EAGAIN` discipline, and the deadline plumbing — and a
pattern replicates for free. `todos/done/0264` already proved that it replicates
cleanly. To abstract a generic "async event OFD framework" before a second
consumer exists is speculative generality. **Land 0417 as written. This ticket
cites it as precedent.**

## Plan

1. Check the Node global `WebSocket` on this box, and record the answer.
2. Add the op family beside 0x06xx, with the `ws` OFD kind, the explicit
   `_selectScan` branch, and the record-framed receive queue.
3. Add `createWs(ctx)` in `host.js`, merged into the `"c"` import object, with
   the `ENOSYS` arm of the `host.js:6009` pattern, so that an embedder with no
   network fails loudly.
4. Make the veneer decision, then write the veneer in `os/curl/`.
5. Write an end-to-end test against a local WebSocket server, in **both**
   embedders.

## Acceptance

- A gucOS program opens a WebSocket, sends a message, receives a message, and
  closes the connection. The test runs in the browser embedder **and** in the
  headless embedder.
- The fd works with `select` and `poll`. A test proves the explicit
  `_selectScan` branch: an fd with nothing pending must **not** report readable.
- A test splits one message across more than one `FS_READ`, and it proves that
  the veneer reassembles the message. A test with a small buffer must not lose a
  boundary.
- A read on a dry fd gives `EAGAIN`. The fd never parks.
- The handshake deadline gives `ETIMEDOUT`. A test proves that the idle deadline
  can be disabled, and that a quiet connection stays open.
- The C header ships with the capability, and the embedder with no network gives
  `ENOSYS`.
- The ticket records the veneer decision and its reason. It also records the
  send backpressure choice and its reason.
- `node todos/queue.js check` passes.

## Estimate

⚠️ **FIRST ESTIMATE. No lane has scoped this.** One ticket, one lane. The scale
is comparable to `todos/done/0264` (FS_WATCH), and it is smaller than
`todos/0417`, because 0417 pays the design cost of every shared decision first.
The send backpressure wart is the one place it can grow.
