# wmctl key: omitted KEYSYM injects keysym 0 — events no char/SDLK-matching app can see; derive it from the scancode

**Class: quality-gap. Found by #508 Pass B round 2, observed at commit e704f078.**

## The gap

`wmctl key SID SCANCODE [KEYSYM [MOD]]` documents KEYSYM as optional, and `os/wmctl.c:929` defaults it to **0** when omitted. But gucOS SDL apps match keys on `event.key.key` — char literals (`'r'`) or `SDLK_*` — per the platform's own guidance (GCODE.md: "`event.key.key` is the modifier-applied ASCII character"). A keysym-0 event is therefore invisible to virtually every app: the injection "succeeds" and nothing reacts.

Measured cost: the dogfood agent play-testing its game injected `wmctl key $SID 80` (LEFT scancode), saw no rotation, and burned several rounds + one full restart cycle discovering it must pass `1073741904` (SDLK_LEFT) explicitly — then had to hand-carry numeric keysyms for every key. Round 1's pass lost a boot cycle to the adjacent trap (#501, non-numeric args atoi→0).

## Fix shape

When KEYSYM is omitted, derive it from the scancode the same way real input does (the kernel owns the scancode→keysym mapping and applies modifiers by keysym; wmKey is the reference path) — so `wmctl key SID 80` delivers what pressing Left actually delivers. An explicit KEYSYM argument keeps overriding. Contract stays backward-compatible: today's "0" behavior serves no consumer a derived value would break (an app matching keysym 0 is matching "no key").

## Gamedev justification

`wmctl` injection is the only headless play-test instrument for both dogfood arms; a default that produces invisible input taxes every game's verify loop.

Evidence: `s3://groundupcoder/gucos/508-passb-r2/2026-08-13/s2-playtest.log` (the failing injections), s4-patience.log ("wmctl key SID SCANCODE alone sends no keysym → keys ignored"), os/wmctl.c:926-938 at e704f078.
