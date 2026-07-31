# gcode correctness band A — #304 SGR dim, #306 Ctrl+C interrupt, #305 REPL survival

Branch `gcode-band-a`, three tickets in dependency order, no image.json bump
(the presentation lane carries the band's single bundled bump).

## The readline probe (gates the next lane)

**Up-arrow history recall WORKS at the hush prompt — the tty raw-mode plumbing
is proven.** `printf 'echo FIRSTMARKER\n\x1b[A\n' | node os/boot.js --tty-out`
prints FIRSTMARKER twice: busybox lineedit (CONFIG_FEATURE_EDITING=y, history
64, compiled in via `src/libbb/lineedit.c`) engages raw mode over the kernel
tty and interprets the escape. The trap that makes this look broken: under
plain piped stdin boot.js deliberately keeps fd 1/2 non-tty ("piped runs stay
byte-clean"), hush never goes interactive, and the same probe yields
`hush: can't execute '[A'` — an artifact of the probe environment, not a
missing feature. `--tty-out` (or a human terminal) is the valid environment.

## #304 — term.c SGR 2 (dim/faint)

`do_sgr` gains A_DIM (attr bit2 was free); SGR 22 clears bold AND dim
(ECMA-48). The interesting part is ordering: dim halves the resolved fg RGB
*before* the reverse/selection/cursor swaps (the xterm order), so a reversed
dim cell carries its faint color into the background patch. That forced
`cell_colors` from palette-index outputs to packed-RGB outputs — indices can't
express "half of a palette entry".

Test determinism note worth keeping: over the black default bg, a bright glyph
core is exactly (220,220,220) and a dim core exactly (110,110,110) — and no AA
ramp of bright text can produce 110, because 110 = a·220/255 needs alpha 127.5.
Exact-value pixel counts therefore identify the two populations precisely
(sessionDim in test_term_e2e; scan excludes the scrollbar's 16px column). Red
control: pre-fix the exact-110 count is 10 stray pixels vs threshold 40.

## #306 — libcurl veneer: Ctrl+C aborts an in-flight response

The title was true and the delivery/consumption distinction matters: the
SIGINT was *delivered* (gcode's handler ran, g_interrupted was set), but
nothing ever read the flag — CURLOPT_XFERINFOFUNCTION fell to the veneer's
`default: CURLE_UNKNOWN_OPTION`, so the registered callback never existed and
`wait_step` just re-parked on EINTR forever. The whole fix is veneer-side
(`os/curl/libcurl.c` + `curl.h`); gcode.c was already correct end to end.

`check_progress` runs at every wait boundary in BOTH transfer loops (status
wait + body drain). The EINTR choreography: signal lands → `__wait` returns
EINTR (handler already ran) → wait_step returns retry → the next read gets
EAGAIN → check_progress sees the flag via the callback → close(fd) +
CURLE_ABORTED_BY_CALLBACK. NOPROGRESS became real in the same change (curl
contract: default 1 gates the callback off).

Evidence: smoke.c case 7 differential — real libcurl and the veneer both print
`rc=42 midstream=1` against a stalled stream; with the fix reverted the veneer
prints `rc=28 midstream=0` (the TIMEOUT_MS backstop) and the differential
flags it. gcode-level: fake_anthropic grew a `stall` response kind and
test_gcode_step2 run 4 SIGINTs a gcode parked mid-stream — the leg completing
at all is the early-close proof, since the server never ends the stream.
Incidentally fixed in passing (same contract comments the ticket named):
curl.h still described the pre-0417 SIGALRM timeout mechanism; rewritten to
the __wait wall-clock description.

## #305 — REPL survives a failed turn

`if (append_user_text(...) || agent_loop(...)) break;` meant ANY turn error
ended the session — and skipped session_end on the way out. The explicit
fatal-vs-recoverable call (per the ticket's recommended split): recoverable =
transport errors, non-auth HTTP != 200, timeouts, API error events → print the
red line, return to the prompt; interrupts (^C → CURLE_ABORTED_BY_CALLBACK →
-2) return 0 from agent_loop — prompt, dim "interrupted", never an error;
fatal = HTTP 401/403 (new -3 threaded do_turn → agent_loop → REPL, which
session_end("error")s — retrying auth cannot succeed) and /quit. One-shot -p
keeps exit-1-on-error.

History rule, decided: the failed user message STAYS — in-memory and in the
persisted JSONL alike, so a resume replays exactly what the live session
carries. Retry means retyping with context intact.

Also: a ^C that EINTRs the prompt `fgets` itself now re-prompts instead of
being mistaken for EOF, and the flag is consumed after each turn so a stale
mid-turn ^C can't eat a real EOF later.

Browser sweep upgrades that ride these fixes: os-gcode leg 4's Ctrl+C line was
"recorded, not judged" while interrupt was dead — promoted to a real check;
leg 5 gained the #305 discriminator (a follow-up send after the 500 must POST
— a dead gcode drops the line into hush and never reaches the server).
