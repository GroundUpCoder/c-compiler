# 0015 — windowed vendor apps in-OS: doom, snake, gameboy

The WM design's own acceptance test (`todos/WM.md` unit 7): existing vendor
apps run windowed in the OS with **zero source changes**. `doom &` from hush
opens the DOOM Shareware title screen on the desktop; gameboy boots Pokémon
Blue from a seeded ROM; snake plays in the tty. Third landing of the day on
the WM stack (0013 → 0014 → this), and deliberately the smallest: all the
machinery already existed — this item is game data + manifest entries + the
acceptance tests.

## The one real piece: binary-asset seeding (`bin` entries)

`os-common.js`'s image seeder knew `c` / `text` / `project` / `link` — all
text-sourced. Game data (doom1.wad ~4MB, ROMs 1MB each) needed a binary path:

- **`entry.bin`** — a REPO-relative binary file copied verbatim to the image
  path. Repo-relative (like `project`, unlike the os/-relative `c`/`text`)
  because the assets live in `vendor/*/`.
- New io hook **`readBinary(repoPath) -> Uint8Array | Promise<Uint8Array>`**:
  `fs.readFileSync(ROOT, p)` in boot.js; async
  `fetch('../' + p).arrayBuffer()` in kernel-worker.js. No sync-XHR
  contortions needed — unlike `buildProject`'s compiler reads, seeding a blob
  has no synchronous consumer, and `seedImage`'s per-entry chain already
  awaits promises.

`image.json` is **v11**: `/bin/doom`, `/bin/snake`, `/bin/gameboy` built at
seed time from their vendor `bin.json`s via the existing `project` path
(busybox precedent — `buildProject` handled doom's 85 TUs without changes),
`/root/doom1.wad`, and two ROMs under `/root/roms/`. Fresh-seed cost went
4.0s → 5.0s headless (the three app builds); acceptable, no manifest split.

## Decisions

- **WAD at `/root/doom1.wad`, not a search-path patch.** doomgeneric's
  `d_iwad.c` builds its IWAD dir list from `FILES_DIR "."` only — cwd. hush
  starts at `HOME=/root`, so the WAD lands there and `doom` just works from
  the home directory. Running it from elsewhere fails to find the WAD;
  that's vanilla doomgeneric behavior, not ours to fix (zero source changes).
- **DOOM's 1280x800 window on a 1024x768 (headless) / 800x500 (os.html)
  screen overflows by design.** The app chose 640x400×2; the kernel clips.
  Consequence: in the browser the close box sits off-screen right — the
  browser test quits via `wmctl close` (same SDL_EVENT_QUIT delivery; the
  literal close-box click path is os-wm.mjs's job). 0019 (client resize)
  is the eventual answer.
- **Audio stays silently absent until 0017** — both doom (`dg_sound.c`) and
  gameboy NULL-check the failed `SDL_OpenAudioDeviceStream` and carry on.

## Gotchas

- **snake needs TWO `q`s and spins on EOF.** `q` ends the game; a second
  paced `q` dismisses "Press q to exit..." — whose
  `do { read(&c,1); } while (c != 'q')` loop spins forever once the tty
  returns EOF, and `poll_key()` slurps every queued byte (8 at a time), so
  both q's queued together get eaten in one read. Piped `snake` sessions
  must pace input into separate reads (the e2e test uses timer-fed stdin,
  not script `sleep`). Vendor behavior, not a kernel bug — cost an hour of
  "why is the OS hung" before reading the exit loop.
- `spawnSync` needs `maxBuffer` bumped to extract multi-MB PPMs from the
  image (`cat foo.ppm` over byte-clean piped stdout — a nice trick:
  screenshots verified pixel-by-pixel in Node with zero extra transport).

## Tests

- `tests/kernel/test_os_apps_e2e.js` (13 checks, in the suite): bin-entry
  seeding, both windows with right titles/geometry via `wmctl list`,
  `wmctl shot SID` frames parsed and histogram-checked (doom: 200+ distinct
  colors at full 1280x800 — a real render, not a fill), snake played to
  GAME OVER through the kernel tty, exit 0.
- `tests/browser/os-doom.mjs` (manual, like the others): real Chromium —
  composited doom frame on the desktop canvas, Escape reaches the app,
  attract-demo motion (distinct frame signatures — the present loop pumps),
  `wmctl close` quits cleanly, then the same lifecycle for gameboy+ROM.
- All green: unit 697✓ (3 pre-existing skips), kernel 19 files✓, blockfs✓,
  host✓, browser os-boots✓ + os-wm✓ + os-doom✓.

Queue: quake stays split to `todos/0018` (needs relative-mouse/pointer-lock,
plus pak0.pak seeding — now trivial via `bin` entries). Next up: 0016.

## Post-landing fix: `optional` bin entries

First landing bricked boots on other checkouts: the gameboy ROMs are
**gitignored** (`vendor/gameboy/.gitignore` — copyrighted, local-only,
unlike the committed shareware WAD), so a fresh clone's seed died with
`PokemonBlue.gb: HTTP 404` and the OS never came up. A missing *game
asset* must not take down the *boot*.

Fix: `bin` entries take `"optional": true` — a missing asset logs
`SKIPPED (optional; …)` and seeding continues (sync ENOENT and async
fetch-404 land in the same rejection path; required entries still fail
loud, and a failed seed still doesn't stamp `/etc/.image-version`, so the
next boot retries). Both ROM entries are optional; both acceptance tests
adapt — without a local ROM they run `gameboy` bare, which boots its
built-in test ROM (same window, same LCD), and test_os_apps_e2e gains a
direct seedImage unit check of the skip/fail-loud pair so the graceful
path is exercised on every checkout, including ones that have the ROMs.
