# gcode: the #507 "waiting for model" heartbeat never fires in-OS — 60-180s of total silence on slow rounds

**Class: quality-gap. Found by #508 Pass B round 2, observed at commit e704f078.**

## The gap

#507 shipped a two-half progress signal: tool-call heartbeats ("… running Ns", works) and an API-wait heartbeat ("… waiting for model Ns", `gcode.c:501-533`, armed at `gcode.c:2594-2599` via `CURLOPT_XFERINFOFUNCTION` + `CURLOPT_NOPROGRESS 0`). The API half is structurally dead in-OS:

- The curl veneer only invokes the progress callback at **wait boundaries** (`os/curl/libcurl.c:245-248 check_progress`, called from the status/body loops at 424/501).
- `wait_step` (`os/curl/libcurl.c:226-237`) parks in `__wait(&fd, 1, 0, timeout_ms)` with `timeout_ms = -1` when no `CURLOPT_TIMEOUT` is set — and gcode sets only `CONNECTTIMEOUT` (`gcode.c:2594`), which rides the transport's headers deadline, not the veneer's wait loop.
- So during a silent model wait the callback runs once (at <2s, below the display threshold) and then the process parks **indefinitely** until first bytes or a signal. No tick, no heartbeat.

## Measured harm

Session JSONL from this pass (235 api_rounds over 7 turns): median inter-round 5s, but **7 rounds exceeded 60s (max 180s) with zero bytes of output** — twice a driver mistook it for a wedge and ^C'd a healthy turn. A human at the REPL cannot distinguish "wedged" from "model is slow on a 100K-token resumed prompt", which is exactly the distinguishability #507 exists to provide. Interactive resumed sessions routinely carry >100K-token prompts (cache-miss first rounds are the slow ones).

## Fix shape

When a progress callback is registered (NOPROGRESS 0 + cb), `wait_step` should park in bounded chunks (e.g. `min(remaining, 1s)`) so `check_progress` ticks — the veneer's own comment already claims "every wait boundary … asks the callback"; make the boundaries exist. Alternative: gcode passes a per-chunk timeout. Either side works; the veneer-side fix also serves every other curl consumer.

## Gamedev justification

The in-OS agent loop is the epic's gcode-authored arm; "enjoyable" fails when the tool looks hung for 3 minutes per slow round.

Evidence: `s3://groundupcoder/gucos/508-passb-r2/2026-08-13/` (s3-resume-intr.log and s3b: 60s of nothing then ^C shows "interrupted, input=0 output=0"; s4-patience.log: same turn completes at 373s; evidence/sessions/*.jsonl for the latency distribution).
