# Menu M3 — SameBoy win32 conversion: the "one system, BOTH transports" proof (todos/0260, image v120)

The last menu milestone. gpubox (M2, todos/0258) proved a GPU-presented
client gets a first-class menucore menu; this lands the CPU half: SameBoy's
frontend (`vendor/sameboy/src/main.c`, port glue only) becomes a win32 app
presenting through the NORMAL GDI bitmap transport, and its menu is —
verifiably, probe-for-probe — the same code path. Diff the two apps and the
delta is confined to the client present, exactly the §4.b claim of the
canonical design note.

## The conversion (Option A, §4.b)

- **Window**: `RegisterClass` + `CreateWindowEx` (fixed-size — no
  `WS_THICKFRAME`, like doom/quake; scaling stays the SET_DST path) with
  `AdjustWindowRect` reserving the bar strip: 480×462 outer, 480×432 client.
  **NOT CS_OWNCLIENT** — that seam (M2) is for apps presenting outside GDI;
  SameBoy is the vanilla case user32 owns end to end, which is the point.
- **Present**: `rgb_encode` fills `fb[]` verbatim (UNTOUCHED — the directive);
  the frame present swizzles into a DIB staging buffer (a 32bpp DIB word is
  `0xRRGGBB`; fb is SDL RGBA byte order), `SetDIBits` into one 160×144
  bitmap in a memory DC, `StretchBlt` ×3 into the client via
  `GetDC`/`ReleaseDC` (ReleaseDC is the shm mailbox flip). The e2e pins the
  round-trip bit-exactly: a DMG frame contains ONLY the four
  `GB_PALETTE_GREY` bytes, and after the palette menu action ONLY the five
  `GB_PALETTE_DMG` bytes.
- **Pump**: the `__setAnimationFrameFunc` callback runs PeekMessage/
  TranslateMessage/DispatchMessage, then the UNCHANGED `GB_run_frame`
  catch-up cadence. Menu tracking, WM_TIMERs, key input and the agent
  socket all ride the pump — same shape as gpubox's frame().
- **Input**: `WM_KEYDOWN/UP` → `GB_set_key_state` (arrows/Z/X/Enter/Shift;
  either shift is Select — user32 maps both SDL shifts to VK_SHIFT).
- **Audio**: unchanged SDL stream path; `SDL_Init` is additive
  (user32 owns VIDEO init, `SDL_INIT_AUDIO` ORs in), and
  `SDL_OpenAudioDeviceStream` goes straight to the host device anyway.
- **Menu**: File ▸ Open ROM…/Quit; Emulation ▸ Pause/Reset + Auto/DMG/CGB
  model radios (`GB_switch_model_and_reset` with the live cart); Options ▸
  Palette ▸ Greyscale/DMG Green/MGB/GB Light (`GB_set_palette`, a NESTED
  cascade — the engine chain over a live emulator) + Mute. Save states are
  deliberately absent: `core/save_state.c` is not in this build's sources
  (todos/0086 owns that), and offering the items would be a lie.
- **Open ROM…**: real comdlg32 `GetOpenFileNameW`. The modal pumps inside
  the WM_COMMAND dispatch inside the frame callback — the frame loop is
  blocked while it's up, so the emulator naturally pauses (the modal
  contract), and GetMessage's kernel WAIT{agent ⊕ ring ⊕ timer} keeps the
  dialog fully agent-drivable from that depth (settext EDIT:1 + click Open;
  proven in the e2e). Accept → battery-save the outgoing game,
  `GB_load_rom_from_buffer` + `GB_switch_model_and_reset` on the live gb,
  `.sav` path swaps, `GB_load_battery` for the incoming one.

`vendor/sameboy/bin.json` gains `deps: os/win32/lib.json`. The GB core is
untouched (no new patches; the patch table stands). compiler.js untouched —
no codegen, no SameBoy-codegen interlock.

## Red→green

`test_sameboy_e2e.js` (rewritten, keeps the 0075 legs): RED on the
unconverted tree — `wmctl wait win menubar` times out (driveBoot fails loud
per the 0171 rule), since the plain-SDL sameboy has no bar child. Green
after: menubar anchored at the window origin at 480×30, bar click →
"#32768" popup child at `y = win.y + MENU_BAR_H`, ESC closes,
Emulation▸Pause freezes (time-separated client shots BYTE-IDENTICAL, then
unpause), Options▸Palette▸DMG Green fired with the menu closed (A12
menu_locate at depth 2) recolors the next frames to the exact
`GB_PALETTE_DMG` bytes, Open ROM… loads a junk-but-valid 64K cart through
the real modal, menu Quit exits cleanly. The §3.4 composite probe —
COLOR_MENU at the bar's right end and in the popup gutter of the headless
screen shot — is the same assertion the gpubox test makes over a GPU
client; here it sits over live shm pixels. New `os-sameboy.mjs` browser
leg: checkerboard animates in exact grey shades through the compositor, the
popup composites over the live client, Pause visibly freezes, DMG Green
visibly recolors, Quit restores the desktop.

## The flake-gate catch (and the fix's shape)

First `--repeat 3 --under-load` run: 0/3 — the inherited `sleep 3` before
the first shot lost its bet under contention (`dmg_boot`'s logo has only 2
grey shades; the checkerboard hadn't started). That sleep was a latent
flake in the ORIGINAL 0075 test; the new exact->=3-shades assertion merely
exposed it. There is no in-OS marker for "the ROM reached its render loop"
(ROM-side progress is invisible to the frontend), so per the 0171
discipline this stays a genuine no-marker settle — but spread as a SHOT
SERIES (8 shots, 1.5s apart; 3 for the palette swap) whose checker scans
for the first qualifying frame instead of betting one fixed instant.
After: kernel e2e 3/3 and os-sameboy.mjs 3/3 stable under load ×10.

## Gate

Image v120 (sealed, 19.7 MiB). projects 26/26, kernel 84/84, browser sweep
28/28 (os-sameboy new). compiler.js, menucore.c, kernel.js, user32.c all
untouched — this milestone is pure app-side consumption of the facility,
which is itself the proof the campaign aimed at: the Nth menued app is now
~40 lines of HMENU calls, transport irrelevant. Menu build complete.
