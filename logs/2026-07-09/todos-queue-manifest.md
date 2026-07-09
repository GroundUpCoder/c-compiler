# todos: the queue.json ordering manifest + queue.js CLI

2026-07-09 (committed 2026-07-10)

## Why

The netguc/cc Todos tab (and its churn engine's "what's next") derived the order
of attack by regex-scraping this repo's prose `### Next up` list. Our list is
grouped, thematic, and multi-line — exactly what that scraper can't read. The
worst case: entry 1's leading line is "**The Win32 desktop platform** (design:
`WIN32.md`, 2026-07-09 — the ...", so the scraper captured `2026` (the date) as
a ghost id and lost the real Win32 ids (0057–0060, on wrap lines), sinking our
top-priority track to the bottom of the UI. Advisory `Depends:` prose ("best
after the Win32 wave… not blocked by it") also rendered as hard blocks.

Full analysis + design: `netguc/cc/docs/todos-queue-manifest.md`.

## What landed here

- **`todos/queue.json`** — the ordering manifest. Array order *is* the order of
  attack; `blockedBy` = hard deps (gate readiness), `after` = soft "best
  sequenced after" hints (advisory, never block). Seeded from the corrected
  Win32-first intent. This is now authoritative for order + deps; the prose
  *Next up* list is human narrative only.
- **`todos/queue.js`** — zero-dep Node CLI + validator, the single writer of
  `queue.json` (built-ins only, matching `tools/*.js`): `list / add / reorder /
  done / block / check`. Validation (implicit before every write, and the whole
  job of `check`): every open `NNNN-*.md` listed exactly once, no ghost ids, no
  id in both open and done, deps reference real todos, no `blockedBy` cycle.
  `add` scaffolds the file *and* inserts the entry atomically (rolls back the
  scaffold if the result won't validate); `done` git-mvs to `done/` and drops
  the entry.
- **`todos/queue.test.js`** — 13 self-contained cases (temp git repo per case,
  drives the real CLI as a subprocess). `node todos/queue.test.js` → green.
- **Docs**: `todos/README.md` §1 gains "Maintaining the queue"; `CLAUDE.md`
  "TODOs & the work queue" points new work at `queue.js add` and requires
  `node todos/queue.js check` to pass before committing a queue change.

## Dep semantics as seeded (soft vs hard)

Hard `blockedBy`: 0058←0057, 0048←0058/0060, 0042←0041, 0054←0052.
Soft `after`: 0060▸0057/0058, 0059▸0060, 0063▸0062, 0064▸0057/0058, 0049▸0048.
(0049 is soft, not hard — only the control-panel picker rides 0048; the
wallpaper itself is wm.c-only.) `queue.js list` shows the resolved state.

## Contract with cc

cc reads `queue.json` when present+valid, falls back to the prose parser when
absent, and falls back-but-warns when malformed. So this repo and cc can land on
different days with no intermediate regression — which is what happened (cc's
reader + this manifest landed together, but either order is safe).
