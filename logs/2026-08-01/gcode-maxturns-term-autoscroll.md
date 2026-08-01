# #353 gcode unlimited-by-default max-turns + #354 term autoscroll key

Two small jku-requested items, one lane (branch `0353-0354-gcode-term`).

## #353 — gcode: the 24-action turn cap becomes opt-in

`cfg.max_turns` defaults to 0 = unlimited; the loop condition is now
`cfg->max_turns <= 0 || round < cfg->max_turns`, and `--max-turns N` is
unchanged as the opt-in cap (the `max_turns` stop reason stays reachable).
Accepted risk, recorded in the ticket: a stuck tool loop burns tokens until
^C — jku's call for his own interactive tool; no shadow cap re-added.

Controls (all against the scripted `fake_anthropic.js`, 30 tool rounds +
final text): the BEFORE arm (origin/main build) stopped at exactly 24 with
`hit max-turns (24)`; the AFTER arm ran all 31 API rounds and exited 0 with
no cap message; the NEGATIVE arm (`--max-turns 3`) stopped at exactly 3.
A live DeepSeek smoke ran through the repointed `~/.local/bin/gcode`.

The `~/.local/bin/gcode` symlink had dangled since the `os/code → os/gcode`
rename (created 17:50, rename committed 18:46, same day): it now points at
`~/git/c-compiler/os/gcode/gcode`, the build-native.sh output next to the
source (the old convention), and that artifact path is gitignored.

## #354 — term: `autoscroll` config key, and the content anchor it exposed

The key itself is the planned ~15 lines: `TermCfg.autoscroll` (default 1),
tc_enum parse (`on|off`, `0/1` accepted — the ticket's acceptance spells the
numeric form), `cfg_apply` carries it so the 0273d cfgwatch live reload
flips it without a restart, the drain-loop snap gains the gate, and the
key-list doc comment + the baked `/usr/share/term` (image.json) list it —
the defaults-equal-baked-file invariant.

**The naive gate fails its own acceptance.** First green run: with
`autoscroll off` and the view scrolled up, new output still moved the
viewport — row0 ink 2112 → 191. Not a snap: `view_off` is a distance from
LIVE, so each line entering history slides the content under a stationary
offset (~3 lines per trigger: the echo + prompt). The same slide existed
pre-#354 under a held scrollbar thumb. Fix: `hist_push` bumps `view_off`
(clamped at the ring top) whenever the view is scrolled up — the viewport
tracks the LINE it shows. Keypress snap and CM_BOTTOM stay unconditional.

Test: `test_term_e2e.js` session AS — one boot, four arms (absent key,
live-edit off, live-edit `1`, thumb-held), output produced by
file-triggered foreground loops in the term so no shot races a timer, and
the two "view must not move" arms carry done-files proving the output
really arrived. RED control (origin/main term.c, same test): P2 + P4 fail.

## Estate + the flake it caught

Gate record: one dispatcher run, kernel 144/144 + blockfs 15/15 + sweep
44/44, gate-check 56 ok / 0 FAIL. An earlier run failed `os-boots.mjs`'s
vi leg; paired `--repeat 10` measurement (worktree 11/13 vs origin/main
12/13) shows it PRE-EXISTING at ~10% — the `waitOut('VI-CAT-OK')` needle
is satisfied by the typed command's own echo (the split-needle rule's
exact target). Filed as #356 (P0), not fixed here.

Worktree gotcha re-learned: the sweep needs the SECOND node_modules
symlink (`tests/browser/node_modules`) — with only the root one,
playwright resolves 1.61.1 against the 1.61.0 pin and all 44 files fail
at launch.
