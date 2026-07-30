# 0446 — gucos-rust gucos-sys::http still binds the retired 0417 id-based HTTP ABI

- **Status**: open
- **Design**: —
- **Repo**: the SIBLING repository `~/git/gucos-rust`, not this tree

## Goal

Convert `~/git/gucos-rust/crates/gucos-sys/src/http.rs` to the fd-shaped HTTP ABI that
`todos/done/0417` shipped, and prove it with a real caller.

0417 made an HTTP transfer an ordinary fd. It retired the `HTTP_READ` (`0x0604`) and
`HTTP_CLOSE` (`0x0605`) opcodes, dropped `__http_read` and `__http_close` from the host
import surface entirely, and changed `__http_open`'s arity. The sibling Rust crate was
**not** converted in the same change, and nothing in this repo's gate can see it.

Measured 2026-07-30 at `1cc04833` (the 0417 merge commit) against `http.rs` (104 lines,
`pub mod http` at `lib.rs:110`). **Three distinct breaks, and they do not fail the same
way:**

1. **`__http_open` arity 5 → 7.** `http.rs:14` declares
   `__http_open(method, url, headers, bptr, blen)`. The host now supplies
   `__http_open(methodPtr, urlPtr, headersPtr, bodyPtr, blen, headersMs, idleMs)`
   (`host.js:6039`). A wasm import signature mismatch is a **`LinkError`** — loud.
2. **`__http_read` and `__http_close` no longer exist.** `http.rs:22-23` declares both and
   `Drop` calls `__http_close` at `http.rs:89`. Post-0417 `createHttp` exports exactly
   **two** imports, `__http_open` and `__http_status` (`host.js:6039`, `:6065`); neither
   retired symbol appears anywhere in `host.js` or `compiler.js`. **`LinkError`** — loud.
3. 🔴 **`__http_status` still links and its SEMANTICS changed silently.** Same arity (4),
   so nothing fails at instantiation. But its first argument is now an **fd**, not an id;
   it **no longer parks** (it returns `EAGAIN` before headers arrive) and it **consumes**
   the status via the `statusConsumed` bit. `http.rs:50-62` calls it twice expecting the
   old parking behaviour. **This is the dangerous one — the only break with no loud
   failure mode.**

Also: `Transfer` holds an `id` (`http.rs:43`) that is now an **fd**, and `Drop` must
release it with the ordinary fd close rather than `__http_close`. As written the fd
**leaks**.

### Why this is P1 and not P0

**Nothing that ships is broken today** — verified, not assumed:
- No crate calls `http::`: `grep -rn "http::" crates` outside `gucos-sys/src` is empty.
- All three built artifacts import **zero** `__http_*` symbols
  (`strings out/*.wasm | grep -c __http_` ⇒ `0` for `hello-rust.wasm`, `alloc-rust.wasm`,
  `wc-rust.wasm`), so Rust's dead-code elimination drops the unused externs.
- `build.sh:84-86` builds only `hello-gucos`, `alloc-demo` and `wc-rust`; none does HTTP.

⇒ The module is **latent, uncalled and dead on arrival.** The first person to write a Rust
HTTP caller gets breaks 1 and 2 as a `LinkError`, and break 3 as wrong behaviour. Fix it
before there is a caller, not after.

## Plan

1. Convert `http.rs` to the fd model. The primitives already exist in the same crate — do
   **not** add a parallel path: `fs::open` / `fs::close_fd` and the `Fd` type
   (`fs.rs:158`, `:163`), and the `wait` module (`crates/gucos-sys/src/wait.rs`).
2. `__http_open` gains `headers_ms` and `idle_ms`. Expose them in the Rust signature,
   including the documented `idle_ms < 0` "disable the idle clock" case for SSE. Do not
   paper the two new parameters over with hardcoded kernel defaults.
3. Drop the `__http_read` and `__http_close` externs. Read the body through the ordinary
   fd read path (it **never parks** and returns `EAGAIN` when dry) and release the
   transfer through the ordinary fd close. `Drop` releases the **fd**.
4. Handle `EAGAIN`-before-headers and the consume-once `statusConsumed` semantics in
   `status()`. Do not invent the contract — read `kernel.js`'s `_selectScan` `http` branch
   (`kernel.js:6838`) and the `createHttp` contract comment (`host.js:6010-6021`) and
   match them.
5. Make the transfer **waitable** from Rust, since being waitable is the entire point of
   0417: an fd read subscription through the `wait` module, alongside a normal fd.
6. Prove it with a caller. A crate that fetches over HTTP, built by `build.sh`, is what
   turns this module from untested source into a tested rung.

## Acceptance

- `gucos-sys::http` compiles and links against the post-0417 host with **no** reference to
  `__http_read` or `__http_close`, and with `__http_open`'s full 7-argument signature.
- A **new** demo crate performs a real HTTP fetch in gucOS and asserts the response body,
  built by `build.sh` on **stable** rustc. Its `.wasm` imports `__http_open` /
  `__http_status` and **no retired symbol** — assert with the `strings … | grep -c` probe
  used above and **report the number**.
- The transfer is **waited on** through the `wait` module together with a second fd, and
  the test asserts both wake. That is the 0417 capability, exercised from Rust.
- `Drop` releases the fd, and a test asserts no fd leak across repeated transfers.
- The `ETIMEDOUT` deadline path is exercised: a transfer whose headers deadline expires
  surfaces a distinguishable, consumable error rather than hanging.
- 🔴 **A red control.** Prove the new test FAILS against the pre-0417 host, or that the old
  `http.rs` fails to link against the current host with the `LinkError` text quoted.
  **Break 3 has no loud failure mode, so a test that passes both before and after has not
  tested it.**
- No second or compatibility HTTP path is kept for the retired ABI. The estate rejects two
  paths; 0417 deleted the id path deliberately.
- 🔴 The gucOS **base image stays byte-identical** — this is a sibling-repo change plus a
  new demo crate. Report the number.

## Notes

- `~/git/gucos-rust` is a **separate repository** with its own `main`. A change there plus
  any change in this tree is a two-repo pair: land them as one logical unit and verify the
  consumer end-to-end, per the (FE) lesson in `~/git/meta/meta/notes/master-traps.md`.
- Provenance: found by @master (cont-215) during the 0417 merge, by asking what a consumer
  READS and whether it is under version control. The 0417 lane's report did not mention the
  Rust sibling, and its own gate structurally could not see it.
