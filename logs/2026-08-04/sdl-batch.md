# SDL veneer batch — #491 + #493 + #495 + #497 (branch `sdl-batch`)

Four tickets from the #487 Pass A gamedev dogfood, batched on one branch with
one gate because every member edits `compiler.js` (the widest rule in
`tests/run.js` — all suites), so M lanes would cost M full gates on one
heavy lock. Epic justification: these ARE the epic's output — direct findings
from building Pong in C + SDL3 inside gucOS.

A correction that outlived the tickets: #493/#495 say the fix is "a small
addition to `__SDL.c`". There is no repo file by that name — `__SDL.c` is the
embedded TU key inside `compiler.js` (`_stdlibSources["__SDL.c"]`), and the
SDL.h header text lives beside it. All veneer edits land in `compiler.js`;
the JS runtime halves in `host.js`.

## #491 — pull-mode audio callback killed the process

Mechanism (verified, not assumed): `SDL_OpenAudioDeviceStream` already wrote
`return NULL` on the callback path, but it first called the throw-only host
import `__sdl_audio_callback_unsupported` — the throw unwound out of wasm
before the return executed.

The exit 1 vs exit 139 discrepancy is ONE bug with two reporters, not two
bugs: `tests/run-unit.js` catches the rejected `runModule` and forces
`runExitCode = 1`; under the OS, `process-worker.js` posts `crashed` and
`kernel.js` maps every crash to `W_TERMSIG(SIGSEGV)` → the shell reports
128+11 = 139. One fix covers both paths.

Fix chosen: **option B (C-side)** — `SDL_SetError(<the same guidance text>)`
+ the existing `return NULL`, matching the two neighbouring failure paths in
the same function (NULL-spec, device-open) which already do exactly this.
The throw-only import is retired from compiler.js and all four host.js env
flavors: an import that exists only to crash is a zombie once the C side
owns the message. Rejected alternatives: (A) host-side SetError — would need
a new error channel from host into the veneer's error buffer and leaves the
message split across two files; ticket option 2 (undeclare the callback
parameter) — rejected because `SDL_AudioStreamCallback` is SDL3's real
signature and a compile-time break on the *declared* API is worse for ports
than the contract-honest runtime NULL.

`os/image.json` → v237: stale browser OPFS images hold binaries that still
import the removed env member; the version gate is the mechanism that
retires them.

`tests/unit/sdl_audio_callback_throws` (which pinned the crash as
deliberate) → `sdl_audio_callback_pull_rejected`, now asserting the SDL3
contract: NULL return, error set, execution continues, exit 0.

## #493 — input state snapshots

State updates live where host-pumped events are synthesised (the
`__sdl_push_*` exports — this runtime's SDL_PumpEvents equivalent): 512-entry
scancode bool array, latched key mod, mouse button mask. Button events
set/clear the mask; motion events latch the host's full mask, so a release
delivered outside our windows self-heals. `SDL_GetGlobalMouseState` is
declared but always fails loud (0, 0,0, error set): a gucOS process only
sees pointer events routed to its own windows in client coords, and the
veneer does not know its windows' screen positions — desktop-global values
would be a lie. Making it real would need kernel support (a global-cursor
query or window-origin plumbing); flagged to the coordinator as a possible
follow-up, deliberately not silently approximated.

## #495 — sub-ms timing, and the clock was secretly whole-ms

`__sdl_now_ns` already existed as the event-timestamp ns source, so the
three new functions ride it (counter unit = ns, freq = 1e9, as SDL3 does on
POSIX clock_gettime backends). The load-bearing find: compiler.js's comment
claimed the host clock was "sub-ms precise via performance.now()" but ALL
THREE host flavors returned whole ms (two `Date.now()` diffs, one
`Math.floor(performance.now())`) — the new API would have quantised dt to
the exact judder it exists to remove. All three now return fractional
monotonic `performance.now()` deltas; `SDL_GetTicks` still truncates C-side,
so its values are unchanged. `tests/unit/sdl_timer_ns`'s sub-ms probe goes
red if whole-ms flooring is ever reintroduced; no wall-clock tolerances, so
it cannot flake under load.

## #497 — stop reporting success on invalid arguments

All eight rows of the ticket's table, following the veneer's existing
validation conventions and SDL3's error wording. Judgement calls:

- Texture cap 8192/dimension: the browser flavor's WebGPU default
  `maxTextureDimension2D`; the CPU flavors could go higher but one honest
  uniform limit beats a per-backend surprise.
- The one render driver is named `"gucos"`; NULL keeps SDL3's
  pick-the-default meaning; any other name fails ("Couldn't find matching
  render driver") rather than silently handing back a different backend.
- Destroyed-window detection is exact (live iff in the registry — destroy
  unregisters before freeing, so the check never touches freed memory).
  Destroyed-texture detection is a `__magic` tag — best-effort once the
  allocator reuses the block, the same trade upstream SDL makes. Both were
  LIGHT (a registry scan that already existed; one struct field + one check
  per entry) — nothing in the ticket needed splitting out.

## Batch instruments (pinned before the gate)

Distinct per member: #491 → `sdl_audio_callback_pull_rejected`,
#493 → `sdl_input_state`, #495 → `sdl_timer_ns`, #497 →
`sdl_arg_validation`. Expected: each new/renamed test passes; unit suite
grows by 3 files net (+4 new dirs −1 renamed away... the rename keeps the
count: 3 added, 1 renamed); no other suite's totals move.
