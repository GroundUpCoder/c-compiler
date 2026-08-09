# #505 — the gcode orientation payload: content audit, a drift-pin test, and an honest null

**Lane-505.** #530 landed the layered `GCODE.md` mechanism *with* a starter
system-layer file that already carried most of #505's enumerated content set.
This lane's remit therefore shrank to three things: complete and correct the
content, make the doc's claims un-rottable, and run the ticket's two-sided
measurement properly.

## Content changes (os/gcode/GCODE.md, image 247→248)

- **Added the compiler flag surface** — the one run-B sentence missing from
  the #530 file: `cc` understands only `-o/-I/-D/-g`; every other flag
  (`-Wall`, `-O2`, `-c`, `-std=…`, `-l…`) is **silently ignored** (verified in
  `createCcDriver`, os-common.js — unknown dash options are dropped, CLI
  parity); no separate compile/link step; default `./a.out`. The silent-ignore
  half matters as much as the flag list: measured control runs re-ran
  `cc --version` three times trying to make sense of flags that did nothing.
- **Fixed a shipped factual bug**: the #530 file said `wmctl shot FILE`; the
  real shape is `wmctl shot SID|screen [FILE]` (os/wmctl.c usage). An agent
  following the doc as written got a usage error. Also named the SID column in
  `wmctl list` so the shot invocation is closed-loop.
- **Named `/usr/include` as the authoritative SDL surface** (the ticket's
  run-B sentence), not just the sdl-gucos.md pointer.

Not derivable from a live seam (hand-written, now test-pinned instead): the
flag list itself, the wmctl shapes, and the loop-model summary. Where a real
seam existed the doc now points at it (`/usr/include`, the usage strings,
`/usr/share/doc/sdl-gucos.md`).

## The drift pin (tests/host/test_gcode_orientation.js)

The doc is acted on directly by agents, so a wrong claim is worse than a
missing one — and it already shipped one. The new host test pins every
mechanically checkable claim: doc-named file paths must be `image.json` keys;
the cc flag surface is exercised **behaviorally** through the real
`createCcDriver` over an in-memory BlockFS (the documented-as-ignored flags
really are ignored, exit 0, wasm out); wmctl verbs + the shot shape against
`os/wmctl.c`'s usage table; the SDL loop-model claims cross-pinned to
`os/doc/sdl-gucos.md`. Extractor-backed checks carry red controls (the #97
standard), including a replay of the shipped `shot FILE` claim.

## The measurement — what replicated and what did not

**Contrast 1 (replication of #530/#488): `--no-context` vs baked GCODE.md.**
Same image, same model (deepseek-v4-flash), same request, equal caps.
Unguided runs burned their early rounds on platform rediscovery (`which gcc
clang pkg-config`, ncurses probes, `find / -name 'libSDL*'`, `file /bin/cc`,
`cat /bin/cc`), wrongly concluded "no SDL", and produced tty-fallback games
that **did not compile** (2/2 runs). The oriented run did zero fs-wide
discovery, wrote an SDL3 `SDL_MAIN_USE_CALLBACKS` game, and it **builds
clean**. That is #530's effect, re-confirmed on today's image.

**Contrast 2 (this lane's actual delta): #530's GCODE.md vs this one.**
n=3 per arm via the `GCODE_CONTEXT_ROOT` seam (same image, only the context
bytes differ). **Null.** builds-at-cap-12: baseline 1/3, this file 0/3; wall
74–276 s vs 79–248 s; every single run consumed all 12 turns (fully
censored — the model always spends its whole budget). The recurring
at-cap failures were `SDL_Log`, `SDLK_r`/`SDLK_R`, `sqrtf`, `snprintf`/
`SDL_snprintf` — SDL-subset and libc-surface facts that neither file states.
The +16 lines do not measurably move this instrument; the value of the edit
rests on the factual fix, the flag-surface completion (both standalone), and
the drift pin.

**Observation worth a follow-up ticket:** the recurring cap-time failures
above are themselves orientation gaps — a "commonly-missing symbols" line
(SDL_Log/SDLK letter keys/libm-vs-`__require_source("__math.c")`) is what the
measurement says would actually move builds-at-cap next.

Evidence: `s3://groundupcoder/gucos/505/2026-08-09/` (contrast 1: 3
transcripts + 3 artifacts; `corrected/`: 6 transcripts).

## Gate

`--diff origin/main` → host + kernel + sweep (GCODE.md and image.json price
kernel+sweep since #622 — this lane is that rule's first customer). Result
recorded in the lane report; heavy-lock contention with two concurrent
sibling gates made scheduling the run the hard part.
